import { useCallback, useEffect, useRef, useState } from "react";
import { failure, type Result, type VersionPreview } from "@rewind/contracts";

/** Owns this screen's request IDs; stale unmount cancellation cannot stop a newer screen. */
export function usePreviewRequest() {
  const pending = useRef<string | null>(null),
    closing = useRef<Promise<Result<true>> | null>(null),
    serial = useRef(0),
    live = useRef(true);
  const [loading, setLoading] = useState(false);
  const stop = useCallback((requestId: string) => {
    const operation = window.rewind.versions
      .cancelPreview(requestId)
      .catch(() =>
        failure(
          "UNAVAILABLE",
          "Preview cancellation could not be confirmed. Try again.",
        ),
      );
    closing.current = operation;
    void operation
      .then((result) => {
        if (!result.ok && !pending.current) pending.current = requestId;
      })
      .finally(() => {
        if (closing.current === operation) closing.current = null;
      });
    return operation;
  }, []);
  const cancel = useCallback((): Promise<Result<true>> => {
    serial.current++;
    setLoading(false);
    const requestId = pending.current;
    pending.current = null;
    return requestId
      ? stop(requestId)
      : (closing.current ?? Promise.resolve({ ok: true, value: true }));
  }, [stop]);
  const request = useCallback(
    async (versionId: string): Promise<Result<VersionPreview>> => {
      const ticket = ++serial.current,
        previous = pending.current;
      pending.current = null;
      setLoading(true);
      try {
        const close = previous ? stop(previous) : closing.current;
        if (close) {
          const closed = await close;
          if (!closed.ok) return closed;
        }
        if (!live.current || ticket !== serial.current)
          return failure("CONFLICT", "Captured preview was cancelled.");
        const requestId = crypto.randomUUID();
        pending.current = requestId;
        const result = await window.rewind.versions.preview(
          versionId,
          requestId,
        );
        return live.current && ticket === serial.current
          ? result
          : failure("CONFLICT", "Captured preview was cancelled.");
      } catch {
        return failure(
          "UNAVAILABLE",
          "The captured preview could not be verified.",
        );
      } finally {
        // Keep the owned ID until close/replacement: a reply may report an unconfirmed process exit.
        if (live.current && ticket === serial.current) setLoading(false);
      }
    },
    [stop],
  );
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      serial.current = serial.current + 1;
      const requestId = pending.current;
      pending.current = null;
      if (requestId) void stop(requestId);
    };
  }, [stop]);
  return { request, cancel, loading };
}
