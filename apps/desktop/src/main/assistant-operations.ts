import { randomUUID } from "node:crypto";
import {
  assistantWorkerCommandSchema,
  failure,
  type AssistantControlState,
  type AssistantEvidenceSource,
  type AssistantWorkerCommand,
  type Result,
  type UserSettings,
} from "@rewind/contracts";
import {
  AssistantReviewService,
  type AssistantDisclosureLease,
  type SessionCoordinator,
} from "@rewind/engine";
import {
  GeminiEvidenceAssistant,
  type GeminiEvidenceOptions,
} from "@rewind/assistant";
import type { SecureStorage } from "@rewind/storage";
import { AssistantCredentials } from "./assistant-credentials";

interface Options {
  storage: SecureStorage;
  coordinator: Pick<SessionCoordinator, "read">;
  available(): boolean;
  getSettings(): UserSettings;
  changePermission(
    enabled: boolean,
    current: () => boolean,
  ): Promise<Result<void>>;
  notify(): void;
  /** Trusted synthetic HTTP seam only; never populated from renderer or worker messages. */
  transport?: GeminiEvidenceOptions["transport"];
}
const denied = () =>
  failure(
    "FORBIDDEN",
    "Cloud approval or evidence changed. Prepare and approve a new review.",
  );
const busy = () =>
  failure(
    "CONFLICT",
    "A private assistant operation is still in progress. Stop it or wait before trying again.",
  );

