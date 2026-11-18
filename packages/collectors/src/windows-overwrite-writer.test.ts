import { createHash } from "node:crypto";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { WindowsProtectedFileAccess } from "./windows-file-access";
import { WindowsRecoveryOverwriteWriter } from "./windows-overwrite-writer";
import { windowsOverwriteScript } from "./windows-overwrite-script";
import { nativeOverwriteReplySchema } from "@rewind/contracts";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../storage/src/secure-fixtures.test-support";

const roots: string[] = [];
const writers: WindowsRecoveryOverwriteWriter[] = [];
afterEach(async () => {
  for (const writer of writers.splice(0))
    expect((await writer.close()).ok).toBe(true);
  for (const root of roots.splice(0)) removeSecureFixture(root);
});
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
async function fixture(bytes = Buffer.from("Current synthetic bytes")) {
  const root = newSecureFixture();
  roots.push(root);
  const access = new WindowsProtectedFileAccess();
  const proof = await access.validateFolder(root);
  expect((await access.close()).ok).toBe(true);
  if (!proof.ok) throw new Error("SYNTHETIC_PARENT_UNAVAILABLE");
  const name = "selected.txt",
    selected = join(root, name);
  writeFileSync(selected, bytes);
  const writer = new WindowsRecoveryOverwriteWriter();
  writers.push(writer);
  const evidence = await writer.inspect(proof.value, name);
  if (!evidence.ok) throw new Error("SYNTHETIC_TARGET_UNAVAILABLE");
  return {
    root,
    selected,
    writer,
    current: bytes,
    target: { directory: proof.value, name, evidence: evidence.value },
  };
}
const windows = it.runIf(process.platform === "win32");
for (const rollbackFails of [false, true])
  windows(
    `retains the verified preservation copy when an injected native write fails${rollbackFails ? " and rollback also fails" : " and restores the original through its held handle"}`,
    async () => {
      const f = await fixture(),
        source = Buffer.from("Earlier synthetic recovered version");
      const marker =
        "target.Write(source,0,source.Length);target.SetLength(source.Length);";
      expect(windowsOverwriteScript.split(marker)).toHaveLength(2);
      let script = windowsOverwriteScript.replace(
        marker,
        'target.Write(source,0,Math.Min(source.Length,2));if(source.Length>0)throw new IOException("SYNTHETIC_IO_FAILURE");target.SetLength(source.Length);',
      );
      if (rollbackFails) {
        const restore =
          "target.Position=0;target.Write(current,0,current.Length);";
        expect(script.split(restore)).toHaveLength(2);
        script = script.replace(
          restore,
          'if(current.Length>0)throw new IOException("SYNTHETIC_ROLLBACK_FAILURE");target.Position=0;target.Write(current,0,current.Length);',
        );
      }
      const bootstrap = String.raw`
$ProgressPreference='SilentlyContinue'
[Console]::InputEncoding=New-Object Text.UTF8Encoding $false
$source=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
& ([ScriptBlock]::Create($source))
`;
      const command = {
        kind: "overwrite",
        path: f.target.directory.absolutePath,
        identity: f.target.directory.osIdentity,
        name: f.target.name,
        expectedIdentity: f.target.evidence.osIdentity,
        expectedHash: f.target.evidence.contentHash,
        expectedSize: f.target.evidence.byteLength,
        expectedWritten: f.target.evidence.lastWriteToken,
        backupName: "preserved.txt",
        base64: source.toString("base64"),
        hash: digest(source),
      };
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(bootstrap, "utf16le").toString("base64"),
        ],
        {
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 65536,
          encoding: "utf8",
          input:
            Buffer.from(script, "utf8").toString("base64") +
            "\n" +
            JSON.stringify(command) +
            "\n",
        },
      );
      const packet = JSON.parse(output.trim()) as {
        ok: boolean;
        value: unknown;
      };
      expect(packet.ok).toBe(true);
      expect(nativeOverwriteReplySchema.parse(packet.value)).toMatchObject({
        status: "failed",
        targetTouched: true,
        originalRestored: !rollbackFails,
        preserved: {
          contentHash: digest(f.current),
          byteLength: f.current.length,
        },
      });
      expect(readFileSync(join(f.root, "preserved.txt"))).toEqual(f.current);
      if (!rollbackFails) expect(readFileSync(f.selected)).toEqual(f.current);
    },
    20000,
  );
