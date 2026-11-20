import { useEffect, useRef, useState } from "react";
import {
  fileTextQuerySchema,
  type DocumentAuthority,
  type FileTextControlState,
  type FileTextQuery,
  type FileTextSearchReceipt,
  type Result,
  type RuntimeSnapshot,
  type TimelineQuery,
  type VersionPreview,
} from "@rewind/contracts";
import { currentPreview } from "./captured-preview";
import { usePreviewRequest } from "./use-preview-request";
import { RecoveryCopy } from "./recovery-copy";
import { RecoveryOverwrite } from "./recovery-overwrite";
import { HowItWorks, plural } from "./ui";

const matches = (a: DocumentAuthority, b: DocumentAuthority | undefined) =>
  Boolean(b && a.generation === b.generation && a.revision === b.revision);

/** Polls the captured-content index; calls onChange when indexed/unavailable counts move. */
function useIndexStatus(readable: boolean, onChange?: () => void) {
  const [status, setStatus] = useState<FileTextControlState | null>(null);
  const [error, setError] = useState("");
  const changed = useRef(onChange);
  changed.current = onChange;
  useEffect(() => {
    if (!readable) {
      setStatus(null);
      return;
    }
    let mounted = true,
      pending = false,
      previous = "";
    const poll = async () => {
      if (pending) return;
      pending = true;
      try {
        const result = await window.rewind.content.state();
        if (!mounted) return;
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        setStatus(result.value);
        const key = `${result.value.counts.indexed}:${result.value.counts.unavailable}`;
        if (previous && previous !== key) changed.current?.();
        previous = key;
      } catch {
        if (mounted)
          setError("Could not read captured-content indexing status.");
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [readable]);
  return { status, setStatus, error, setError };
}

/** Settings › Storage: index status and explicit indexing of retained history. */
export function SearchIndexSettings({
  runtime,
}: {
  runtime: RuntimeSnapshot | null;
}) {
  const readable = Boolean(runtime?.secureStorage && window.rewind?.content);
  const { status, setStatus, error, setError } = useIndexStatus(readable);
  const [retry, setRetry] = useState(false),
    [acting, setActing] = useState(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  async function act(
    operation: () => Promise<Result<FileTextControlState>>,
    failure: string,
  ) {
    setActing(true);
    setError("");
    try {
      const result = await operation();
      if (!live.current) return;
      if (result.ok) setStatus(result.value);
      else setError(result.error.message);
    } catch {
      if (live.current) setError(failure);
    } finally {
      if (live.current) setActing(false);
    }
  }
  return (
    <section className="panel" aria-labelledby="search-index-heading">
      <h2 id="search-index-heading">Search index</h2>
      <p>
        Lets Search look inside saved files. New versions are indexed
        automatically while file protection is on.
      </p>
      <HowItWorks>
        <p>
          Index saved content to catch up on older versions, even while
          recording is paused. This only reads Rewind's encrypted history; it
          doesn't start recording or use the cloud. Text and code files, DOCX
          body text and selectable PDF text are indexed, up to 64 KB and 50 PDF
          pages per file.
        </p>
      </HowItWorks>
      <p role="status" aria-label="Captured content index status">
        {!readable
          ? "Encrypted history is unavailable."
          : !status
            ? "Reading search index..."
            : `${status.counts.indexed} of ${status.counts.eligible} saved versions searchable · ${status.counts.pending} waiting · ${status.counts.unavailable} unreadable · ${status.indexing.busy ? `indexing (${status.indexing.processed} done)` : "idle"}`}
      </p>
      {status?.automaticPaused && (
        <p>
          Automatic indexing is paused until Rewind restarts. Choose Index saved
          content to resume it.
        </p>
      )}
      {status?.indexing.error && <p>{status.indexing.error.message}</p>}
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={retry}
          disabled={!readable || acting}
          onChange={(event) => setRetry(event.target.checked)}
        />
        Retry unavailable documents
      </label>
      <div className="controls">
        <button
          disabled={!readable || acting || status?.indexing.busy}
          onClick={() =>
            void act(
              () =>
                window.rewind.content.indexSaved({
                  confirmed: true,
                  retryFailures: retry,
                }),
              "Saved-content indexing could not be started.",
            )
          }
        >
          Index saved content
        </button>
        <button
          disabled={
            !readable ||
            acting ||
            (Boolean(status?.automaticPaused) && !status?.indexing.busy)
          }
          onClick={() =>
            void act(
              () => window.rewind.content.stop(),
              "Content indexing stop could not be confirmed. Try again.",
            )
          }
        >
          Stop content indexing
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}

export function ContentSearch({
  runtime,
  query,
}: {
  runtime: RuntimeSnapshot | null;
  query: TimelineQuery;
}) {
  const readable = Boolean(runtime?.secureStorage && window.rewind?.content);
  const authority = useRef(runtime?.documentAuthority);
  authority.current = runtime?.documentAuthority;
  const authorityKey = `${runtime?.documentAuthority.generation ?? ""}:${runtime?.documentAuthority.revision ?? ""}`;
  const [storedPage, setPage] = useState<FileTextSearchReceipt | null>(null);
  const [storedPreview, setPreview] = useState<VersionPreview | null>(null);
  const [before, setBefore] = useState<FileTextQuery["before"]>();
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const { status, error: statusError } = useIndexStatus(readable, () =>
    setRefresh((value) => value + 1),
  );
  const [searchError, setError] = useState("");
  const error = searchError || statusError;
  const live = useRef(true),
    querySerial = useRef(0),
    previewSerial = useRef(0);
  const { request, cancel, loading: previewLoading } = usePreviewRequest();
  const page =
    storedPage && matches(storedPage.authority, runtime?.documentAuthority)
      ? storedPage
      : null;
  const preview = currentPreview(storedPreview, runtime?.documentAuthority)
    ? storedPreview
    : null;
  const text = query.text?.trim() ?? "";
  const compatibleType = !query.types || query.types.includes("file-change");
  const filterKey = JSON.stringify({
    text,
    sessionId: query.sessionId,
    from: query.from,
    to: query.to,
    compatibleType,
  });
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      void window.rewind?.content?.clearSearch();
    };
  }, []);
  useEffect(() => {
    setBefore(undefined);
    setPage(null);
    setPreview(null);
    previewSerial.current++;
    void cancel();
  }, [filterKey, authorityKey, cancel]);
  useEffect(() => {
    const ticket = ++querySerial.current;
    setPage(null);
    setError("");
    if (!readable || !text || !compatibleType) {
      setLoading(false);
      if (readable) void window.rewind.content.clearSearch();
      return;
    }
    const parsed = fileTextQuerySchema.safeParse({
      text,
      limit: 25,
      ...(query.sessionId ? { sessionId: query.sessionId } : {}),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(before ? { before } : {}),
    });
    if (!parsed.success) {
      setError(
        "Captured text search accepts up to 500 characters and a valid date range.",
      );
      setLoading(false);
      return;
    }
    setLoading(true);
    void window.rewind.content
      .search(parsed.data)
      .then((result) => {
        if (!live.current || ticket !== querySerial.current) return;
        if (!result.ok) setError(result.error.message);
        else if (matches(result.value.authority, authority.current))
          setPage(result.value);
      })
      .catch(() => {
        if (live.current && ticket === querySerial.current)
          setError("Could not search verified captured text.");
      })
      .finally(() => {
        if (live.current && ticket === querySerial.current) setLoading(false);
      });
    return () => {
      querySerial.current = ticket + 1;
    };
  }, [
    readable,
    text,
    compatibleType,
    query.sessionId,
    query.from,
    query.to,
    before,
    refresh,
    authorityKey,
  ]);
  async function showPreview(id: string) {
    const ticket = ++previewSerial.current;
    setPreview(null);
    setError("");
    const result = await request(id);
    if (!live.current || ticket !== previewSerial.current) return;
    if (!result.ok) setError(result.error.message);
    else if (matches(result.value.authority, authority.current))
      setPreview(result.value);
  }
  function closePreview() {
    previewSerial.current++;
    setPreview(null);
    void cancel();
  }
  // Nothing to show until there is a query or indexing news.
  if (
    !text &&
    !preview &&
    !previewLoading &&
    !error &&
    !status?.indexing.busy &&
    !status?.automaticPaused
  )
    return null;
  return (
    <section className="panel" aria-labelledby="content-search-heading">
      <h3 id="content-search-heading">Inside saved files</h3>
      <HowItWorks>
        <p>
          Searches text and code files, DOCX body text and selectable PDF text,
          up to 64 KB and 50 PDF pages per file. Scanned text, images and layout
          aren't searchable. These results stay on this PC and are never shared
          with Gemini. Manage the search index in Settings › Storage.
        </p>
      </HowItWorks>
      {status?.indexing.busy && (
        <p role="status" className="hint">
          Indexing saved files… {status.indexing.processed} done so far.
        </p>
      )}
      {status?.automaticPaused && (
        <p className="hint">
          Automatic indexing is paused until Rewind restarts. Resume it in
          Settings › Storage.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!text ? (
        <p className="hint">
          Type in the search box above to look inside files.
        </p>
      ) : !compatibleType ? (
        <p className="hint">
          Set the type filter to Everything or Files to search inside files.
        </p>
      ) : (
        <p role="status" className="hint">
          {loading
            ? "Searching inside files..."
            : `${plural(page?.hits.length ?? 0, "file match", "file matches")}.`}
        </p>
      )}
      {page && (
        <>
          {page.hits.length === 0 && (
            <p className="hint">
              Files that are still waiting to be indexed, or couldn't be read,
              won't appear here.
            </p>
          )}
          <ol className="timeline-events" aria-label="Captured text results">
            {page.hits.map((hit) => (
              <li key={hit.version.id}>
                <strong>{hit.displayName}</strong>
                <p className="content-hash">{hit.sourceLabel}</p>
                <time>{new Date(hit.version.capturedAt).toLocaleString()}</time>
                <pre className="captured-preview">{hit.snippet}</pre>
                {hit.truncated && (
                  <p className="hint">
                    Only part of this file is searchable; the full file can
                    still be recovered.
                  </p>
                )}
                <button
                  disabled={previewLoading}
                  onClick={() => void showPreview(hit.version.id)}
                >
                  Preview {hit.displayName} from content search
                </button>
              </li>
            ))}
          </ol>
          <div className="controls">
            {before && (
              <button disabled={loading} onClick={() => setBefore(undefined)}>
                First captured text page
              </button>
            )}
            <button
              disabled={loading || !page.hasMore || !page.nextBefore}
              onClick={() => setBefore(page.nextBefore)}
            >
              Next captured text page
            </button>
          </div>
        </>
      )}
      {previewLoading && (
        <div role="status">
          Loading captured preview...{" "}
          <button onClick={closePreview}>Cancel content preview</button>
        </div>
      )}
      {preview && (
        <section aria-labelledby="content-preview-heading">
          <h3 id="content-preview-heading">Preview: {preview.displayName}</h3>
          <p className="content-hash">{preview.sourceLabel}</p>
          <HowItWorks summary="Details">
            <p className="content-hash">
              SHA-256: {preview.version.contentHash}
            </p>
          </HowItWorks>
          {preview.warning && <p>{preview.warning}</p>}
          {preview.text !== null && (
            <pre className="captured-preview">{preview.text}</pre>
          )}
          {preview.truncated && (
            <p className="hint">
              Preview shortened. Recovering uses the complete file.
            </p>
          )}
          <button onClick={closePreview}>Close content preview</button>
          <RecoveryCopy key={preview.version.id} preview={preview} />
          <RecoveryOverwrite
            key={`overwrite-${preview.version.id}`}
            preview={preview}
          />
        </section>
      )}
    </section>
  );
}
