import { useEffect, useRef, useState } from "react";
import {
  fileTextQuerySchema,
  type DocumentAuthority,
  type FileTextControlState,
  type FileTextQuery,
  type FileTextSearchReceipt,
  type RuntimeSnapshot,
  type TimelineQuery,
  type VersionPreview,
} from "@rewind/contracts";
import { currentPreview } from "./captured-preview";
import { usePreviewRequest } from "./use-preview-request";
import { RecoveryCopy } from "./recovery-copy";
import { RecoveryOverwrite } from "./recovery-overwrite";

const matches = (a: DocumentAuthority, b: DocumentAuthority | undefined) =>
  Boolean(b && a.generation === b.generation && a.revision === b.revision);
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
  const [status, setStatus] = useState<FileTextControlState | null>(null);
  const [storedPage, setPage] = useState<FileTextSearchReceipt | null>(null);
  const [storedPreview, setPreview] = useState<VersionPreview | null>(null);
  const [before, setBefore] = useState<FileTextQuery["before"]>();
  const [retry, setRetry] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false),
    [acting, setActing] = useState(false);
  const [error, setError] = useState("");
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
        if (previous && previous !== key) setRefresh((value) => value + 1);
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
  async function indexSaved() {
    setActing(true);
    setError("");
    try {
      const result = await window.rewind.content.indexSaved({
        confirmed: true,
        retryFailures: retry,
      });
      if (!live.current) return;
      if (result.ok) {
        setStatus(result.value);
        setRefresh((value) => value + 1);
      } else setError(result.error.message);
    } catch {
      if (live.current)
        setError("Saved-content indexing could not be started.");
    } finally {
      if (live.current) setActing(false);
    }
  }
  async function stopIndexing() {
    setActing(true);
    setError("");
    try {
      const result = await window.rewind.content.stop();
      if (!live.current) return;
      if (result.ok) setStatus(result.value);
      else setError(result.error.message);
    } catch {
      if (live.current)
        setError("Content indexing stop could not be confirmed. Try again.");
    } finally {
      if (live.current) setActing(false);
    }
  }
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
  return (
    <section className="panel" aria-labelledby="content-search-heading">
      <h3 id="content-search-heading">Captured file text</h3>
      <p>
        Search preserved text/code, DOCX body text and PDF selectable text using
        the session and date filters above. Only captured saved bytes are
        searched. Extraction is limited to 64 KiB and 50 PDF pages; scanned
        text, images and layout are unavailable. These local results are
        excluded from Gemini sharing.
      </p>
      <p>
        New captured versions are indexed during an approved active file
        session. Index saved content to process retained history locally,
        including while capture is paused. This reads encrypted saved versions
        and does not enable monitoring or cloud access.
      </p>
      <p role="status" aria-label="Captured content index status">
        {!readable
          ? "Verified encrypted history is unavailable."
          : !status
            ? "Reading content index..."
            : `${status.counts.indexed} of ${status.counts.eligible} supported saved versions indexed; ${status.counts.pending} pending; ${status.counts.unavailable} unavailable. ${status.indexing.busy ? `Indexing or closing: ${status.indexing.processed} processed in this pass.` : "Indexing is idle."}`}
      </p>
      {status?.automaticPaused && (
        <p>
          Automatic content indexing is paused for this launch. Index saved
          content to resume it.
        </p>
      )}
      {status?.indexing.error && <p>{status.indexing.error.message}</p>}
      <div className="controls">
        <label>
          <input
            type="checkbox"
            checked={retry}
            disabled={!readable || acting}
            onChange={(event) => setRetry(event.target.checked)}
          />{" "}
          Retry unavailable documents
        </label>
        <button
          disabled={!readable || acting || status?.indexing.busy}
          onClick={() => void indexSaved()}
        >
          Index saved content
        </button>
        <button
          disabled={
            !readable ||
            acting ||
            (Boolean(status?.automaticPaused) && !status?.indexing.busy)
          }
          onClick={() => void stopIndexing()}
        >
          Stop content indexing
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!text ? (
        <p>Enter keywords in Search history above to search captured text.</p>
      ) : !compatibleType ? (
        <p>
          Choose All recorded types or Saved file changes to include captured
          text.
        </p>
      ) : (
        <p role="status">
          {loading
            ? "Searching captured text..."
            : `${page?.hits.length ?? 0} captured text results shown.`}
        </p>
      )}
      {page && (
        <>
          {page.hits.length === 0 && (
            <p>
              No indexed captured text matches this page. Pending or unavailable
              extraction can leave saved versions without searchable text.
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
                  <p>
                    Searchable text is truncated; the complete captured original
                    remains available.
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
          <h3 id="content-preview-heading">
            Captured preview: {preview.displayName}
          </h3>
          <p className="content-hash">{preview.sourceLabel}</p>
          <p className="content-hash">SHA-256: {preview.version.contentHash}</p>
          {preview.warning && <p>{preview.warning}</p>}
          {preview.text !== null && (
            <pre className="captured-preview">{preview.text}</pre>
          )}
          {preview.truncated && (
            <p>Preview truncated. Complete original bytes remain captured.</p>
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
