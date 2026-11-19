import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  fileTextControlResponseSchema,
  fileTextSearchResponseSchema,
  type DocumentProcessor,
  type DocumentText,
  type WorkerCommand,
} from "@rewind/contracts";
import { extractDocumentText } from "@rewind/documents";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";
import {
  docxEntries,
  pdfFixture,
  zipFixture,
} from "../../../../packages/documents/src/fixtures.test-support";
import { WorkerRuntime } from "./worker-runtime";

const cleanups: (() => Promise<void>)[] = [];
beforeAll(() => vi.stubEnv("DISABLE_SYSTEM_FONTS_LOAD", "1"));
afterAll(() => vi.unstubAllEnvs());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const needle = "NativeCapturedBody42791";
function fixture(allFormats = true) {
  const profile = newSecureFixture(),
    root = join(profile, "secure"),
    folder = join(profile, "protected"),
    key = randomBytes(32);
  mkdirSync(folder);
  writeFileSync(
    join(folder, "ordinary.pdf"),
    pdfFixture([`Synthetic ${needle} <script>literal markup</script>`]),
  );
  if (allFormats) {
    writeFileSync(
      join(folder, "ordinary.txt"),
      `Synthetic ${needle} <img src=x>`,
    );
    writeFileSync(
      join(folder, "ordinary.docx"),
      zipFixture(
        docxEntries(`<w:p><w:r><w:t>Synthetic ${needle}</w:t></w:r></w:p>`),
      ),
    );
  }
  const extract = vi.fn<DocumentProcessor["extract"]>(extractDocumentText),
    stop = vi.fn<DocumentProcessor["stop"]>(async () => true);
  const documents: DocumentProcessor = { busy: false, extract, stop };
  const runtimes: WorkerRuntime[] = [];
  const open = () => {
    const runtime = new WorkerRuntime({
      root,
      key: Buffer.from(key),
      synthetic: true,
      documentProcessor: documents,
      onSnapshot: vi.fn(),
      onActivity: vi.fn(),
    });
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = open();
  cleanups.push(async () => {
    for (const instance of runtimes) await instance.shutdown();
    key.fill(0);
    removeSecureFixture(profile);
  });
  const state = async (instance = runtime) =>
    fileTextControlResponseSchema.parse(
      await instance.execute({ kind: "content.state" }),
    );
  const search = async (instance = runtime) =>
    fileTextSearchResponseSchema.parse(
      await instance.execute({
        kind: "content.search",
        query: { text: needle, limit: 25 },
      }),
    );
  const start = async () => {
    expect((await runtime.initialize()).ok).toBe(true);
    expect(
      (await runtime.execute({ kind: "files.add", path: folder })).ok,
    ).toBe(true);
    expect(
      (await runtime.execute({ kind: "files.permission", enabled: true })).ok,
    ).toBe(true);
    expect(
      (await runtime.execute({ kind: "session", action: "start" })).ok,
    ).toBe(true);
  };
  return { runtime, open, folder, state, search, start, extract, stop };
}
const wait = async (work: () => Promise<void>) =>
  vi.waitFor(work, { timeout: 15000 });

it("ordinary worker indexes actual captured UTF-8/DOCX/PDF bodies after file approval and searches encrypted history across restart", async () => {
  const f = fixture();
  expect((await f.runtime.initialize()).ok).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "files.add", path: f.folder })).ok,
  ).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "session", action: "start" })).ok,
  ).toBe(true);
  expect(await f.state()).toMatchObject({
    ok: true,
    value: { counts: { eligible: 0, indexed: 0 } },
  });
  expect(f.extract).not.toHaveBeenCalled();
  expect(
    (await f.runtime.execute({ kind: "files.permission", enabled: true })).ok,
  ).toBe(true);
  expect(f.runtime.snapshot().session?.status).toBe("paused");
  expect(
    (await f.runtime.execute({ kind: "session", action: "resume" })).ok,
  ).toBe(true);
  await wait(async () => {
    expect(await f.state()).toMatchObject({
      ok: true,
      value: {
        counts: { eligible: 3, indexed: 3, pending: 0 },
        indexing: { busy: false },
      },
    });
  });
  const result = await f.search();
  expect(result).toMatchObject({
    ok: true,
    value: {
      hasMore: false,
      hits: [expect.anything(), expect.anything(), expect.anything()],
    },
  });
  if (!result.ok) throw new Error("SYNTHETIC_SEARCH_FAILED");
  expect(new Set(result.value.hits.map((hit) => hit.format))).toEqual(
    new Set(["utf8", "docx", "pdf"]),
  );
  expect(result.value.hits.every((hit) => hit.snippet.includes(needle))).toBe(
    true,
  );
  expect(result.value.authority).toEqual(
    f.runtime.snapshot().documentAuthority,
  );
  expect((await f.runtime.shutdown()).ok).toBe(true);
  const restarted = f.open();
  expect((await restarted.initialize()).ok).toBe(true);
  expect(restarted.snapshot().filePermission).toBe(false);
  expect(restarted.snapshot().session?.status).toBe("ended");
  expect(await f.state(restarted)).toMatchObject({
    ok: true,
    value: { counts: { indexed: 3 } },
  });
  const reopened = await f.search(restarted);
  expect(reopened.ok && reopened.value.hits.length).toBe(3);
  expect(reopened.ok && reopened.value.authority.generation).not.toBe(
    result.value.authority.generation,
  );
}, 20000);

