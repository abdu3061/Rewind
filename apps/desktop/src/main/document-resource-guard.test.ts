import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import source from "../native/document-resource-guard.cs?raw";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";

let root: string, executable: string;
beforeAll(() => {
  if (process.platform !== "win32") return;
  root = newSecureFixture();
  const file = path.join(root, "ResourceGuard.cs");
  executable = path.join(root, "SyntheticDocumentGuard.exe");
  writeFileSync(file, source);
  execFileSync(
    path.join(
      process.env.WINDIR ?? "C:\\Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe",
    ),
    ["/nologo", "/target:exe", "/platform:x64", `/out:${executable}`, file],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
  );
});
afterAll(() => {
  if (root) removeSecureFixture(root);
});

const fixture = () =>
  spawn(
    process.execPath,
    [
      "--max-old-space-size=192",
      "--disallow-code-generation-from-strings",
      "-e",
      String.raw`
  process.stdout.write('FIXTURE_READY\n');
  process.stdin.on('data', (command) => {
    if (command.toString().trim()==='allocate') {
      try {const data=Buffer.alloc(640*1024*1024,53);process.stdout.write('UNEXPECTED_ALLOCATION\n');void data;}
      catch {process.stdout.write('ALLOCATION_DENIED\n');}
    }
  });
`,
    ],
    { windowsHide: true, stdio: "pipe" },
  );

async function line(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(
      () => done(new Error("SYNTHETIC_PROCESS_TIMEOUT")),
      5000,
    );
    const closed = () => done(new Error("SYNTHETIC_PROCESS_CLOSED"));
    const data = (value: Buffer) => {
      output += value.toString();
      if (output.includes("\n")) done(null);
    };
    function done(error: Error | null) {
      clearTimeout(timeout);
      child.stdout.off("data", data);
      child.off("close", closed);
      if (error) reject(error);
      else resolve(output.trim());
    }
    child.stdout.on("data", data);
    child.once("close", closed);
    child.stderr.resume();
  });
}

async function close(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "close");
  child.kill();
  await ended;
}

it.skipIf(process.platform !== "win32")(
  "enforces native memory admission and kills the parser when the guard input closes",
  async () => {
    const child = fixture();
    let guard: ChildProcessWithoutNullStreams | undefined;
    try {
      expect(await line(child)).toBe("FIXTURE_READY");
      guard = spawn(executable, [String(process.pid), String(child.pid)], {
        windowsHide: true,
        stdio: "pipe",
      });
      expect(await line(guard)).toBe("DOCUMENT_RESOURCE_READY");
      const allocation = line(child);
      child.stdin.write("allocate\n");
      // V8 can report allocation failure or Windows can terminate the constrained process.
      await expect(allocation).resolves.toBe("ALLOCATION_DENIED");
      const childClosed = once(child, "close"),
        guardClosed = once(guard, "close");
      guard.stdin.end();
      await Promise.all([childClosed, guardClosed]);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (guard) await close(guard);
      await close(child);
    }
  },
  15000,
);

it.skipIf(process.platform !== "win32")(
  "refuses an invalid parent claim without admitting the waiting child",
  async () => {
    const child = fixture();
    let guard: ChildProcessWithoutNullStreams | undefined;
    try {
      expect(await line(child)).toBe("FIXTURE_READY");
      guard = spawn(executable, [String(child.pid), String(process.pid)], {
        windowsHide: true,
        stdio: "pipe",
      });
      guard.stdout.resume();
      guard.stderr.resume();
      const [code] = await once(guard, "close");
      expect(code).toBe(1);
      expect(child.exitCode).toBe(null);
    } finally {
      if (guard) await close(guard);
      await close(child);
    }
  },
);
