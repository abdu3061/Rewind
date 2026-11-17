import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  failure,
  nativeFileBytesSchema,
  nativeFileListingSchema,
  nativeFolderProofSchema,
  type ProtectedFileAccess,
  type ProtectedFolder,
  type Result,
} from "@rewind/contracts";
import { windowsFileScript } from "./windows-file-script";

const unavailable = () =>
  failure(
    "UNAVAILABLE",
    "The file could not be accessed with verified Windows identity, sharing and path protection.",
  );
/** One bounded helper per protection run. Never instantiated by renderer or without a consent gate. */
export class WindowsProtectedFileAccess implements ProtectedFileAccess {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private closed = false;
  private queue = Promise.resolve<unknown>(undefined);
  private queued = 0;
  private exited = Promise.resolve();
  private pending: {
    resolve: (value: Result<unknown>) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private fail() {
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(unavailable());
    }
    this.closed = true;
    this.child?.kill();
  }
  private start(): ChildProcessWithoutNullStreams {
    if (this.closed || process.platform !== "win32")
      throw new Error("FILE_ACCESS_CLOSED");
    if (this.child) return this.child;
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(windowsFileScript, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    this.exited = new Promise<void>((resolve) => {
      child.once("exit", () => {
        this.fail();
        this.child = null;
        resolve();
      });
      child.once("error", () => {
        this.fail();
        if (!child.pid) {
          this.child = null;
          resolve();
        }
      });
    });
    child.stdin.on("error", () => this.fail());
    child.stdout.on("data", (data: string) => {
      this.buffer += data;
      if (this.buffer.length > 24 * 1024 ** 2) {
        this.fail();
        return;
      }
      const end = this.buffer.indexOf("\n");
      if (end < 0) return;
      const pending = this.pending;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      if (!pending || this.buffer.trim()) {
        this.fail();
        return;
      }
      this.pending = null;
      clearTimeout(pending.timer);
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== "object" || !("ok" in value))
          throw new Error("FILE_RESPONSE");
        if (value.ok === false && Object.keys(value).length === 1)
          pending.resolve(unavailable());
        else if (
          value.ok === true &&
          "value" in value &&
          Object.keys(value).length === 2
        )
          pending.resolve({ ok: true, value: value.value });
        else throw new Error("FILE_RESPONSE");
      } catch {
        pending.resolve(unavailable());
        this.fail();
      }
    });
    return child;
  }
  private request(command: object): Promise<Result<unknown>> {
    if (
      this.closed ||
      this.queued >= 32 ||
      Buffer.byteLength(JSON.stringify(command)) > 32768
    )
      return Promise.resolve(unavailable());
    this.queued++;
    const result = this.queue
      .then(() => {
        if (this.closed) return unavailable();
        return new Promise<Result<unknown>>((resolve) => {
          try {
            const child = this.start();
            this.pending = {
              resolve,
              timer: setTimeout(() => this.fail(), 8000),
            };
            child.stdin.write(JSON.stringify(command) + "\n");
          } catch {
            resolve(unavailable());
            this.fail();
          }
        });
      })
      .catch(() => unavailable());
    this.queue = result;
    return result.finally(() => {
      this.queued--;
    });
  }
  async validateFolder(
    path: string,
  ): ReturnType<ProtectedFileAccess["validateFolder"]> {
    const result = await this.request({ kind: "folder", path });
    if (!result.ok) return result;
    const parsed = nativeFolderProofSchema.safeParse(result.value);
    return parsed.success ? { ok: true, value: parsed.data } : unavailable();
  }
  async list(folder: ProtectedFolder): ReturnType<ProtectedFileAccess["list"]> {
    const result = await this.request({
      kind: "list",
      path: folder.absolutePath,
      identity: folder.osIdentity,
    });
    if (!result.ok) return result;
    const parsed = nativeFileListingSchema.safeParse(result.value);
    return parsed.success ? { ok: true, value: parsed.data } : unavailable();
  }
  async read(
    folder: ProtectedFolder,
    relativePath: string,
  ): ReturnType<ProtectedFileAccess["read"]> {
    const result = await this.request({
      kind: "read",
      path: folder.absolutePath,
      identity: folder.osIdentity,
      relative: relativePath,
    });
    if (!result.ok) return result;
    const parsed = nativeFileBytesSchema.safeParse(result.value);
    if (!parsed.success) {
      this.fail();
      return unavailable();
    }
    const bytes = Buffer.from(parsed.data.base64, "base64");
    if (
      bytes.length !== parsed.data.byteLength ||
      bytes.toString("base64") !== parsed.data.base64
    ) {
      bytes.fill(0);
      return unavailable();
    }
    return { ok: true, value: { bytes, osIdentity: parsed.data.osIdentity } };
  }
  async close(): Promise<Result<void>> {
    this.fail();
    if (!this.child) return { ok: true, value: undefined };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
      return this.child ? unavailable() : { ok: true, value: undefined };
    } finally {
      clearTimeout(timer);
      this.buffer = "";
    }
  }
}
