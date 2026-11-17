import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import proofSource from "../native/browser-process-proof.cs?raw";
import programSource from "../native/browser-native-program.cs?raw";
import {
  newSecureFixture,
  removeSecureFixture,
} from "../../../../packages/storage/src/secure-fixtures.test-support";

let root: string, executable: string, fixtureExecutable: string;
beforeAll(() => {
  if (process.platform !== "win32") return;
  root = newSecureFixture();
  executable = path.join(root, "SyntheticNativeHost.exe");
  const proof = path.join(root, "Proof.cs"),
    program = path.join(root, "Program.cs");
  writeFileSync(proof, proofSource);
  writeFileSync(program, programSource);
  const compiler = path.join(
    process.env.WINDIR ?? "C:\\Windows",
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  execFileSync(
    compiler,
    [
      "/nologo",
      "/target:exe",
      "/platform:x64",
      "/r:System.Web.Extensions.dll",
      `/out:${executable}`,
      proof,
      program,
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
  );
  const driver = path.join(root, "Fixture.cs");
  fixtureExecutable = path.join(root, "NativeWireFixture.exe");
  writeFileSync(
    driver,
    String.raw`
namespace Rewind.NativeBrowser {
  public static class NativeWireFixture {
    public static int Main(string[] args) {
      try {
        if(args.Length!=1) return 1;
        if(args[0]=="echo") {
          System.IO.Stream input=System.Console.OpenStandardInput(),output=System.Console.OpenStandardOutput();
          byte[] body;while((body=Wire.Read(input))!=null) Wire.Write(output,body);return 0;
        }
        if(args[0]=="config") {
          BridgeConfig.Parse(System.Text.Encoding.UTF8.GetBytes(System.Console.In.ReadToEnd()));return 0;
        }
        if(args[0]=="watch-parent") {
          using(ProcessProof self=ProcessProof.Query((uint)System.Diagnostics.Process.GetCurrentProcess().Id))
          using(ProcessProof parent=ProcessProof.Query(self.parentId))
          using(ProcessWatch watch=new ProcessWatch(parent)) {
            System.Console.WriteLine("ready");System.Console.Out.Flush();System.Threading.Thread.Sleep(10000);return 0;
          }
        }
        return 1;
      } catch {return 1;}
    }
  }
}`,
  );
  execFileSync(
    compiler,
    [
      "/nologo",
      "/target:exe",
      "/platform:x64",
      "/r:System.Web.Extensions.dll",
      "/main:Rewind.NativeBrowser.NativeWireFixture",
      `/out:${fixtureExecutable}`,
      proof,
      program,
      driver,
    ],
    { windowsHide: true, timeout: 15000, maxBuffer: 65536 },
  );
}, 20000);
afterAll(() => {
  if (root) removeSecureFixture(root);
});
it.runIf(process.platform === "win32")(
  "compiles the native relay and rejects unknown/missing caller configuration before opening a pipe",
  () => {
    for (const args of [
      [],
      ["unexpected"],
      [`chrome-extension://${"a".repeat(32)}/`],
      [`chrome-extension://${"a".repeat(32)}/`, "--expanded-command"],
    ]) {
      let exit: number | null = null;
      try {
        execFileSync(executable, args, {
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 4096,
        });
      } catch (error) {
        exit = (error as { status: number | null }).status;
      }
      expect(exit).toBe(1);
    }
  },
  15000,
);
it.runIf(process.platform === "win32")(
  "ends its own relay when its observed parent dies even when the main thread is blocked",
  async () => {
    const script = String.raw`const {spawn}=require('node:child_process');spawn(process.argv[1],['watch-parent'],{windowsHide:true,stdio:['ignore',process.stdout,process.stderr]});setInterval(()=>{},1000);`;
    const parent = spawn(process.execPath, ["-e", script, fixtureExecutable], {
      windowsHide: true,
      stdio: "pipe",
    });
    parent.stdin.end();
    parent.stderr.resume();
    parent.stdout.setEncoding("utf8");
    const closed = new Promise<void>((resolve, reject) => {
      parent.once("error", reject);
      parent.once("close", () => resolve());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        parent.stdout.once("data", (value: string) => {
          if (value.trim() !== "ready")
            reject(new Error("SYNTHETIC_LIFETIME_NOT_READY"));
          else resolve();
        });
        parent.once("error", reject);
      });
      parent.kill();
      await closed;
    } finally {
      parent.kill();
    }
  },
  8000,
);
it.runIf(process.platform === "win32")(
  "starts the private broker for its real desktop parent and rejects origin claims from a different executable",
  async () => {
    const value = config(),
      child = spawn(executable, ["--broker"], {
        windowsHide: true,
        stdio: "pipe",
      });
    const messages: { type: string }[] = [];
    let output = "",
      closed = false;
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      while (output.includes("\n")) {
        const at = output.indexOf("\n");
        messages.push(JSON.parse(output.slice(0, at)) as { type: string });
        output = output.slice(at + 1);
      }
    });
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    });
    try {
      child.stdin.write(JSON.stringify(value) + "\n");
      await expect
        .poll(() => messages.some((message) => message.type === "ready"), {
          timeout: 8000,
        })
        .toBe(true);
      for (let i = 0; i < 2; i++) {
        const socket = createConnection(`\\\\.\\pipe\\${value.pipeName}`);
        const disconnected = new Promise<void>((resolve) => {
          socket.on("error", () => {});
          socket.once("close", () => resolve());
        });
        socket.once("connect", () =>
          socket.write(
            frame(
              JSON.stringify({
                version: 1,
                type: "authenticate",
                origin: value.origins[0],
              }),
            ),
          ),
        );
        await disconnected;
      }
      expect(
        messages.some(
          (message) =>
            message.type === "connected" || message.type === "message",
        ),
      ).toBe(false);
      child.stdin.write('{"type":"shutdown"}\n');
      expect(await exited).toEqual({ code: 0, signal: null });
    } finally {
      if (!closed) {
        child.kill();
        await exited;
      }
    }
  },
  15000,
);
function frame(value: string) {
  const payload = Buffer.from(value, "utf8"),
    header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}
