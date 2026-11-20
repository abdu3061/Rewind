import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  assistantCredentialChallengeSchema,
  assistantSealedCredentialSchema,
  failure,
  type AssistantCredentialChallenge,
  type AssistantSealedCredential,
  type Result,
} from "@rewind/contracts";
import { credentialPromptScript } from "./credential-prompt-script";

const unavailable = () =>
  failure(
    "UNAVAILABLE",
    "The native Gemini credential dialog could not be confirmed. No new credential was accepted.",
  );
/** Main-owned UI only. Plaintext credentials never enter main, preload or renderer. */
export class NativeCredentialPrompt {
  private child: ChildProcessWithoutNullStreams | null = null;
  private closed = false;
  constructor(
    private readonly owner: () => { parent: string; processId: number } | null,
  ) {}
  async prompt(
    input: AssistantCredentialChallenge,
  ): Promise<Result<AssistantSealedCredential | null>> {
    if (this.closed || this.child || process.platform !== "win32")
      return unavailable();
    const challenge = assistantCredentialChallengeSchema.safeParse(input);
    let owner: ReturnType<typeof this.owner>;
    try {
      owner = this.owner();
    } catch {
      return unavailable();
    }
    if (
      !challenge.success ||
      !owner ||
      !/^[1-9][0-9]{0,18}$/.test(owner.parent) ||
      !Number.isSafeInteger(owner.processId) ||
      owner.processId <= 0 ||
      owner.processId > 0xffffffff
    )
      return unavailable();
    const remaining = Date.parse(challenge.data.expiresAt) - Date.now();
    if (remaining <= 0 || remaining > 120000) return unavailable();
    return new Promise<Result<AssistantSealedCredential | null>>((resolve) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(credentialPromptScript, "utf16le").toString("base64"),
        ],
        { windowsHide: true, stdio: "pipe" },
      );
      this.child = child;
      child.once("close", () => {
        if (this.child === child) this.child = null;
      });
      let output = "",
        finished = false;
      const fail = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        child.kill();
        resolve(unavailable());
      };
      const timer = setTimeout(fail, Math.min(remaining, 120000));
      child.stdout.setEncoding("utf8");
      child.stderr.resume();
      child.stdout.on("data", (data: string) => {
        output += data;
        if (output.length > 4096) fail();
      });
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.once("close", (code) => {
        if (finished) return;
        if (code !== 0 || this.closed) return fail();
        finished = true;
        clearTimeout(timer);
        try {
          const raw: unknown = JSON.parse(output.trim());
          if (
            !raw ||
            typeof raw !== "object" ||
            Object.keys(raw).length !== 3 ||
            !("status" in raw) ||
            !("id" in raw) ||
            !("sealedValue" in raw)
          )
            throw new Error("CREDENTIAL_REPLY");
          if (
            raw.status === "cancelled" &&
            raw.id === null &&
            raw.sealedValue === null
          ) {
            resolve({ ok: true, value: null });
            return;
          }
          const packet = assistantSealedCredentialSchema.safeParse({
            id: raw.id,
            sealed: raw.sealedValue,
          });
          resolve(
            raw.status === "sealed" &&
              packet.success &&
              packet.data.id === challenge.data.id
              ? { ok: true, value: packet.data }
              : unavailable(),
          );
        } catch {
          resolve(unavailable());
        }
      });
      child.stdin.end(
        JSON.stringify({
          ...challenge.data,
          parent: owner.parent,
          owner: owner.processId,
        }) + "\n",
      );
    }).catch(unavailable);
  }
  async close(): Promise<Result<void>> {
    this.closed = true;
    const child = this.child;
    if (!child) return { ok: true, value: undefined };
    return new Promise((resolve) => {
      const timer = setTimeout(
        () =>
          resolve(
            failure(
              "UNAVAILABLE",
              "The native credential dialog has not stopped. Retry shutdown.",
            ),
          ),
        2000,
      );
      child.once("close", () => {
        clearTimeout(timer);
        resolve({ ok: true, value: undefined });
      });
      child.kill();
    });
  }
}
