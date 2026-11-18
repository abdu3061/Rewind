import {
  constants,
  generateKeyPair,
  privateDecrypt,
  randomUUID,
  type KeyObject,
} from "node:crypto";
import {
  assistantCredentialChallengeSchema,
  assistantCredentialPlaintextSchema,
  assistantSealedCredentialSchema,
  failure,
  idSchema,
  type AssistantCredentialChallenge,
  type AssistantCredentialStore,
  type AssistantSealedCredential,
  type Result,
} from "@rewind/contracts";

interface Pair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}
interface Plan {
  reply: AssistantCredentialChallenge;
  key: KeyObject;
  revision: number;
  monotonicExpires: number;
}
interface Options {
  store: AssistantCredentialStore;
  /** Revoke/drain cloud requests, without automatically granting later permission. */
  quiesce(): Promise<Result<void>>;
  now?(): string;
  monotonicNow?(): number;
  /** Trusted test seam, never part of a worker/public command. */
  createPair?(): Promise<Pair>;
}
const stopped = () =>
  failure(
    "CONFLICT",
    "Credential configuration expired, changed or stopped. Start a new native credential review.",
  );
/** Utility-only ephemeral RSA recipient. Main/native UI receive a public challenge and sealed bytes only. */
export class AssistantCredentials {
  private plan: Plan | null = null;
  private revision = 0;
  private pending: Promise<unknown> | null = null;
  private closed = false;
  constructor(private readonly options: Options) {}
  private now() {
    return this.options.now?.() ?? new Date().toISOString();
  }
  private ticks() {
    return this.options.monotonicNow?.() ?? performance.now();
  }
  get busy(): boolean {
    return this.pending !== null || this.plan !== null;
  }
  invalidate(): void {
    this.revision++;
    this.plan = null;
  }
  cancel(id: string): Result<true> {
    if (!idSchema.safeParse(id).success)
      return failure("INVALID_INPUT", "A credential review ID is required.");
    if (this.plan?.reply.id === id) this.invalidate();
    return { ok: true, value: true };
  }
  private run<T>(
    operation: (current: () => boolean) => Promise<Result<T>>,
  ): Promise<Result<T>> {
    if (this.closed) return Promise.resolve(stopped());
    if (this.pending)
      return Promise.resolve(
        failure("CONFLICT", "Another credential operation is in progress."),
      );
    const ticket = this.revision,
      current = () => !this.closed && ticket === this.revision;
    const work = Promise.resolve()
      .then(() => operation(current))
      .catch(() =>
        failure(
          "UNAVAILABLE",
          "The private credential operation could not be confirmed.",
        ),
      );
    this.pending = work;
    void work.finally(() => {
      if (this.pending === work) this.pending = null;
    });
    return work;
  }
  prepare(confirmed: true): Promise<Result<AssistantCredentialChallenge>> {
    if (confirmed !== true)
      return Promise.resolve(
        failure(
          "INVALID_INPUT",
          "Explicit credential configuration confirmation is required.",
        ),
      );
    if (this.pending)
      return Promise.resolve(
        failure("CONFLICT", "Another credential operation is in progress."),
      );
    this.invalidate();
    return this.run(async (current) => {
      const stopped = await this.options.quiesce();
      if (!stopped.ok) return stopped;
      if (!current())
        return failure("CONFLICT", "Credential configuration was superseded.");
      const previous = await this.options.store.read();
      if (!previous.ok) return previous;
      if (!current())
        return failure("CONFLICT", "Credential configuration was superseded.");
      const pair = this.options.createPair
        ? await this.options.createPair()
        : await new Promise<Pair>((resolve, reject) =>
            generateKeyPair(
              "rsa",
              { modulusLength: 4096, publicExponent: 65537 },
              (error, publicKey, privateKey) =>
                error ? reject(error) : resolve({ publicKey, privateKey }),
            ),
          );
      if (!current())
        return failure("CONFLICT", "Credential configuration was superseded.");
      const publicKey = pair.publicKey.export({ format: "jwk" });
      if (publicKey.kty !== "RSA" || !publicKey.n || !publicKey.e)
        throw new Error("CREDENTIAL_PUBLIC_KEY_INVALID");
      const reply = assistantCredentialChallengeSchema.parse({
        id: randomUUID(),
        expiresAt: new Date(Date.parse(this.now()) + 120000).toISOString(),
        modulus: Buffer.from(publicKey.n, "base64url").toString("base64"),
        exponent: Buffer.from(publicKey.e, "base64url").toString("base64"),
      });
      this.plan = {
        reply,
        key: pair.privateKey,
        revision: previous.value.revision,
        monotonicExpires: this.ticks() + 120000,
      };
      return { ok: true, value: structuredClone(reply) };
    });
  }
  accept(
    input: AssistantSealedCredential,
    confirmed: true,
  ): Promise<Result<true>> {
    if (
      confirmed !== true ||
      !assistantSealedCredentialSchema.safeParse(input).success
    )
      return Promise.resolve(
        failure(
          "INVALID_INPUT",
          "A bounded sealed native credential confirmation is required.",
        ),
      );
    return this.run(async (current) => {
      const plan = this.plan;
      this.plan = null;
      if (
        !plan ||
        plan.reply.id !== input.id ||
        plan.reply.expiresAt <= this.now() ||
        plan.monotonicExpires <= this.ticks()
      )
        return stopped();
      let plaintext: Buffer | undefined;
      let apiKey: string;
      try {
        const ciphertext = Buffer.from(input.sealed, "base64");
        if (
          ciphertext.length !== 512 ||
          ciphertext.toString("base64") !== input.sealed
        )
          return failure("INVALID_INPUT", "The sealed credential is invalid.");
        plaintext = privateDecrypt(
          {
            key: plan.key,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
          },
          ciphertext,
        );
        if (plaintext.length > 446)
          return failure(
            "INVALID_INPUT",
            "The private credential payload is too large.",
          );
        const decoded = assistantCredentialPlaintextSchema.safeParse(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
          ),
        );
        if (!decoded.success || decoded.data.id !== plan.reply.id)
          return failure(
            "INVALID_INPUT",
            "The sealed credential does not match its review.",
          );
        apiKey = decoded.data.apiKey;
      } catch {
        return failure(
          "INVALID_INPUT",
          "The sealed credential could not be verified. Prepare a new native review.",
        );
      } finally {
        plaintext?.fill(0);
      }
      const quiescent = await this.options.quiesce();
      if (!quiescent.ok) return quiescent;
      if (
        !current() ||
        plan.reply.expiresAt <= this.now() ||
        plan.monotonicExpires <= this.ticks()
      )
        return stopped();
      const saved = await this.options.store.write(
        plan.revision,
        apiKey,
        this.now(),
      );
      if (!saved.ok) return saved;
      return current() ? { ok: true, value: true } : stopped();
    });
  }
  forget(confirmed: true): Promise<Result<true>> {
    if (confirmed !== true)
      return Promise.resolve(
        failure(
          "INVALID_INPUT",
          "Explicit credential removal confirmation is required.",
        ),
      );
    this.invalidate();
    if (this.pending)
      return Promise.resolve(
        failure(
          "CONFLICT",
          "The earlier credential operation is stopping. Retry removal after it finishes.",
        ),
      );
    return this.run(async (current) => {
      const stopped = await this.options.quiesce();
      if (!stopped.ok) return stopped;
      const previous = await this.options.store.read();
      if (!previous.ok) return previous;
      if (!current())
        return failure("CONFLICT", "Credential removal was superseded.");
      const saved = await this.options.store.write(
        previous.value.revision,
        null,
        this.now(),
      );
      return saved.ok
        ? current()
          ? { ok: true, value: true }
          : failure("CONFLICT", "Credential removal was superseded.")
        : saved;
    });
  }
  async close(): Promise<Result<void>> {
    this.closed = true;
    this.invalidate();
    if (!this.pending) return { ok: true, value: undefined };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopped = await Promise.race([
        this.pending.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      return stopped
        ? { ok: true, value: undefined }
        : failure(
            "UNAVAILABLE",
            "The private credential operation has not stopped. Retry shutdown.",
          );
    } finally {
      clearTimeout(timer);
    }
  }
}
