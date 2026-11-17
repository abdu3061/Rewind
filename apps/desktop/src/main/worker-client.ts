import { randomUUID } from "node:crypto";
import {
  acknowledgementResponseSchema,
  boundedWorkerMessage,
  createDefaultSettings,
  failure,
  sessionResponseSchema,
  workerOutputSchema,
  type AppError,
  type Result,
  type RuntimeSnapshot,
  type SessionAction,
  type SessionState,
  type WorkerCommand,
  type WorkerInput,
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
  private failed = false;
  private revision = 0;
  private state: RuntimeSnapshot;
  constructor(private readonly options: WorkerClientOptions) {
    this.state = {
      service: "starting",
      collection: "off",
      session: null,
      preferences: {
        collectionConsent: false,
        excludedApplications: createDefaultSettings().excludedApplications,
      },
      secureStorage: false,
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
    this.failed = false;
    this.publish({
      ...this.state,
      service: "starting",
      collection: "off",
      secureStorage: false,
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
                });
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
    this.clearHeartbeat();
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.pendingKey?.fill(0);
    this.pendingKey = null;
    this.publish({
      ...this.state,
      service: "unavailable",
      collection: "unavailable",
      secureStorage: false,
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
        (message.state.collection === "active" &&
          (!message.state.secureStorage ||
            !message.state.preferences.collectionConsent ||
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
    } else {
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
      command.kind === "shutdown" ||
      (command.kind === "preferences.update" &&
        !command.value.collectionConsent) ||
      (command.kind === "session" &&
        (command.action === "pause" || command.action === "end"));
    const allowedRead =
      this.state.secureStorage &&
      ["timeline", "history", "preferences.get", "snapshot"].includes(
        command.kind,
      );
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
        this.options.requestTimeoutMs ?? 7000,
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
    if (!this.child) {
      if (this.startAttempt) {
        this.fail(unavailable().error);
        await this.startAttempt;
      }
      return { ok: true, value: undefined };
    }
    const response = await this.request(
      { kind: "shutdown" },
      acknowledgementResponseSchema,
    );
    if (!response.ok) return response;
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
    return this.start();
  }
}
