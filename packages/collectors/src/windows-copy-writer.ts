import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  failure,
  nativeCopyReplySchema,
  type RecoveryCopyWriter,
  type RecoveryDirectoryProof,
  type RecoveryCopyReceipt,
  type Result,
} from "@rewind/contracts";
import { windowsCopyScript } from "./windows-copy-script";

// Only the bundled static helper is evaluated. File content/path values are subsequent JSON data.
const bootstrap = String.raw`
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
& ([ScriptBlock]::Create($source))
`.trim();
/** User-confirmed recovery only. This adapter never opens an existing destination for writing. */
export class WindowsRecoveryCopyWriter implements RecoveryCopyWriter {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private closing = false;
  async close(): Promise<Result<void>> {
    this.closing = true;
    const stopped = await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), 2000);
            child.once("close", () => {
              clearTimeout(timer);
              resolve(true);
            });
            child.kill();
          }),
      ),
    );
    return stopped.every(Boolean)
      ? { ok: true, value: undefined }
      : failure(
          "UNAVAILABLE",
          "The recovery helper has not stopped. Retry shutdown.",
        );
  }
  async createCopy(
    directory: RecoveryDirectoryProof,
    name: string,
    bytes: Uint8Array,
    hash: string,
  ): Promise<Result<RecoveryCopyReceipt>> {
    if (this.children.size)
      return failure(
        "UNAVAILABLE",
        "A previous recovery helper has not finished. Retry after it stops.",
      );
    if (
      this.closing ||
      process.platform !== "win32" ||
      bytes.byteLength > 16 * 1024 ** 2 ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      !name ||
      name.length > 240 ||
      directory.absolutePath.length > 240 ||
      directory.osIdentity.length > 128
    )
      return failure(
        "INVALID_INPUT",
        "A bounded verified Windows recovery copy is required.",
      );
    const command = JSON.stringify({
      kind: "copy",
      path: directory.absolutePath,
      identity: directory.osIdentity,
      name,
      base64: Buffer.from(bytes).toString("base64"),
      hash,
    });
    const reply = await new Promise<Result<unknown>>((resolve) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(bootstrap, "utf16le").toString("base64"),
        ],
        { windowsHide: true, stdio: "pipe" },
      );
      this.children.add(child);
      child.once("close", () => this.children.delete(child));
      let output = "",
        finished = false;
      const fail = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.kill();
        resolve(
          failure(
            "UNAVAILABLE",
            "Recovery copy could not be confirmed. A partial new file may remain at the chosen destination; no existing file was replaced.",
          ),
        );
      };
      const timer = setTimeout(fail, 15000);
      child.stdout.setEncoding("utf8");
      child.stderr.resume();
      child.stdout.on("data", (data: string) => {
        output += data;
        if (output.length > 65536) fail();
      });
      child.stdin.on("error", fail);
      child.on("error", fail);
      child.once("close", (code) => {
        if (finished) return;
        if (code !== 0) {
          fail();
          return;
        }
        finished = true;
        clearTimeout(timer);
        try {
          const parsed: unknown = JSON.parse(output.trim());
          if (
            !parsed ||
            typeof parsed !== "object" ||
            !("ok" in parsed) ||
            parsed.ok !== true ||
            !("value" in parsed) ||
            Object.keys(parsed).length !== 2
          )
            throw new Error("COPY_RESPONSE");
          resolve({ ok: true, value: parsed.value });
        } catch {
          resolve(
            failure(
              "UNAVAILABLE",
              "Recovery copy could not be verified. Check the chosen destination for a partial new file; no existing file was replaced.",
            ),
          );
        }
      });
      child.stdin.end(
        Buffer.from(windowsCopyScript, "utf8").toString("base64") +
          "\n" +
          command +
          "\n",
      );
    }).catch(() =>
      failure(
        "UNAVAILABLE",
        "The recovery helper could not start. No existing file was replaced.",
      ),
    );
    if (!reply.ok) return reply;
    const parsed = nativeCopyReplySchema.safeParse(reply.value);
    if (!parsed.success)
      return failure(
        "INTEGRITY_FAILURE",
        "The recovery adapter returned invalid evidence.",
      );
    const result = parsed.data;
    if (result.status !== "copied")
      return failure(
        result.code === "conflict"
          ? "CONFLICT"
          : result.code === "integrity"
            ? "INTEGRITY_FAILURE"
            : "UNAVAILABLE",
        result.code === "conflict"
          ? "The destination already exists. Choose a new filename for a recovery copy."
          : result.cleanupConfirmed
            ? "Recovery copy failed without leaving a new file. No existing file was replaced."
            : "Recovery copy failed. A partial new file may remain at the chosen destination; no existing file was replaced.",
      );
    if (
      result.code !== "ok" ||
      result.contentHash !== hash ||
      result.byteLength !== bytes.byteLength ||
      !result.osIdentity
    )
      return failure(
        "INTEGRITY_FAILURE",
        "Written recovery bytes could not be verified. Check the chosen destination before retrying.",
      );
    return {
      ok: true,
      value: {
        contentHash: result.contentHash,
        osIdentity: result.osIdentity,
        byteLength: result.byteLength,
      },
    };
  }
}
