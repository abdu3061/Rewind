import { randomUUID } from "node:crypto";
import {
  documentRelayReplySchema,
  documentRelayRequestSchema,
  type DocumentFormat,
  type DocumentPreviewIssue,
  type DocumentProcessor,
  type DocumentRelayRequest,
  type DocumentText,
} from "@rewind/contracts";

interface Pending {
  id: string;
  format: DocumentFormat;
  deny: () => void;
  finish: (value: DocumentText) => void;
}
interface Stop {
  id: string;
  promise: Promise<boolean>;
  finish: (closed: boolean) => void;
}
const unavailable = (
  format: DocumentFormat,
  reason: DocumentPreviewIssue,
): DocumentText => ({ state: "unavailable", format, reason });

/** Recording-worker side of the private relay. No parsing and no assumption that abort means exit. */
export class RecordingDocumentClient implements DocumentProcessor {
  private pending: Pending | null = null;
  private stopping: Stop | null = null;
  private unconfirmed = false;
  private confirmation = 0;
  get busy(): boolean {
    return Boolean(this.pending || this.stopping || this.unconfirmed);
  }
  constructor(
    private readonly send: (request: DocumentRelayRequest) => void,
    private readonly timeouts = { parse: 18000, stop: 4000 },
  ) {}
  async extract(
    format: DocumentFormat,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<DocumentText> {
    if (this.pending || this.stopping || this.unconfirmed)
      return unavailable(format, "unavailable");
    if (signal?.aborted) return unavailable(format, "cancelled");
    const request = documentRelayRequestSchema.safeParse({
      version: 1,
      type: "document-parse",
      id: randomUUID(),
      format,
      bytes,
    });
    if (!request.success) return unavailable(format, "limit");
    return new Promise<DocumentText>((resolve) => {
      let denied = false;
      const timer = setTimeout(() => {
        this.unconfirmed = true;
        pending.finish(unavailable(format, "timeout"));
      }, this.timeouts.parse);
      const abort = () => {
        pending.deny();
        void this.stop();
      };
      const pending: Pending = {
        id: request.data.id,
        format,
        deny: () => {
          denied = true;
        },
        finish: (value) => {
          if (this.pending !== pending) return;
          this.pending = null;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          resolve(
            denied || signal?.aborted
              ? unavailable(format, "cancelled")
              : value,
          );
        },
      };
      this.pending = pending;
      signal?.addEventListener("abort", abort, { once: true });
      try {
        this.send(request.data);
      } catch {
        this.unconfirmed = true;
        pending.finish(unavailable(format, "unavailable"));
      }
      if (signal?.aborted) abort();
    });
  }
  stop(): Promise<boolean> {
    this.pending?.deny();
    if (this.stopping) return this.stopping.promise;
    if (!this.pending && !this.unconfirmed) return Promise.resolve(true);
    const id = randomUUID();
    const confirmation = this.confirmation;
    let resolve!: (closed: boolean) => void;
    const promise = new Promise<boolean>((done) => {
      resolve = done;
    });
    const timer = setTimeout(() => stopping.finish(false), this.timeouts.stop);
    const stopping: Stop = {
      id,
      promise,
      finish: (closed) => {
        if (this.stopping !== stopping) return;
        this.stopping = null;
        clearTimeout(timer);
        closed ||= this.confirmation > confirmation;
        this.unconfirmed = !closed;
        if (closed) this.confirmation++;
        if (closed && this.pending)
          this.pending.finish(unavailable(this.pending.format, "cancelled"));
        resolve(closed);
      },
    };
    this.stopping = stopping;
    try {
      this.send({ version: 1, type: "document-stop", id });
    } catch {
      stopping.finish(false);
    }
    return promise;
  }
  receive(raw: unknown): boolean {
    const parsed = documentRelayReplySchema.safeParse(raw);
    if (!parsed.success) return false;
    const message = parsed.data;
    if (message.type === "document-stopped") {
      if (message.id !== this.stopping?.id) return false;
      this.stopping.finish(message.closed);
      return true;
    }
    const pending = this.pending;
    if (
      !pending ||
      pending.id !== message.id ||
      pending.format !== message.result.format
    )
      return false;
    this.unconfirmed = !message.closed;
    if (message.closed) this.confirmation++;
    pending.finish(
      message.closed
        ? message.result
        : unavailable(pending.format, "unavailable"),
    );
    return true;
  }
}