function exitCode(
  program: string,
  args: string[],
  input?: Buffer,
): number | null {
  try {
    execFileSync(program, args, {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      ...(input ? { input } : {}),
    });
    return 0;
  } catch (error) {
    return (error as { status: number | null }).status;
  }
}
it.runIf(process.platform === "win32")(
  "relays complete little-endian UTF-8 frames and rejects oversized, malformed and truncated bytes",
  () => {
    const expected = Buffer.concat([
      frame('{"synthetic":"first"}'),
      frame(JSON.stringify({ synthetic: "Multibyte çalışma 🧪" })),
    ]);
    expect(
      execFileSync(fixtureExecutable, ["echo"], {
        windowsHide: true,
        input: expected,
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      }),
    ).toEqual(expected);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(262145);
    for (const input of [
      Buffer.from([0, 0, 0, 0]),
      Buffer.from([3, 0]),
      Buffer.from([3, 0, 0, 0, 65]),
      Buffer.from([2, 0, 0, 0, 0xc0, 0xaf]),
      oversized,
    ])
      expect(exitCode(fixtureExecutable, ["echo"], input)).toBe(1);
  },
);
function config() {
  return {
    version: 1,
    pipeName: `rewind.test.${randomUUID().replaceAll("-", "")}`,
    desktopPath: process.execPath,
    desktopHash: createHash("sha256")
      .update(readFileSync(process.execPath))
      .digest("hex"),
    hostHash: createHash("sha256")
      .update(readFileSync(executable))
      .digest("hex"),
    origins: [`chrome-extension://${"a".repeat(32)}/`],
    browsers: [
      {
        kind: "chrome",
        path: path.join(
          process.env.ProgramFiles ?? "C:\\Program Files",
          "Google",
          "Chrome",
          "Application",
          "chrome.exe",
        ),
      },
    ],
  };
}
it.runIf(process.platform === "win32")(
  "validates bounded exact-origin local configuration and refuses a direct nonbrowser caller even with valid configuration",
  () => {
    const valid = config(),
      bytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
    expect(exitCode(fixtureExecutable, ["config"], bytes(valid))).toBe(0);
    for (const invalid of [
      { ...valid, version: 2 },
      { ...valid, expanded: true },
      { ...valid, origins: ["chrome-extension://*/"] },
      { ...valid, desktopPath: "\\\\remote.invalid\\share\\desktop.exe" },
      { ...valid, pipeName: "\\\\remote.invalid\\pipe\\arbitrary" },
      { ...valid, hostHash: "not-a-hash" },
      { ...valid, browsers: [{ kind: "other", path: process.execPath }] },
    ])
      expect(exitCode(fixtureExecutable, ["config"], bytes(invalid))).toBe(1);
    writeFileSync(executable + ".json", JSON.stringify(valid));
    expect(exitCode(executable, [valid.origins[0]!, "--parent-window=0"])).toBe(
      1,
    );
    expect(
      exitCode(executable, [
        `chrome-extension://${"b".repeat(32)}/`,
        "--parent-window=0",
      ]),
    ).toBe(1);
  },
  15000,
);
it.runIf(process.platform === "win32")(
  "terminates its own process on a stalled partial frame instead of retaining a blocked stdin read",
  async () => {
    const child = spawn(fixtureExecutable, ["echo"], {
      windowsHide: true,
      stdio: "pipe",
    });
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.on("error", () => {});
    try {
      const closed = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      child.stdin.write(Buffer.from([10, 0, 0, 0, 65]));
      expect(await closed).toEqual({ code: 1, signal: null });
    } finally {
      child.kill();
    }
  },
  8000,
);
