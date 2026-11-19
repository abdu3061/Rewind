import { createHash } from "node:crypto";
import {
  failure,
  documentPreviewLimits,
  fileTextCandidateSchema,
  fileTextExtractionSchema,
  fileTextFormat,
  fileTextRevision,
  fileTextRunScopeSchema,
  fileVersionSchema,
  timestampSchema,
  type AppError,
  type DocumentProcessor,
  type FileTextCandidate,
  type FileTextCandidateQuery,
  type FileTextExtraction,
  type FileTextIndexState,
  type FileTextRunScope,
  type FileTextWrite,
  type FileVersion,
  type Result,
} from "@rewind/contracts";

export interface FileTextIndexerOptions {
  now(): string;
  documents?: DocumentProcessor;
  next(
    query: FileTextCandidateQuery,
  ): Promise<Result<FileTextCandidate | null>>;
  /** Serialized retained-byte read; no live filesystem reads. The returned buffer is owned. */
  read(
    candidate: FileTextCandidate,
  ): Promise<Result<{ version: FileVersion; bytes: Uint8Array }>>;
  /** Reverify retained source/hash and call authorized again inside the encrypted transaction. */
  publish(
    write: FileTextWrite,
    authorized: () => boolean,
  ): Promise<Result<{ stored: boolean }>>;
  /** Current engine policy, including session/launch approval for automatic work. Never latch a grant. */
  authorized(scope: FileTextRunScope, candidate?: FileTextCandidate): boolean;
  onChanged?(state: FileTextIndexState): void;
}
interface Run {
  scope: FileTextRunScope;
  controller: AbortController;
  denied: boolean;
  done: Promise<void>;
  state: FileTextIndexState;
}
const idle = (): FileTextIndexState => ({
  mode: null,
  busy: false,
  processed: 0,
  indexed: 0,
  unavailable: 0,
  error: null,
});
const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