windows(
  "preserves and verifies current binary bytes before replacing through the same target identity",
  async () => {
    const f = await fixture(Buffer.from([0, 255, 12, 13, 91])),
      source = Buffer.from("Recovered synthetic version");
    const result = await f.writer.overwrite(
      f.target,
      "preserved.bin",
      source,
      digest(source),
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        target: {
          osIdentity: f.target.evidence.osIdentity,
          contentHash: digest(source),
          byteLength: source.length,
        },
        preserved: {
          contentHash: digest(f.current),
          byteLength: f.current.length,
        },
      },
    });
    expect(readFileSync(f.selected).equals(source)).toBe(true);
    expect(readFileSync(join(f.root, "preserved.bin")).equals(f.current)).toBe(
      true,
    );
  },
  20000,
);
windows(
  "rejects invalid source and existing preservation filename without changing either existing file",
  async () => {
    const f = await fixture(),
      source = Buffer.from("Earlier synthetic version"),
      backup = join(f.root, "preserved.txt");
    expect(
      (
        await f.writer.overwrite(
          f.target,
          "preserved.txt",
          source,
          "a".repeat(64),
        )
      ).ok,
    ).toBe(false);
    expect(existsSync(backup)).toBe(false);
    expect(readFileSync(f.selected)).toEqual(f.current);
    writeFileSync(backup, "Existing synthetic preservation filename");
    expect(
      await f.writer.overwrite(
        f.target,
        "preserved.txt",
        source,
        digest(source),
      ),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(readFileSync(f.selected)).toEqual(f.current);
    expect(readFileSync(backup, "utf8")).toBe(
      "Existing synthetic preservation filename",
    );
  },
  20000,
);
windows(
  "detects changed content, write time and replaced file identity between review and confirmation",
  async () => {
    const f = await fixture(),
      source = Buffer.from("Earlier synthetic version");
    writeFileSync(f.selected, "Intervening synthetic save");
    expect(
      await f.writer.overwrite(
        f.target,
        "preserved.txt",
        source,
        digest(source),
      ),
    ).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(readFileSync(f.selected, "utf8")).toBe("Intervening synthetic save");
    writeFileSync(f.selected, f.current);
    utimesSync(f.selected, new Date(), new Date("2020-01-01T00:00:00Z"));
    expect(
      (
        await f.writer.overwrite(
          f.target,
          "preserved.txt",
          source,
          digest(source),
        )
      ).ok,
    ).toBe(false);
    renameSync(f.selected, join(f.root, "original.txt"));
    writeFileSync(f.selected, f.current);
    expect(
      (
        await f.writer.overwrite(
          f.target,
          "preserved.txt",
          source,
          digest(source),
        )
      ).ok,
    ).toBe(false);
    expect(readFileSync(f.selected)).toEqual(f.current);
    expect(existsSync(join(f.root, "preserved.txt"))).toBe(false);
  },
  20000,
);
windows(
  "rejects hard links, redirected parents and traversal without touching their files",
  async () => {
    const f = await fixture(),
      source = Buffer.from("Earlier synthetic version");
    linkSync(f.selected, join(f.root, "linked.txt"));
    expect(
      (
        await f.writer.overwrite(
          f.target,
          "preserved.txt",
          source,
          digest(source),
        )
      ).ok,
    ).toBe(false);
    expect(
      (await f.writer.inspect(f.target.directory, "selected.txt")).ok,
    ).toBe(false);
    const replacement = join(f.root, "replacement");
    mkdirSync(replacement);
    writeFileSync(join(replacement, "selected.txt"), f.current);
    symlinkSync(replacement, join(f.root, "junction"), "junction");
    expect(
      (
        await f.writer.overwrite(
          {
            ...f.target,
            directory: {
              ...f.target.directory,
              absolutePath: join(f.root, "junction"),
            },
          },
          "preserved.txt",
          source,
          digest(source),
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await f.writer.overwrite(
          f.target,
          "..\\elsewhere.txt",
          source,
          digest(source),
        )
      ).ok,
    ).toBe(false);
    expect(readFileSync(f.selected)).toEqual(f.current);
    expect(readFileSync(join(replacement, "selected.txt"))).toEqual(f.current);
  },
  20000,
);
windows(
  "writes and preserves complete maximum-sized and empty files",
  async () => {
    const f = await fixture(Buffer.alloc(16 * 1024 ** 2, 71)),
      source = Buffer.alloc(16 * 1024 ** 2, 53);
    expect(
      (
        await f.writer.overwrite(
          f.target,
          "preserved.bin",
          source,
          digest(source),
        )
      ).ok,
    ).toBe(true);
    expect(readFileSync(f.selected).equals(source)).toBe(true);
    expect(readFileSync(join(f.root, "preserved.bin")).equals(f.current)).toBe(
      true,
    );
    const inspected = await f.writer.inspect(f.target.directory, f.target.name);
    if (!inspected.ok) throw new Error("SYNTHETIC_REVIEW_UNAVAILABLE");
    const empty = Buffer.alloc(0);
    expect(
      (
        await f.writer.overwrite(
          { ...f.target, evidence: inspected.value },
          "preserved-again.bin",
          empty,
          digest(empty),
        )
      ).ok,
    ).toBe(true);
    expect(readFileSync(f.selected)).toEqual(empty);
    expect(
      readFileSync(join(f.root, "preserved-again.bin")).equals(source),
    ).toBe(true);
  },
  30000,
);

async function heldFile(selected: string, mapped: boolean) {
  const source = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding $false
$request=[Console]::ReadLine() | ConvertFrom-Json
if($request.mapped) {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.MemoryMappedFiles;
public static class SyntheticMappedHold {
  public static void Hold(string path) {
    using(FileStream file=File.Open(path,FileMode.Open,FileAccess.ReadWrite,FileShare.ReadWrite))
    using(MemoryMappedFile mapping=MemoryMappedFile.CreateFromFile(file,null,0,MemoryMappedFileAccess.ReadWrite,HandleInheritability.None,true))
    using(MemoryMappedViewAccessor view=mapping.CreateViewAccessor()) {
      file.Dispose();
      Console.WriteLine("ready");Console.ReadLine();
    }
  }
}
'@
  [SyntheticMappedHold]::Hold([string]$request.path)
  exit 0
} else {$file=[IO.File]::Open([string]$request.path,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
[Console]::WriteLine('ready')
[Console]::ReadLine() | Out-Null
$file.Dispose()
`;
  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(source, "utf16le").toString("base64"),
    ],
    { windowsHide: true, stdio: "pipe" },
  );
  child.stderr.resume();
  const exited = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("SYNTHETIC_HELD_FILE_NOT_READY")),
        5000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout.once("data", (data) => {
        clearTimeout(timer);
        if (String(data).trim() === "ready") resolve();
        else reject(new Error("SYNTHETIC_HELD_FILE_INVALID"));
      });
      child.once("close", () => {
        clearTimeout(timer);
        reject(new Error("SYNTHETIC_HELD_FILE_EXITED"));
      });
      child.stdin.write(JSON.stringify({ path: selected, mapped }) + "\n");
    });
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  }
  return { child, exited };
}
for (const mapped of [false, true])
  windows(
    `refuses ${mapped ? "a writable mapping retained after its file handle closes" : "an exclusively locked target"}`,
    async () => {
      const f = await fixture(),
        source = Buffer.from("Earlier synthetic version");
      let held:
        | { child: ChildProcessWithoutNullStreams; exited: Promise<void> }
        | undefined;
      try {
        held = await heldFile(f.selected, mapped);
        expect(
          (
            await f.writer.overwrite(
              f.target,
              "preserved.txt",
              source,
              digest(source),
            )
          ).ok,
        ).toBe(false);
      } finally {
        if (held) {
          held.child.stdin.end("release\n");
          await held.exited;
        }
      }
      expect(readFileSync(f.selected)).toEqual(f.current);
      expect(existsSync(join(f.root, "preserved.txt"))).toBe(false);
    },
    20000,
  );