/** Utility-only composition. Credentials and actual evidence never become model-granted capabilities. */
export class AssistantOperations {
  private readonly reviews: AssistantReviewService;
  private readonly credentials: AssistantCredentials;
  private apiKey: string | null = null;
  private permission = false;
  private revision = 0;
  private closed = false;
  private permissionWork = 0;
  private submitted = 0;
  private model: GeminiEvidenceAssistant | null = null;
  private lease: AssistantDisclosureLease | null = null;
  private asking: Promise<Result<unknown>> | null = null;
  constructor(private readonly options: Options) {
    this.reviews = new AssistantReviewService({
      newId: randomUUID,
      now: () => new Date().toISOString(),
      permitted: () => this.permitted(),
      settings: options.getSettings,
      read: (id) =>
        options.coordinator.read<AssistantEvidenceSource | null>(async () => {
          const cleaned = await options.storage.cleanup();
          if (!cleaned.ok) return cleaned;
          const result = await options.storage.evidence.getRetained(id);
          if (
            !result.ok ||
            !result.value ||
            result.value.event.type !== "file-change"
          )
            return result;
          const file = await options.storage.repositories.files.getReference(
            result.value.event.payload.fileId,
          );
          if (!file.ok) return file;
          return file.value
            ? { ok: true, value: { ...result.value, file: file.value } }
            : failure(
                "INTEGRITY_FAILURE",
                "The retained file observation has no matching identity.",
              );
        }),
      disclosable: (record) =>
        this.apiKey && JSON.stringify(record).includes(this.apiKey)
          ? failure("FORBIDDEN", "The selected observation cannot be shared.")
          : { ok: true, value: undefined },
    });
    this.credentials = new AssistantCredentials({
      store: options.storage.assistantCredential,
      quiesce: () => this.quiesce(),
    });
  }
  async initialize(): Promise<Result<void>> {
    if (this.closed) return denied();
    const result = await this.options.storage.assistantCredential.read();
    if (!result.ok) return result;
    if (this.closed) return denied();
    this.apiKey = result.value.apiKey;
    return { ok: true, value: undefined };
  }
  private permitted(): boolean {
    return (
      !this.closed &&
      this.options.available() &&
      this.permission &&
      this.options.getSettings().cloudAiEnabled &&
      this.apiKey !== null
    );
  }
  state(): AssistantControlState {
    return {
      configured: this.apiKey !== null,
      permission: this.permitted(),
      busy:
        this.asking !== null ||
        this.permissionWork > 0 ||
        this.credentials.busy,
      credentialPending: this.credentials.busy,
      revision: this.revision,
    };
  }
  private notify(): void {
    try {
      this.options.notify();
    } catch {
      /* Presentation cannot grant authority or undo a commit. */
    }
  }
  /** Synchronous: use before evidence/policy mutation, including the storage pre-commit hook. */
  invalidate(): void {
    this.revision++;
    this.reviews.invalidate();
    this.lease?.finish();
    this.model?.cancel();
    this.notify();
  }
  /** Synchronous denial precedes every asynchronous drain or settings write. */
  revoke(): void {
    this.permission = false;
    this.credentials.invalidate();
    this.invalidate();
  }
  private async quiesce(): Promise<Result<void>> {
    this.permission = false;
    this.invalidate();
    const revision = this.revision;
    const saved = await this.options.changePermission(
      false,
      () => revision === this.revision && !this.closed,
    );
    if (!saved.ok) return saved;
    const model = this.model;
    if (model) {
      const stopped = await model.close();
      if (!stopped.ok) return stopped;
      if (this.model === model) this.model = null;
    }
    return revision === this.revision && !this.closed
      ? { ok: true, value: undefined }
      : denied();
  }
  private async setPermission(
    enabled: boolean,
  ): Promise<Result<AssistantControlState>> {
    if (
      enabled &&
      (this.permissionWork || this.credentials.busy || this.asking)
    )
      return busy();
    this.permissionWork++;
    try {
      if (!enabled) this.revoke();
      const stopped = await this.quiesce();
      if (!stopped.ok) return stopped;
      if (!enabled) return { ok: true, value: this.state() };
      if (!this.apiKey || !this.options.available() || this.credentials.busy)
        return denied();
      const revision = this.revision;
      const current = () =>
        !this.closed && revision === this.revision && this.options.available();
      const changed = await this.options.changePermission(true, current);
      if (!changed.ok) return changed;
      if (!current()) return denied();
      this.permission = true;
      this.invalidate();
      return { ok: true, value: this.state() };
    } finally {
      this.permissionWork--;
      this.notify();
    }
  }
  private async ask(
    command: Extract<AssistantWorkerCommand, { kind: "assistant.ask" }>,
  ): Promise<Result<unknown>> {
    const revision = this.revision;
    const claimed = await this.reviews.claim(command.value);
    if (!claimed.ok) return claimed;
    const lease = claimed.value;
    try {
      if (revision !== this.revision || !this.permitted() || !lease.current())
        return denied();
      if (++this.submitted > 128)
        return failure(
          "STORAGE_LIMIT",
          "The cloud request limit for this service launch has been reached.",
        );
      this.lease = lease;
      if (!this.model)
        this.model = new GeminiEvidenceAssistant({
          apiKey: this.apiKey!,
          current: (id) =>
            this.permitted() &&
            this.lease?.request.id === id &&
            this.lease.current(),
          verify: (evidence) =>
            this.lease?.verify(evidence) ?? Promise.resolve(denied()),
          ...(this.options.transport
            ? { transport: this.options.transport }
            : {}),
        });
      const result = await this.model.ask(lease.request);
      if (!result.ok) return result;
      if (revision !== this.revision || !this.permitted() || !lease.current())
        return denied();
      return {
        ok: true,
        value: { answer: result.value, revision, expiresAt: lease.expiresAt },
      };
    } finally {
      lease.finish();
      if (this.lease === lease) this.lease = null;
    }
  }
  async execute(input: AssistantWorkerCommand): Promise<Result<unknown>> {
    const parsed = assistantWorkerCommandSchema.safeParse(input);
    if (!parsed.success)
      return failure(
        "INVALID_INPUT",
        "A bounded assistant command is required.",
      );
    if (this.closed) return denied();
    const command = parsed.data;
    try {
      switch (command.kind) {
        case "assistant.state":
          return { ok: true, value: this.state() };
        case "assistant.permission":
          return await this.setPermission(command.enabled);
        case "assistant.stop":
          this.invalidate();
          return { ok: true, value: true };
        case "assistant.cancel":
          return this.reviews.cancel(command.id);
        case "assistant.prepare": {
          if (this.credentials.busy || this.permissionWork || this.asking)
            return busy();
          if (this.apiKey && command.value.question.includes(this.apiKey))
            return denied();
          const revision = this.revision;
          const prepared = await this.reviews.prepare(command.value);
          return prepared.ok
            ? { ok: true, value: { review: prepared.value, revision } }
            : prepared;
        }
        case "assistant.ask": {
          if (this.credentials.busy || this.permissionWork || this.asking)
            return busy();
          const work = this.ask(command);
          this.asking = work;
          this.notify();
          try {
            return await work;
          } finally {
            if (this.asking === work) this.asking = null;
          }
        }
        case "assistant.credential.prepare":
          return await this.credentials.prepare(command.confirmed);
        case "assistant.credential.cancel":
          return this.credentials.cancel(command.id);
        case "assistant.credential.accept": {
          const result = await this.credentials.accept(
            command.value,
            command.confirmed,
          );
          if (!result.ok) return result;
          const loaded = await this.initialize();
          return loaded.ok ? { ok: true, value: this.state() } : loaded;
        }
        case "assistant.forget": {
          this.revoke();
          const result = await this.credentials.forget(command.confirmed);
          if (!result.ok) return result;
          this.apiKey = null;
          return { ok: true, value: this.state() };
        }
      }
    } catch {
      this.revoke();
      return failure(
        "UNAVAILABLE",
        "The private assistant operation could not be verified. Cloud approval was revoked.",
      );
    } finally {
      this.notify();
    }
  }
  async close(): Promise<Result<void>> {
    this.closed = true;
    this.revoke();
    this.reviews.close();
    const credentials = await this.credentials.close();
    if (!credentials.ok) return credentials;
    const model = await this.model?.close();
    if (model && !model.ok) return model;
    if (this.asking) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const done = await Promise.race([
          this.asking.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 2000);
          }),
        ]);
        if (!done)
          return failure(
            "UNAVAILABLE",
            "The assistant source request has not stopped. Retry shutdown.",
          );
      } finally {
        clearTimeout(timer);
      }
    }
    this.apiKey = null;
    return { ok: true, value: undefined };
  }
}
