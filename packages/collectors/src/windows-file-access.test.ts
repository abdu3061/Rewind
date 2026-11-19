import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ProtectedFolder } from "@rewind/contracts";
import { WindowsProtectedFileAccess } from "./windows-file-access";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../storage/src/secure-fixtures.test-support";

const roots: string[] = [],
  accessors: WindowsProtectedFileAccess[] = [];
afterEach(async () => {
  for (const access of accessors.splice(0)) await access.close();
  for (const root of roots.splice(0)) removeSecureFixture(root);
});
function fixture() {
  const root = newSecureFixture();
  roots.push(root);
  const access = new WindowsProtectedFileAccess();
  accessors.push(access);
  return { root, access };
}
async function selected(
  root: string,
  access: WindowsProtectedFileAccess,
): Promise<ProtectedFolder> {
  const proof = await access.validateFolder(root);
  expect(proof.ok).toBe(true);
  if (!proof.ok) throw new Error("Synthetic folder proof unavailable");
  return {
    ...proof.value,
    id: randomUUID(),
    selectedAt: new Date().toISOString(),
  };
}
it.runIf(process.platform === "win32")(
  "watches a large existing folder without importing it and coalesces actual file saves",
  async () => {
    const f = fixture();
    for (let index = 0; index < 2500; index++)
      writeFileSync(
        join(f.root, `existing-${index}.txt`),
        "synthetic untouched file",
      );
    const folder = await selected(f.root, f.access);
    expect((await f.access.watch(folder)).ok).toBe(true);
    expect(await f.access.changes(folder)).toEqual({
      ok: true,
      value: { paths: [], stamps: [], overflow: false },
    });
    writeFileSync(join(f.root, "active.txt"), "synthetic first save");
    writeFileSync(join(f.root, "active.txt"), "synthetic final save");
    await vi.waitFor(
      async () => {
        const changes = await f.access.changes(folder);
        expect(changes.ok && changes.value.paths).toEqual(["active.txt"]);
      },
      { timeout: 5000, interval: 100 },
    );
    const read = await f.access.read(folder, "active.txt");
    expect(read.ok && Buffer.from(read.value.bytes).toString()).toBe(
      "synthetic final save",
    );
    expect(
      (await f.access.changes({ ...folder, osIdentity: "synthetic:changed" }))
        .ok,
    ).toBe(false);
    expect((await f.access.close()).ok).toBe(true);
    expect((await f.access.changes(folder)).ok).toBe(false);
  },
  15000,
);
it.runIf(process.platform === "win32")(
  "continues a large root in bounded pages and still rejects changed root authority",
  async () => {
    const f = fixture(),
      folder = await selected(f.root, f.access);
    for (let index = 0; index < 2105; index++)
      writeFileSync(
        join(f.root, `synthetic-${index}.txt`),
        "synthetic page fixture",
      );
    const names = new Set<string>();
    let continuing = true,
      pages = 0;
    while (continuing && pages++ < 100) {
      const page = await f.access.list(folder);
      expect(page.ok).toBe(true);
      if (!page.ok) throw new Error("Synthetic scan failed");
      expect(page.value.overflow).toBe(false);
      expect(page.value.paths.length).toBeLessThanOrEqual(2000);
      expect(page.value.stamps).toHaveLength(page.value.paths.length);
      for (const name of page.value.paths) names.add(name);
      continuing = page.value.continuation === true;
      if (pages === 1) {
        expect(continuing).toBe(true);
        expect(
          (await f.access.list({ ...folder, osIdentity: "synthetic:changed" }))
            .ok,
        ).toBe(false);
      }
    }
    expect(continuing).toBe(false);
    expect(pages).toBeGreaterThan(1);
    expect(names.size).toBe(2105);
    expect(
      (await f.access.list({ ...folder, osIdentity: "synthetic:changed" })).ok,
    ).toBe(false);
  },
  30000,
);
it.runIf(process.platform === "win32")(
  "skips an unsupported long entry without losing its supported neighbor",
  async () => {
    const f = fixture(),
      folder = await selected(f.root, f.access);
    const directory = join(f.root, "x".repeat(190 - f.root.length));
    mkdirSync(directory);
    writeFileSync(
      join(directory, "y".repeat(50) + ".txt"),
      "synthetic overlong fixture",
    );
    writeFileSync(join(f.root, "supported.txt"), "synthetic supported fixture");
    const names: string[] = [];
    let skipped = 0,
      continuing = true;
    for (let index = 0; continuing && index < 100; index++) {
      const page = await f.access.list(folder);
      expect(page.ok).toBe(true);
      if (!page.ok) throw new Error("Synthetic scan failed");
      names.push(...page.value.paths);
      skipped += page.value.skipped ?? 0;
      continuing = page.value.continuation === true;
      expect(page.value.overflow).toBe(false);
    }
    expect(continuing).toBe(false);
    expect(names).toEqual(["supported.txt"]);
    expect(skipped).toBe(1);
  },
  15000,
);
it.runIf(process.platform === "win32")(
  "inspects bounded immediate setup entries without recursion or skipped dot names and rechecks root identity",
  async () => {
    const f = fixture(),
      folder = await selected(f.root, f.access);
    mkdirSync(join(f.root, "nested"));
    writeFileSync(
      join(f.root, "nested", "synthetic.txt"),
      "synthetic nested fixture",
    );
    writeFileSync(join(f.root, ".private-fixture"), "synthetic dot fixture");
    expect(await f.access.directoryEntries(folder)).toEqual({
      ok: true,
      value: [".private-fixture", "nested"],
    });
    expect(
      (
        await f.access.directoryEntries({
          ...folder,
          osIdentity: "synthetic-wrong-identity",
        })
      ).ok,
    ).toBe(false);
    for (let index = 0; index < 63; index++)
      writeFileSync(join(f.root, `bounded-${index}.txt`), "synthetic fixture");
    expect((await f.access.directoryEntries(folder)).ok).toBe(false);
  },
  15000,
);
it.runIf(process.platform === "win32")(
  "reads the complete maximum-size version and cancels an in-flight read on close",
  async () => {
    const f = fixture();
    const folder = await selected(f.root, f.access);
    const bytes = Buffer.alloc(16 * 1024 ** 2, 37);
    writeFileSync(join(f.root, "maximum.pdf"), bytes);
    const result = await f.access.read(folder, "maximum.pdf");
    expect(result.ok).toBe(true);
    expect(result.ok && Buffer.from(result.value.bytes).equals(bytes)).toBe(
      true,
    );
    const pending = f.access.read(folder, "maximum.pdf");
    await Promise.resolve();
    expect((await f.access.close()).ok).toBe(true);
    expect((await pending).ok).toBe(false);
  },
  20000,
);
it.runIf(process.platform === "win32")(
  "reads original bytes and stable Windows identities only from the selected root",
  async () => {
    const f = fixture();
    const folder = await selected(f.root, f.access);
    const bytes = Buffer.from([0, 255, 127, 10, 13, 0, 42]);
    mkdirSync(join(f.root, "nested"));
    writeFileSync(join(f.root, "nested", "synthetic.pdf"), bytes);
    const listing = await f.access.list(folder);
    expect(listing).toEqual({
      ok: true,
      value: {
        paths: ["nested\\synthetic.pdf"],
        stamps: [expect.any(String)],
        overflow: false,
      },
    });
    const first = await f.access.read(folder, "nested\\synthetic.pdf");
    expect(first.ok && Buffer.from(first.value.bytes)).toEqual(bytes);
    const second = await f.access.read(folder, "nested\\synthetic.pdf");
    expect(first.ok && first.value.osIdentity).toEqual(
      second.ok && second.value.osIdentity,
    );
    expect((await f.access.read(folder, "..\\elsewhere.txt")).ok).toBe(false);
    expect(
      (await f.access.read(folder, join(f.root, "nested", "synthetic.pdf"))).ok,
    ).toBe(false);
    expect((await f.access.close()).ok).toBe(true);
    expect((await f.access.read(folder, "nested\\synthetic.pdf")).ok).toBe(
      false,
    );
  },
  15000,
);
it.runIf(process.platform === "win32")(
  "rejects open writers, hardlinks, oversized files and reparse-point paths",
  async () => {
    const f = fixture();
    const folder = await selected(f.root, f.access);
    const target = join(f.root, "synthetic.txt");
    writeFileSync(target, "synthetic original");
    const writer = openSync(target, "r+");
    try {
      expect((await f.access.read(folder, "synthetic.txt")).ok).toBe(false);
    } finally {
      closeSync(writer);
    }
    expect((await f.access.read(folder, "synthetic.txt")).ok).toBe(true);
    linkSync(target, join(f.root, "hardlink.txt"));
    expect((await f.access.read(folder, "hardlink.txt")).ok).toBe(false);
    const outside = newSecureFixture();
    roots.push(outside);
    writeFileSync(join(outside, "outside.txt"), "Synthetic outside root");
    symlinkSync(outside, join(f.root, "junction"), "junction");
    expect((await f.access.read(folder, "junction\\outside.txt")).ok).toBe(
      false,
    );
    expect((await f.access.validateFolder(join(f.root, "junction"))).ok).toBe(
      false,
    );
    writeFileSync(join(f.root, "large.txt"), "");
    truncateSync(join(f.root, "large.txt"), 16 * 1024 ** 2 + 1);
    expect((await f.access.read(folder, "large.txt")).ok).toBe(false);
    const listing = await f.access.list(folder);
    expect(listing.ok && listing.value.paths).not.toContain(
      "junction\\outside.txt",
    );
  },
  15000,
);
it.runIf(process.platform === "win32")(
  "rejects a selected directory replaced after authorization and skips hidden build trees",
  async () => {
    const f = fixture();
    const nested = join(f.root, "protected");
    mkdirSync(nested);
    const folder = await selected(nested, f.access);
    for (const name of [".git", "node_modules", "dist"]) {
      mkdirSync(join(nested, name));
      writeFileSync(join(nested, name, "skip.txt"), "Synthetic ignored");
    }
    writeFileSync(join(nested, "captured.txt"), "Synthetic included");
    expect(await f.access.list(folder)).toEqual({
      ok: true,
      value: {
        paths: ["captured.txt"],
        stamps: [expect.any(String)],
        overflow: false,
      },
    });
    renameSync(nested, join(f.root, "previous"));
    mkdirSync(nested);
    writeFileSync(join(nested, "captured.txt"), "Synthetic replacement");
    expect((await f.access.read(folder, "captured.txt")).ok).toBe(false);
    expect((await f.access.list(folder)).ok).toBe(false);
  },
  15000,
);