/** One bounded source at a time, outside the session coordinator while parsing. */
export class FileTextIndexer {
  private active: Run | null = null;
  private last = idle();
  private unconfirmed: AbortSignal | null = null;
  private confirmation = 0;
  private closing = false;
  constructor(private readonly options: FileTextIndexerOptions) {}
  state(): FileTextIndexState {
    return {
      ...(this.active?.state ?? this.last),
      busy: Boolean(this.active || this.unconfirmed),
    };
  }
  private changed(): void {
    try {
      this.options.onChanged?.(this.state());
    } catch {
      /* Observers cannot undo storage. */
    }
  }
  start(input: FileTextRunScope): Result<true> {
    const parsed = fileTextRunScopeSchema.safeParse(input);
    if (!parsed.success)
      return failure("INVALID_INPUT", "The content indexing scope is invalid.");
    if (this.closing)
      return failure("UNAVAILABLE", "Content indexing is shutting down.");
    if (this.active || this.unconfirmed)
      return failure(
        "CONFLICT",
        "Content indexing is still running or closing.",
      );
    if (!this.authorized(parsed.data))
      return failure(
        "FORBIDDEN",
        "Content indexing is not currently authorized.",
      );
    const run: Run = {
      scope: parsed.data,
      controller: new AbortController(),
      denied: false,
      done: Promise.resolve(),
      state: { ...idle(), mode: parsed.data.mode, busy: true },
    };
    this.active = run;
    run.done = Promise.resolve()
      .then(() => this.work(run))
      .catch(() => {
        run.state.error = failure(
          "UNAVAILABLE",
          "Content indexing could not finish.",
        ).error;
      })
      .finally(() => {
        this.last = { ...run.state, busy: false };
        if (this.active === run) this.active = null;
        this.changed();
      });
    this.changed();
    return { ok: true, value: true };
  }
  /** Synchronous authority revocation; safe inside a coordinator mutation callback. */
  invalidate(): void {
    if (!this.active) return;
    this.active.denied = true;
    this.active.controller.abort();
  }
  private current(run: Run, candidate?: FileTextCandidate): boolean {
    return (
      this.active === run &&
      !this.closing &&
      !run.denied &&
      !run.controller.signal.aborted &&
      this.authorized(run.scope, candidate)
    );
  }
  private authorized(
    scope: FileTextRunScope,
    candidate?: FileTextCandidate,
  ): boolean {
    try {
      return this.options.authorized(scope, candidate);
    } catch {
      return false;
    }
  }
  private async confirmStop(owner: AbortSignal): Promise<boolean> {
    const receipt = this.confirmation;
    let stopped = false;
    try {
      stopped = (await this.options.documents?.stop(owner)) ?? true;
    } catch {
      /* A failed stop is not evidence that the owned child has exited. */
    }
    const closed = stopped || this.confirmation > receipt;
    if (closed) {
      this.confirmation++;
      if (this.unconfirmed === owner) this.unconfirmed = null;
    } else this.unconfirmed = owner;
    return closed;
  }
  /** Confirms only the owning parser's stop. Never waits on queued reads inside their coordinator. */
  async stop(): Promise<boolean> {
    const owner = this.active?.controller.signal ?? this.unconfirmed;
    this.invalidate();
    const closed = owner ? await this.confirmStop(owner) : true;
    this.changed();
    return closed;
  }
  /** Await outside the coordinator queue, after stop, before closing its storage. */
  settled(): Promise<void> {
    return this.active?.done ?? Promise.resolve();
  }
  async close(): Promise<boolean> {
    this.closing = true;
    if (!(await this.stop())) return false;
    await this.settled();
    return this.unconfirmed === null;
  }
  private fail(run: Run, error: AppError): void {
    run.state.error = error;
  }
  private async work(run: Run): Promise<void> {
    let after: FileTextCandidateQuery["after"];
    while (this.current(run)) {
      const next = await this.options.next({
        ...run.scope.query,
        ...(after ? { after } : {}),
      });
      if (!this.current(run)) return;
      if (!next.ok) return this.fail(run, next.error);
      if (!next.value) return;
      const parsed = fileTextCandidateSchema.safeParse(next.value);
      if (!parsed.success)
        return this.fail(
          run,
          failure(
            "INTEGRITY_FAILURE",
            "The indexed source identity is invalid.",
          ).error,
        );
      const candidate = parsed.data,
        version = candidate.version,
        query = run.scope.query;
      if (
        version.capturedAt > query.through ||
        (after &&
          (version.capturedAt < after.capturedAt ||
            (version.capturedAt === after.capturedAt &&
              version.id <= after.id))) ||
        (query.sessionId && version.sessionId !== query.sessionId) ||
        (query.folderIds &&
          (!candidate.folderId ||
            !query.folderIds.includes(candidate.folderId)))
      )
        return this.fail(
          run,
          failure(
            "INTEGRITY_FAILURE",
            "The indexed source is outside the admitted scope.",
          ).error,
        );
      after = { capturedAt: version.capturedAt, id: version.id };
      if (this.current(run, candidate)) {
        const continued = await this.index(run, candidate);
        if (!continued) return;
      }
      // Even skipped or expired sources must yield to consent changes and queued session work.
      await yieldTurn();
    }
  }
  private async index(
    run: Run,
    candidate: FileTextCandidate,
  ): Promise<boolean> {
    const source = await this.options.read(candidate);
    if (!source.ok) {
      if (source.error.code === "NOT_FOUND") return true;
      if (this.current(run)) this.fail(run, source.error);
      return false;
    }
    const bytes = source.value.bytes;
    try {
      if (!this.current(run, candidate)) return false;
      const version = fileVersionSchema.safeParse(source.value.version);
      if (
        !version.success ||
        JSON.stringify(version.data) !== JSON.stringify(candidate.version) ||
        !(bytes instanceof Uint8Array) ||
        bytes.length > documentPreviewLimits.inputBytes ||
        bytes.length !== candidate.version.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !==
          candidate.version.contentHash
      ) {
        this.fail(
          run,
          failure(
            "INTEGRITY_FAILURE",
            "Captured bytes changed before text extraction.",
          ).error,
        );
        return false;
      }
      const format = fileTextFormat(candidate.version.mediaType);
      if (!format) {
        this.fail(
          run,
          failure(
            "INTEGRITY_FAILURE",
            "The indexing candidate format is unsupported.",
          ).error,
        );
        return false;
      }
      let extraction: FileTextExtraction;
      if (format === "utf8") {
        try {
          const truncated = bytes.length > documentPreviewLimits.textBytes;
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, documentPreviewLimits.textBytes),
            { stream: truncated },
          );
          extraction = {
            state: "available",
            format,
            text,
            truncated,
            pagesRead: null,
            totalPages: null,
          };
        } catch {
          extraction = { state: "unavailable", format, reason: "malformed" };
        }
      } else {
        const documents = this.options.documents;
        if (!documents || documents.busy) {
          this.fail(
            run,
            failure(
              "CONFLICT",
              "Document indexing is waiting for the preview processor.",
            ).error,
          );
          return false;
        }
        extraction = { state: "unavailable", format, reason: "unavailable" };
        try {
          const parsed = fileTextExtractionSchema.safeParse(
            await documents.extract(format, bytes, run.controller.signal),
          );
          if (parsed.success && parsed.data.format === format)
            extraction = parsed.data;
        } catch {
          /* A parser failure leaves the verified original recoverable. */
        }
        if (!(await this.confirmStop(run.controller.signal))) {
          this.fail(
            run,
            failure(
              "UNAVAILABLE",
              "The content parser did not confirm shutdown.",
            ).error,
          );
          return false;
        }
      }
      if (
        !this.current(run, candidate) ||
        (extraction.state === "unavailable" &&
          extraction.reason === "cancelled")
      )
        return false;
      const stamp = timestampSchema.safeParse(this.options.now());
      if (!stamp.success) {
        this.fail(
          run,
          failure("UNAVAILABLE", "Content indexing requires a valid timestamp.")
            .error,
        );
        return false;
      }
      const saved = await this.options.publish(
        {
          versionId: candidate.version.id,
          contentHash: candidate.version.contentHash,
          revision: fileTextRevision,
          extraction,
          indexedAt: stamp.data,
        },
        () => this.current(run, candidate),
      );
      if (!saved.ok) {
        if (saved.error.code === "NOT_FOUND") return true;
        if (this.current(run)) this.fail(run, saved.error);
        return false;
      }
      if (saved.value.stored) {
        run.state.processed++;
        if (extraction.state === "available") run.state.indexed++;
        else run.state.unavailable++;
        this.changed();
      }
      return true;
    } finally {
      if (bytes instanceof Uint8Array) bytes.fill(0);
    }
  }
}