it("Stop pauses automatic indexing for this launch and explicit saved-history indexing works while capture is paused", async () => {
  const f = fixture();
  expect((await f.runtime.initialize()).ok).toBe(true);
  expect(await f.runtime.execute({ kind: "content.stop" })).toMatchObject({
    ok: true,
    value: { automaticPaused: true },
  });
  expect(
    (await f.runtime.execute({ kind: "files.add", path: f.folder })).ok,
  ).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "files.permission", enabled: true })).ok,
  ).toBe(true);
  expect(
    (await f.runtime.execute({ kind: "session", action: "start" })).ok,
  ).toBe(true);
  await wait(async () => {
    expect(await f.state()).toMatchObject({
      ok: true,
      value: { counts: { eligible: 3, indexed: 0, pending: 3 } },
    });
  });
  expect(
    (await f.runtime.execute({ kind: "session", action: "pause" })).ok,
  ).toBe(true);
  expect(
    await f.runtime.execute({
      kind: "content.index",
      value: { confirmed: false, retryFailures: false },
    } as unknown as WorkerCommand),
  ).toMatchObject({ ok: false, error: { code: "INVALID_INPUT" } });
  expect(
    (
      await f.runtime.execute({
        kind: "content.index",
        value: { confirmed: true, retryFailures: false },
      })
    ).ok,
  ).toBe(true);
  await wait(async () => {
    expect(await f.state()).toMatchObject({
      ok: true,
      value: {
        automaticPaused: false,
        counts: { indexed: 3 },
        indexing: { busy: false },
      },
    });
  });
  expect(f.runtime.snapshot().session?.status).toBe("paused");
  expect((await f.search()).ok).toBe(true);
});

it("retains unavailable extraction across ordinary runs and retries only after explicit saved-history retry", async () => {
  const f = fixture(false);
  f.extract.mockResolvedValueOnce({
    state: "unavailable",
    format: "pdf",
    reason: "timeout",
  });
  await f.start();
  await wait(async () => {
    expect(await f.state()).toMatchObject({
      ok: true,
      value: {
        counts: { eligible: 1, unavailable: 1, pending: 0 },
        indexing: { busy: false },
      },
    });
  });
  expect(
    (await f.runtime.execute({ kind: "session", action: "pause" })).ok,
  ).toBe(true);
  expect(
    (
      await f.runtime.execute({
        kind: "content.index",
        value: { confirmed: true, retryFailures: false },
      })
    ).ok,
  ).toBe(true);
  await wait(async () => {
    expect(await f.state()).toMatchObject({
      ok: true,
      value: { counts: { unavailable: 1 }, indexing: { busy: false } },
    });
  });
  expect(f.extract).toHaveBeenCalledTimes(1);
  expect(
    (
      await f.runtime.execute({
        kind: "content.index",
        value: { confirmed: true, retryFailures: true },
      })
    ).ok,
  ).toBe(true);
  await wait(async () => {
    expect(await f.state()).toMatchObject({
      ok: true,
      value: {
        counts: { indexed: 1, unavailable: 0 },
        indexing: { busy: false },
      },
    });
  });
  expect(f.extract).toHaveBeenCalledTimes(2);
});

it("history deletion drains the owning parser and rejects delayed index publication without waiting on its outside-queue result", async () => {
  const f = fixture(false);
  let release!: (value: DocumentText) => void;
  const parsed = new Promise<DocumentText>((resolve) => {
    release = resolve;
  });
  f.extract.mockReturnValueOnce(parsed);
  try {
    await f.start();
    await wait(async () => {
      expect(f.extract).toHaveBeenCalledTimes(1);
    });
    const old = f.runtime.snapshot().documentAuthority;
    expect(await f.state()).toMatchObject({
      ok: true,
      value: { indexing: { busy: true } },
    });
    expect(
      (
        await f.runtime.execute({
          kind: "storage.delete",
          value: { confirmed: true, includeKept: false },
        })
      ).ok,
    ).toBe(true);
    expect(f.runtime.snapshot().documentAuthority.revision).toBeGreaterThan(
      old.revision,
    );
    expect(f.stop).toHaveBeenCalledWith(f.extract.mock.calls[0]![2]);
    release({
      state: "available",
      format: "pdf",
      text: `Late ${needle}`,
      truncated: false,
      pagesRead: 1,
      totalPages: 1,
    });
    await wait(async () => {
      expect(await f.state()).toMatchObject({
        ok: true,
        value: {
          counts: { eligible: 0, indexed: 0 },
          indexing: { busy: false },
        },
      });
    });
    expect(await f.search()).toMatchObject({
      ok: true,
      value: { hits: [], hasMore: false },
    });
    expect(f.runtime.snapshot().service).toBe("ready");
  } finally {
    release({ state: "unavailable", format: "pdf", reason: "cancelled" });
  }
});
