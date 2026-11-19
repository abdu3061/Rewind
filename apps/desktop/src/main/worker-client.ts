import { randomUUID } from "node:crypto";
import {
  acknowledgementResponseSchema,
  boundedWorkerMessage,
  createDefaultSettings,
  failure,
  sessionResponseSchema,
  workerOutputSchema,
  workerDocumentOutputSchema,
  workerInputSchema,
  type AppError,
  type Result,
  type RuntimeSnapshot,
  type SessionAction,
  type SessionState,
  type WorkerCommand,
  type WorkerInput,
  type BrowserAssetsLocation,
  type AutomaticFolder,
  type DocumentProcessor,
} from "@rewind/contracts";

export interface WorkerTransport {
  postMessage(message: WorkerInput): void;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  on(event: "spawn", listener: () => void): this;
  kill(): boolean;
}
interface Decoder<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: Result<T> } | { success: false };
}
interface Pending {
  kind: WorkerCommand["kind"];
  resolve: (result: Result<unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface WorkerClientOptions {
  root: string;
  synthetic: boolean;
  automaticFolders?: AutomaticFolder[];
  browserAssets?: BrowserAssetsLocation;
  assistantFixture?: true;
  documents?: DocumentProcessor & { readonly busy: boolean };
  loadKey: () => Promise<Result<Uint8Array>>;
  spawn: () => WorkerTransport;
  onSnapshot: (state: RuntimeSnapshot) => void;
  onActivity: (sessionId: string) => void;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}
const unavailable = () =>
  failure(
    "UNAVAILABLE",
    "The secure recording service is unavailable. Collection is disabled.",
  );

/** Main owns liveness, deadlines and generation fencing; it never performs SQL or collection. */
export class WorkerClient {
  private child: WorkerTransport | null = null;
  private bootId = randomUUID();
  private readonly pending = new Map<string, Pending>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingKey: Uint8Array | null = null;
  private startAttempt: Promise<Result<RuntimeSnapshot>> | null = null;
  private readyWaiter: ((value: Result<RuntimeSnapshot>) => void) | null = null;
  private exitWaiter: (() => void) | null = null;
  private exitPromise: Promise<void> = Promise.resolve();
  private shutdownAcknowledged = false;
  private documentRequest: string | null = null;
  private documentClosing = false;
  private failed = false;
  private initialBoot = true;
  private revision = 0;
  private state: RuntimeSnapshot;
  constructor(private readonly options: WorkerClientOptions) {
    this.state = {
      documentAuthority: { generation: this.bootId, revision: 0 },
      assistant: {
        generation: this.bootId,
        configured: false,
        permission: false,
        busy: false,
        credentialPending: false,
        revision: 0,
      },
      service: "starting",
      collection: "off",
      session: null,
      preferences: {
        collectionConsent: false,
        excludedApplications: createDefaultSettings().excludedApplications,
      },
      secureStorage: false,
      filePermission: false,
      browserPermission: false,
      synthetic: options.synthetic,
      error: null,
      revision: 0,
    };
  }
  getSnapshot(): RuntimeSnapshot {
    return structuredClone(this.state);
  }
  getState(): SessionState {
    return { session: this.state.session ? { ...this.state.session } : null };
  }
  private publish(next: RuntimeSnapshot): void {
    this.state = { ...structuredClone(next), revision: ++this.revision };
    try {
      this.options.onSnapshot(this.getSnapshot());
    } catch {
      /* UI observers cannot grant authority. */
    }
  }
  start(): Promise<Result<RuntimeSnapshot>> {
    if (this.state.service === "ready" && this.child)
      return Promise.resolve({ ok: true, value: this.getSnapshot() });
    if (this.startAttempt) return this.startAttempt;
    if (this.child)
      return Promise.resolve(
        failure("UNAVAILABLE", "The previous worker has not terminated."),
      );
    this.bootId = randomUUID();
    const boot = this.bootId;
    this.shutdownAcknowledged = false;
    this.documentClosing = false;
    this.failed = false;
    this.publish({
      ...this.state,
      service: "starting",
      documentAuthority: { generation: this.bootId, revision: 0 },
      assistant: {
        generation: this.bootId,
        configured: false,
        permission: false,
        busy: false,
        credentialPending: false,
        revision: 0,
      },
      collection: "off",
      secureStorage: false,
      filePermission: false,
      browserPermission: false,
      error: null,
      preferences: { ...this.state.preferences, collectionConsent: false },
    });
    this.startAttempt = new Promise<Result<RuntimeSnapshot>>((resolve) => {
      this.readyWaiter = resolve;
      this.startupTimer = setTimeout(
        () =>
          this.fail({
            code: "UNAVAILABLE",
            message: "The recording worker did not become ready.",
          }),
        this.options.startupTimeoutMs ?? 10000,
      );
      void this.options
        .loadKey()
        .then((result) => {
          if (boot !== this.bootId || this.state.service !== "starting") {
            if (result.ok) result.value.fill(0);
            return;
          }
          if (!result.ok) {
            this.fail(result.error);
            return;
          }
          this.pendingKey = result.value;
          try {
            const child = this.options.spawn();
            this.child = child;
            this.exitPromise = new Promise<void>((done) => {
              this.exitWaiter = done;
            });
            child.on("message", (message) => {
              if (this.child === child) this.receive(message);
            });
            child.on("exit", () => {
              if (this.child !== child) return;
              this.child = null;
              this.clearHeartbeat();
              this.pendingKey?.fill(0);
              this.pendingKey = null;
              this.exitWaiter?.();
              this.exitWaiter = null;
              if (!this.shutdownAcknowledged && !this.failed)
                this.fail({
                  code: "UNAVAILABLE",
                  message:
                    "The recording worker stopped unexpectedly. Re-authorize after reconnecting.",
                });
            });
            child.on("spawn", () => {
              if (
                this.child !== child ||
                boot !== this.bootId ||
                this.state.service !== "starting" ||
                !this.pendingKey
              )
                return;
              const key = new Uint8Array(this.pendingKey);
              try {
                child.postMessage({
                  type: "init",
                  version: 1,
                  bootId: boot,
                  root: this.options.root,
                  key,
                  synthetic: this.options.synthetic,
                  automaticStart: this.initialBoot,
                  ...(this.options.automaticFolders
                    ? { automaticFolders: this.options.automaticFolders }
                    : {}),
                  ...(this.options.assistantFixture
                    ? { assistantFixture: true as const }
                    : {}),
                  ...(this.options.browserAssets
                    ? { browserAssets: this.options.browserAssets }
                    : {}),
                });
                this.initialBoot = false;
              } catch {
                this.fail(unavailable().error);
              } finally {
                key.fill(0);
                this.pendingKey?.fill(0);
                this.pendingKey = null;
              }
            });
            this.heartbeat = setInterval(() => {
              try {
                if (this.child === child)
                  child.postMessage({
                    type: "heartbeat",
                    version: 1,
                    bootId: boot,
                  });
              } catch {
                this.fail(unavailable().error);
              }
            }, 1000);
          } catch {
            this.fail(unavailable().error);
          }
        })
        .catch(() => {
          if (boot === this.bootId) this.fail(unavailable().error);
        });
    }).finally(() => {
      this.startAttempt = null;
    });
    return this.startAttempt;
  }
  private clearHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
  private fail(error: AppError): void {
    this.failed = true;
    void this.options.documents?.stop().catch(() => false);
    this.clearHeartbeat();
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.pendingKey?.fill(0);
    this.pendingKey = null;
    this.publish({
      ...this.state,
      service: "unavailable",
      documentAuthority: {
        generation: this.bootId,
        revision: this.state.documentAuthority.revision + 1,
      },
      assistant: {
        ...this.state.assistant,
        permission: false,
        busy: false,
        credentialPending: false,
      },
      collection: "unavailable",
      secureStorage: false,
      filePermission: false,
      browserPermission: false,
      preferences: { ...this.state.preferences, collectionConsent: false },
      error,
    });
    const failed = { ok: false as const, error };
    this.readyWaiter?.(failed);
    this.readyWaiter = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(failed);
    }
    this.pending.clear();
    // Keep the handle until exit is observed; a retry cannot overlap a surviving worker.
    try {
      this.child?.kill();
    } catch {
      /* Liveness remains unavailable; never report a successful stop. */
    }
  }
  private receive(value: unknown): void {
    if (this.failed) return;
    if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      (value.type === "document-parse" || value.type === "document-stop")
    ) {
      const parsed = workerDocumentOutputSchema.safeParse(value);
      if (!parsed.success) {
        this.fail({
          code: "INTEGRITY_FAILURE",
          message: "The worker returned an invalid private document request.",
        });
        return;
      }
      const message = parsed.data;
      if (message.bootId !== this.bootId) {
        if (message.type === "document-parse") message.bytes.fill(0);
        return;
      }
      const child = this.child;
      const send = (reply: WorkerInput) => {
        if (
          child !== this.child ||
          message.bootId !== this.bootId ||
          this.failed
        )
          return;
        if (!workerInputSchema.safeParse(reply).success) {
          this.fail({
            code: "INTEGRITY_FAILURE",
            message: "The document service returned an invalid private reply.",
          });
          return;
        }
        try {
          child?.postMessage(reply);
        } catch {
          this.fail(unavailable().error);
        }
      };
      if (message.type === "document-stop") {
        void (this.options.documents?.stop() ?? Promise.resolve(true))
          .catch(() => false)
          .then((closed) =>
            send({
              version: 1,
              type: "document-stopped",
              bootId: message.bootId,
              id: message.id,
              closed,
            }),
          );
        return;
      }
      if (
        this.documentClosing ||
        this.documentRequest ||
        this.state.service !== "ready" ||
        !this.state.secureStorage ||
        !this.options.documents
      ) {
        message.bytes.fill(0);
        send({
          version: 1,
          type: "document-result",
          bootId: message.bootId,
          id: message.id,
          result: {
            state: "unavailable",
            format: message.format,
            reason: "unavailable",
          },
          closed: !this.documentRequest && !this.options.documents?.busy,
        });
        return;
      }
      this.documentRequest = message.id;
      void this.options.documents
        .extract(message.format, message.bytes)
        .catch(() => ({
          state: "unavailable" as const,
          format: message.format,
          reason: "unavailable" as const,
        }))
        .then((result) =>
          send({
            version: 1,
            type: "document-result",
            bootId: message.bootId,
            id: message.id,
            result,
            closed: !this.options.documents!.busy,
          }),
        )
        .finally(() => {
          message.bytes.fill(0);
          if (this.documentRequest === message.id) this.documentRequest = null;
        });
      return;
    }
    if (!boundedWorkerMessage(value)) {
      this.fail({
        code: "INTEGRITY_FAILURE",
        message: "The worker returned an oversized message.",
      });
      return;
    }
    const parsed = workerOutputSchema.safeParse(value);
    if (!parsed.success) {
      this.fail({
        code: "INTEGRITY_FAILURE",
        message: "The worker returned an invalid message.",
      });
      return;
    }
    const message = parsed.data;
    if (message.bootId !== this.bootId) return;
    if (message.type === "fault") {
      this.fail(message.error);
      return;
    }
    if (message.type === "ready") {
      if (
        this.state.service !== "starting" ||
        message.state.service !== "ready" ||
        !message.state.secureStorage ||
        message.state.collection !== "off" ||
        message.state.preferences.collectionConsent ||
        message.state.filePermission ||
        message.state.browserPermission ||
        message.state.assistant.permission ||
        message.state.assistant.busy ||
        message.state.assistant.credentialPending ||
        message.state.synthetic !== this.options.synthetic
      ) {
        this.fail({
          code: "INTEGRITY_FAILURE",
          message:
            "The worker did not start with secure storage and collection disabled.",
        });
        return;
      }
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.startupTimer = null;
      this.publish(message.state);
      this.readyWaiter?.({ ok: true, value: this.getSnapshot() });
      this.readyWaiter = null;
    } else if (message.type === "snapshot") {
      if (
        message.state.synthetic !== this.options.synthetic ||
        (message.state.assistant.permission &&
          (!message.state.assistant.configured ||
            !message.state.secureStorage ||
            message.state.service !== "ready")) ||
        (message.state.collection === "active" &&
          (!message.state.secureStorage ||
            (!message.state.preferences.collectionConsent &&
              !message.state.filePermission &&
              !message.state.browserPermission) ||
            message.state.service !== "ready"))
      ) {
        this.fail({
          code: "INTEGRITY_FAILURE",
          message: "The worker returned an inconsistent recording state.",
        });
        return;
      }
      if (this.state.service !== "starting" && !this.shutdownAcknowledged)
        this.publish(message.state);
    } else if (message.type === "activity") {
      try {
        this.options.onActivity(message.sessionId);
      } catch {
        /* Notifications carry no authority. */
      }
    } else if (message.type === "reply") {
      const pending = this.pending.get(message.id);
      if (!pending || pending.kind !== message.kind) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message.result);
    }
  }
  async request<T>(
    command: WorkerCommand,
    decoder: Decoder<T>,
  ): Promise<Result<T>> {
    const allowedStop =
      (command.kind === "recording.configure" && !command.enabled) ||
      command.kind === "content.stop" ||
      command.kind === "content.clear-search" ||
      command.kind === "versions.cancel-preview" ||
      command.kind === "assistant.stop" ||
      command.kind === "assistant.forget" ||
      command.kind === "assistant.cancel" ||
      command.kind === "assistant.credential.cancel" ||
      (command.kind === "assistant.permission" && !command.enabled) ||
      (command.kind === "browser.permission" && !command.enabled) ||
      command.kind === "shutdown" ||
      command.kind === "storage.delete" ||
      command.kind === "storage.update" ||
      command.kind === "storage.cleanup" ||
      command.kind === "files.remove" ||
      command.kind === "files.add" ||
      (command.kind === "files.permission" && !command.enabled) ||
      (command.kind === "preferences.update" &&
        !command.value.collectionConsent) ||
      (command.kind === "session" &&
        (command.action === "pause" || command.action === "end"));
    const allowedRead =
      this.state.secureStorage &&
      [
        "content.state",
        "recording.state",
        "content.search",
        "timeline",
        "history",
        "preferences.get",
        "snapshot",
        "storage.usage",
        "files.state",
        "browser.state",
        "assistant.state",
        "versions.list",
        "versions.preview",
        "versions.source",
        "versions.info",
        "recovery.prepare-copy",
        "recovery.confirm-copy",
        "recovery.prepare-overwrite",
        "recovery.confirm-overwrite",
        "recovery.cancel",
        "checkpoints.create",
        "checkpoints.view",
        "checkpoints.list",
        "checkpoints.update",
        "checkpoints.delete",
      ].includes(command.kind);
    if (this.pending.size >= 64 && allowedStop) {
      // Stop authority cannot wait behind a saturated public request map.
      this.fail({
        code: "UNAVAILABLE",
        message:
          "The recording service was stopped after control queue overload. Reconnect and re-authorize.",
      });
      return unavailable();
    }
    if (
      this.failed ||
      !this.child ||
      (this.state.service !== "ready" && !allowedStop && !allowedRead) ||
      this.pending.size >= 64
    )
      return unavailable();
    const id = randomUUID();
    const result = await new Promise<Result<unknown>>((resolve) => {
      const timer = setTimeout(
        () =>
          this.fail({
            code: "UNAVAILABLE",
            message: "The recording service did not acknowledge the operation.",
          }),
        this.options.requestTimeoutMs ??
          (command.kind === "assistant.ask"
            ? 40000
            : command.kind === "versions.preview" ||
                command.kind === "shutdown" ||
                command.kind === "content.index" ||
                command.kind === "content.search"
              ? 20000
              : command.kind === "assistant.credential.prepare"
                ? 20000
                : command.kind === "recovery.confirm-copy" ||
                    command.kind === "recovery.confirm-overwrite" ||
                    command.kind === "recovery.prepare-overwrite"
                  ? 20000
                  : [
                        "recording.configure",
                        "browser.install",
                        "browser.remove",
                        "browser.repair",
                      ].includes(command.kind)
                    ? 60000
                    : 7000),
      );
      this.pending.set(id, { kind: command.kind, resolve, timer });
      try {
        this.child!.postMessage({
          type: "command",
          version: 1,
          bootId: this.bootId,
          id,
          command,
        });
      } catch {
        this.fail(unavailable().error);
      }
    });
    const parsed = decoder.safeParse(result);
    if (!parsed.success) {
      this.fail({
        code: "INTEGRITY_FAILURE",
        message: "The worker returned an invalid response.",
      });
      return unavailable();
    }
    return parsed.data;
  }
  execute(action: SessionAction): Promise<Result<SessionState>> {
    return this.request({ kind: "session", action }, sessionResponseSchema);
  }
  async shutdown(): Promise<Result<void>> {
    this.documentClosing = true;
    if (!this.child) {
      if (this.startAttempt) {
        this.fail(unavailable().error);
        await this.startAttempt;
      }
      const closed = await this.options.documents?.stop();
      return closed === false ? unavailable() : { ok: true, value: undefined };
    }
    const response = await this.request(
      { kind: "shutdown" },
      acknowledgementResponseSchema,
    );
    const documentsClosed = await this.options.documents?.stop();
    if (!response.ok) return response;
    if (documentsClosed === false) return unavailable();
    this.shutdownAcknowledged = true;
    this.clearHeartbeat();
    try {
      if (!this.child?.kill()) return unavailable();
    } catch {
      return unavailable();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exited = await Promise.race([
        this.exitPromise.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      if (!exited) return unavailable();
      this.publish({
        ...this.state,
        service: "stopping",
        collection: "off",
        secureStorage: false,
        filePermission: false,
        browserPermission: false,
      });
      return { ok: true, value: undefined };
    } finally {
      clearTimeout(timer);
    }
  }
  async retry(): Promise<Result<RuntimeSnapshot>> {
    if (this.child && this.state.service !== "ready") {
      try {
        this.child.kill();
      } catch {
        return unavailable();
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const exited = await Promise.race([
          this.exitPromise.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), 2000);
          }),
        ]);
        if (!exited) return unavailable();
      } finally {
        clearTimeout(timer);
      }
    }
    if ((await this.options.documents?.stop()) === false) return unavailable();
    return this.start();
  }
}
