import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  failure,
  nativeOverwriteReplySchema,
  recoveryFileEvidenceSchema,
  type RecoveryDirectoryProof,
  type RecoveryFileEvidence,
  type RecoveryOverwriteReceipt,
  type RecoveryOverwriteTarget,
  type RecoveryOverwriteWriter,
  type Result,
} from "@rewind/contracts";
import { windowsOverwriteScript } from "./windows-overwrite-script";

const bootstrap = String.raw`
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine()))
& ([ScriptBlock]::Create($source))
`.trim();
const nameValid = (name: string) =>
  name.length > 0 &&
  name.length <= 240 &&
  !/[<>:"/\\|?*]/.test(name) &&
  !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
  name !== "." &&
  name !== ".." &&
  !/[. ]$/.test(name);
const directoryValid = (directory: RecoveryDirectoryProof) =>
  /^[a-z]:\\/i.test(directory.absolutePath) &&
  directory.absolutePath.length <= 240 &&
  /^[a-f0-9]{8}:[a-f0-9]{16}$/.test(directory.osIdentity);
const uncertain = () =>
  failure(
    "UNAVAILABLE",
    "Recovery could not be confirmed. Inspect the selected target and preservation filename before retrying; an interrupted write may need recovery from the preserved copy.",
  );

/** Native primitive only. No app/public wiring until the engine owns review and confirmation. */
export class WindowsRecoveryOverwriteWriter implements RecoveryOverwriteWriter {
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
          "The overwrite helper has not stopped. Retry shutdown.",
        );
  }
  private async run(command: object) {
    if (this.closing || process.platform !== "win32") return uncertain();
    if (this.children.size)
      return failure("CONFLICT", "A previous recovery helper has not stopped.");
    const raw = await new Promise<Result<unknown>>((resolve) => {
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
        resolve(uncertain());
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
        if (code !== 0) return fail();
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
            throw new Error("OVERWRITE_RESPONSE");
          resolve({ ok: true, value: parsed.value });
        } catch {
          resolve(uncertain());
        }
      });
      child.stdin.end(
        Buffer.from(windowsOverwriteScript, "utf8").toString("base64") +
          "\n" +
          JSON.stringify(command) +
          "\n",
      );
    }).catch(uncertain);
    if (!raw.ok) return raw;
    const parsed = nativeOverwriteReplySchema.safeParse(raw.value);
    return parsed.success
      ? { ok: true as const, value: parsed.data }
      : failure(
          "INTEGRITY_FAILURE",
          "Overwrite evidence could not be verified. Inspect the selected target and preservation filename.",
        );
  }
  async inspect(
    directory: RecoveryDirectoryProof,
    name: string,
  ): Promise<Result<RecoveryFileEvidence>> {
    if (!directoryValid(directory) || !nameValid(name))
      return failure("INVALID_INPUT", "Choose a bounded regular Windows file.");
    const reply = await this.run({
      kind: "inspect-overwrite",
      path: directory.absolutePath,
      identity: directory.osIdentity,
      name,
    });
    if (!reply.ok) return reply;
    if (
      reply.value.status !== "inspected" ||
      reply.value.code !== "ok" ||
      !reply.value.target ||
      reply.value.targetTouched ||
      reply.value.preserved
    )
      return failure(
        reply.value.code === "conflict" ? "CONFLICT" : "UNAVAILABLE",
        "The selected target could not be verified. No overwrite was attempted.",
      );
    return { ok: true, value: reply.value.target };
  }
  async overwrite(
    target: RecoveryOverwriteTarget,
    backupName: string,
    bytes: Uint8Array,
    hash: string,
  ): Promise<Result<RecoveryOverwriteReceipt>> {
    if (
      !directoryValid(target.directory) ||
      !nameValid(target.name) ||
      !nameValid(backupName) ||
      backupName.toLowerCase() === target.name.toLowerCase() ||
      !recoveryFileEvidenceSchema.safeParse(target.evidence).success ||
      bytes.byteLength > 16 * 1024 ** 2 ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      return failure(
        "INVALID_INPUT",
        "Verified target, source and a separate preservation filename are required.",
      );
    const reply = await this.run({
      kind: "overwrite",
      path: target.directory.absolutePath,
      identity: target.directory.osIdentity,
      name: target.name,
      expectedIdentity: target.evidence.osIdentity,
      expectedHash: target.evidence.contentHash,
      expectedSize: target.evidence.byteLength,
      expectedWritten: target.evidence.lastWriteToken,
      backupName,
      base64: Buffer.from(bytes).toString("base64"),
      hash,
    });
    if (!reply.ok) return reply;
    const result = reply.value;
    if (result.status !== "replaced" || result.code !== "ok")
      return failure(
        result.code === "conflict"
          ? "CONFLICT"
          : result.code === "integrity"
            ? "INTEGRITY_FAILURE"
            : "UNAVAILABLE",
        result.targetTouched
          ? result.originalRestored
            ? "Overwrite failed; the original bytes were restored and the verified preservation copy remains. Inspect both files before retrying."
            : "Overwrite failed after writing began. The verified preservation copy remains; inspect it and the target before retrying."
          : "Overwrite prerequisites failed. The target was not changed; a completed preservation copy may remain.",
      );
    if (
      !result.target ||
      !result.preserved ||
      !result.targetTouched ||
      result.target.contentHash !== hash ||
      result.target.byteLength !== bytes.byteLength ||
      result.target.osIdentity !== target.evidence.osIdentity ||
      result.preserved.contentHash !== target.evidence.contentHash ||
      result.preserved.byteLength !== target.evidence.byteLength ||
      result.preserved.osIdentity === result.target.osIdentity
    )
      return failure(
        "INTEGRITY_FAILURE",
        "Written output or preserved current bytes could not be verified. Inspect both selected filenames.",
      );
    return {
      ok: true,
      value: { target: result.target, preserved: result.preserved },
    };
  }
}
