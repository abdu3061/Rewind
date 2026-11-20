import { randomUUID } from "node:crypto";
import {
  documentParseReplySchema,
  documentParseRequestSchema,
  type DocumentFormat,
  type DocumentParseRequest,
  type DocumentPreviewIssue,
  type DocumentText,
} from "@rewind/contracts";

export interface DocumentChild {
  readonly pid: number | undefined;
  postMessage(value: DocumentParseRequest): void;
  on(event: "spawn", listener: () => void): this;
  on(event: "message", listener: (value: unknown) => void): this;
  on(event: "exit", listener: (code: number) => void): this;
  kill(): boolean;
}
export interface DocumentGuard {
  /** Actual helper process closure, not a kill/abort request. */
  closed: Promise<void>;
  close(): void;
}
interface Job {
  owner: AbortSignal | undefined;
  cancel: (reason: DocumentPreviewIssue) => void;
  done: Promise<void>;
}
interface Options {
  spawn: () => DocumentChild;
  admit: (
    pid: number,
    signal: AbortSignal,
    lost: () => void,
  ) => Promise<DocumentGuard | null>;
  deadlineMs?: number;
  exitTimeoutMs?: number;
}
const unavailable = (
  format: DocumentFormat,
  reason: DocumentPreviewIssue,
): DocumentText => ({ state: "unavailable", format, reason });
const wait = async (done: Promise<void>, timeout: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      done.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Main-owned transport/supervision only. No parsing, source paths, storage or keys. */
export class DocumentProcess {
  private job: Job | null = null;
  private closing = false;
  constructor(private readonly options: Options) {}
  get busy(): boolean {
    return this.job !== null;
  }
  async extract(
    format: DocumentFormat,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<DocumentText> {
    const id = randomUUID();
    if (
      !documentParseRequestSchema.safeParse({
        version: 1,
        type: "parse",
        id,
        format,
        bytes,
      }).success
    )
      return unavailable(format, "limit");
    if (this.closing || this.job) return unavailable(format, "unavailable");
    if (signal?.aborted) return unavailable(format, "cancelled");
    let child: DocumentChild;
    try {
      child = this.options.spawn();
    } catch {
      return unavailable(format, "unavailable");
    }
    const owned = Uint8Array.from(bytes),
      abort = new AbortController();
    let resolveExit!: () => void,
      resolveResult!: (value: DocumentText) => void,
      resolveDone!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const response = new Promise<DocumentText>((resolve) => {
      resolveResult = resolve;
    });
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let admission: Promise<DocumentGuard | null> | null = null,
      finished = false,
      spawned = false,
      sent = false;
    let denied: DocumentPreviewIssue | null = null;
    const job: Job = {
      owner: signal,
      cancel: (reason) => {
        denied = reason;
        finish(unavailable(format, reason));
      },
      done,
    };
    this.job = job;
    const timer = setTimeout(
      () => job.cancel("timeout"),
      this.options.deadlineMs ?? 12000,
    );
    const cancelled = () => job.cancel("cancelled");
    signal?.addEventListener("abort", cancelled, { once: true });
    const finish = (value: DocumentText) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      owned.fill(0);
      abort.abort();
      try {
        child.kill();
      } catch {
        /* The handle stays busy until exit. */
      }
      resolveResult(value);
      void Promise.all([
        exited,
        admission?.then(async (guard) => {
          try {
            guard?.close();
          } catch {
            /* Still wait for observed closure. */
          }
          await guard?.closed;
        }),
      ])
        .then(() => {
          if (this.job === job) this.job = null;
          resolveDone();
        })
        .catch(() => {
          /* Failed closure is not proof of exit; keep the job busy. */
        });
    };
    child.on("exit", () => {
      resolveExit();
      if (!finished) job.cancel("unavailable");
    });
    child.on("message", (raw) => {
      if (finished) return;
      if (!sent) return job.cancel("unavailable");
      const parsed = documentParseReplySchema.safeParse(raw);
      if (
        !parsed.success ||
        parsed.data.id !== id ||
        parsed.data.result.format !== format
      )
        return job.cancel("unavailable");
      finish(parsed.data.result);
    });
    child.on("spawn", () => {
      if (finished || spawned) return;
      spawned = true;
      const pid = child.pid;
      if (!Number.isSafeInteger(pid) || !pid || pid <= 0)
        return job.cancel("unavailable");
      admission = Promise.resolve()
        .then(() =>
          this.options.admit(pid, abort.signal, () => {
            if (!finished) job.cancel("unavailable");
          }),
        )
        .catch(() => null);
      void admission.then((guard) => {
        if (finished) return;
        if (!guard) return job.cancel("unavailable");
        // A close occurring after admission but before publication also cancels the job.
        void guard.closed.then(() => {
          if (!finished) job.cancel("unavailable");
        });
        try {
          sent = true;
          child.postMessage({
            version: 1,
            type: "parse",
            id,
            format,
            bytes: owned,
          });
        } catch {
          job.cancel("unavailable");
        } finally {
          owned.fill(0);
        }
      });
    });
    if (signal?.aborted) cancelled();
    const result = await response;
    return (await wait(done, this.options.exitTimeoutMs ?? 2000))
      ? signal?.aborted
        ? unavailable(format, "cancelled")
        : denied
          ? unavailable(format, denied)
          : result
      : unavailable(format, "unavailable");
  }
  async stop(owner?: AbortSignal): Promise<boolean> {
    const job = this.job;
    if (owner && job?.owner !== owner) return true;
    if (!job) return true;
    job.cancel("cancelled");
    return wait(job.done, this.options.exitTimeoutMs ?? 2000);
  }
  async close(): Promise<boolean> {
    this.closing = true;
    return this.stop();
  }
}
