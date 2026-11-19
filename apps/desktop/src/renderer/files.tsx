import { useEffect, useRef, useState } from "react";
import { RecoveryCopy } from "./recovery-copy";
import { RecoveryOverwrite } from "./recovery-overwrite";
import { currentPreview } from "./captured-preview";
import { usePreviewRequest } from "./use-preview-request";
import type {
  CapturedVersionSummary,
  FileProtectionState,
  Result,
  RuntimeSnapshot,
  VersionPreview,
} from "@rewind/contracts";

export function Files({ runtime }: { runtime: RuntimeSnapshot | null }) {
  const {
    request: requestPreview,
    cancel: cancelPreview,
    loading: previewLoading,
  } = usePreviewRequest();
  const [protection, setProtection] = useState<FileProtectionState | null>(
    null,
  );
  const [versions, setVersions] = useState<CapturedVersionSummary[]>([]);
  const [storedPreview, setPreview] = useState<VersionPreview | null>(null);
  const preview = currentPreview(storedPreview, runtime?.documentAuthority)
    ? storedPreview
    : null;
  const authority = useRef(runtime?.documentAuthority);
  authority.current = runtime?.documentAuthority;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [more, setMore] = useState(false);
  const live = useRef(true),
    serial = useRef(0),
    older = useRef(false),
    previewSerial = useRef(0);
  const readable = Boolean(
    runtime?.secureStorage && window.rewind?.files && window.rewind?.versions,
  );
  useEffect(() => {
    previewSerial.current++;
    setPreview(null);
    void cancelPreview();
  }, [
    runtime?.documentAuthority.generation,
    runtime?.documentAuthority.revision,
    cancelPreview,
  ]);
  async function refresh(reset = false) {
    const ticket = ++serial.current;
    const [state, history] = await Promise.all([
      window.rewind.files.state(),
      reset || !older.current
        ? window.rewind.versions.list({ limit: 50 })
        : Promise.resolve(null),
    ]);
    if (!live.current || ticket !== serial.current) return;
    if (state.ok) setProtection(state.value);
    else setError(state.error.message);
    if (history?.ok) {
      setVersions(history.value);
      setMore(history.value.length === 50);
    } else if (history) setError(history.error.message);
  }
  useEffect(() => {
    live.current = true;
    serial.current++;
    previewSerial.current++;
    if (!readable) return;
    const load = () => {
      void refresh().catch(() => {
        if (live.current)
          setError("File protection status could not be loaded.");
      });
    };
    load();
    const timer = setInterval(load, 2000);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, [readable]);
  async function run(
    operation: () => Promise<Result<unknown>>,
    success: string,
  ) {
    setBusy(true);
    setError("");
    setMessage("");
    serial.current++;
    try {
      const result = await operation();
      if (!live.current) return;
      if (result.ok) {
        older.current = false;
        await refresh(true);
        setMessage(success);
      } else setError(result.error.message);
    } catch {
      if (live.current) setError("File operation could not be confirmed.");
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function showPreview(id: string) {
    const ticket = ++previewSerial.current;
    setError("");
    setPreview(null);
    try {
      const result = await requestPreview(id);
      if (!live.current || ticket !== previewSerial.current) return;
      if (result.ok && currentPreview(result.value, authority.current))
        setPreview(result.value);
      else if (result.ok)
        setError(
          "History changed while preparing the preview. Select the version again.",
        );
      else setError(result.error.message);
    } catch {
      if (live.current) setError("The captured preview could not be verified.");
    }
  }
  useEffect(() => {
    const id = preview?.version.id;
    if (!id || !readable) return;
    let mounted = true,
      checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const result = await window.rewind.versions.info(id);
        if (!mounted) return;
        if (!result.ok || !result.value) {
          setPreview(null);
          setMessage(
            "The preview is no longer available from verified retained history.",
          );
        }
      } catch {
        if (mounted) setPreview(null);
      } finally {
        checking = false;
      }
    };
    const timer = setInterval(() => void check(), 2000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [preview?.version.id, readable]);
  async function loadOlder() {
    const last = versions.at(-1)?.version;
    if (!last) return;
    setBusy(true);
    older.current = true;
    serial.current++;
    try {
      const result = await window.rewind.versions.list({
        limit: 50,
        before: { capturedAt: last.capturedAt, id: last.id },
      });
      if (!live.current) return;
      if (result.ok) {
        setVersions((current) => [...current, ...result.value]);
        setMore(result.value.length === 50);
      } else setError(result.error.message);
    } catch {
      if (live.current) setError("Older captures could not be loaded.");
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <>
      <section className="panel" aria-labelledby="file-protection-heading">
        <h2 id="file-protection-heading">Protected folders</h2>
        <p>
          {runtime?.automaticRecording
            ? "Automatic setup protects the verified folders below during active sessions. Manage file or folder exclusions in Settings. Revoke or Remove also turns off future automatic recording."
            : "Enable automatic recording on Dashboard to protect Desktop, Documents and Downloads without selecting folders. You can also choose project folders here and approve capture for this launch."}{" "}
          Changing protected folders pauses recording, revokes file approval and
          turns off automatic recording until you approve the new scope.
        </p>
        <p>
          Rewind captures complete saved bytes for supported text/code,
          Markdown, DOCX and PDF files up to 16 MiB when they are created or
          changed during recording. Existing files are not imported. Repeated
          save notifications are batched; unchanged content is not copied again.
          The first recovery copy is the saved version after a change. Earlier,
          paused or uncaptured work cannot be recovered.
        </p>
        <p>
          During an approved active session, bounded saved text is also indexed
          in encrypted local history. Search shows progress, limits, Stop and
          retained-history indexing controls. Document bodies are excluded from
          Gemini sharing.
        </p>
        <div className="controls">
          <button
            disabled={busy || !readable}
            onClick={() =>
              void run(
                () => window.rewind.files.selectFolder(),
                "Folder selection finished. File capture needs explicit approval.",
              )
            }
          >
            Select protected folder
          </button>
          {!runtime?.filePermission ? (
            <button
              className="primary"
              disabled={busy || !readable || !protection?.folders.length}
              onClick={() =>
                void run(
                  () => window.rewind.files.permission(true),
                  "File capture approved for this launch. Start or resume the session explicitly.",
                )
              }
            >
              Allow file protection for this launch
            </button>
          ) : (
            <button
              className="end-button"
              disabled={busy || !readable}
              onClick={() =>
                void run(
                  () => window.rewind.files.permission(false),
                  "File protection permission revoked. Capture has stopped.",
                )
              }
            >
              Revoke file protection
            </button>
          )}
        </div>
        <p role="status">
          File permission {runtime?.filePermission ? "approved" : "off"}.
          Capture {protection?.status.state ?? "unavailable"}.{" "}
          {protection
            ? `${protection.status.captured} captures confirmed this run; ${protection.status.pending} pending; ${protection.status.skipped} skipped; ${protection.status.failed} failed.`
            : ""}
        </p>
        {protection?.status.issue && (
          <p role="alert" className="error">
            {protection.status.issue}
          </p>
        )}
        <ul className="protected-folders">
          {protection?.folders.map((folder) => (
            <li key={folder.id}>
              <span>{folder.absolutePath}</span>
              <button
                disabled={busy || !readable}
                aria-label={`Remove protected folder ${folder.absolutePath}`}
                onClick={() =>
                  void run(
                    () => window.rewind.files.removeFolder(folder.id),
                    "Folder removed from protection. Existing captured versions follow retention settings.",
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <p className="footnote">
          Local NTFS folders and paths up to 240 characters. Hidden files, build
          trees, reparse points, hardlinks, application profiles and unsupported
          files are skipped or rejected. A directory replacement requires
          selecting it again. File saves do not prove that a document was read.
          {runtime?.automaticRecording
            ? " Automatic setup remembers approval for normal app openings."
            : " Manual approval expires on restart."}
        </p>
        {message && <p role="status">{message}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
      <section className="panel" aria-labelledby="versions-heading">
        <h2 id="versions-heading">Captured file versions</h2>
        <button
          disabled={busy || !readable}
          onClick={() => {
            older.current = false;
            void refresh(true).catch(() =>
              setError("Captured versions could not be refreshed."),
            );
          }}
        >
          Refresh versions
        </button>
        {!versions.length && (
          <p>
            No captured versions are available. Metadata-only observations are
            not recoverable files.
          </p>
        )}
        <ol className="timeline-events" aria-label="Captured versions">
          {versions.map((item) => (
            <li key={item.version.id} data-testid="captured-version">
              <strong>{item.displayName}</strong>
              <p className="content-hash">{item.sourceLabel}</p>
              <time dateTime={item.version.capturedAt}>
                {new Date(item.version.capturedAt).toLocaleString()}
              </time>
              <p>
                {item.version.byteLength.toLocaleString()} original bytes ·{" "}
                {item.version.mediaType}
              </p>
              <button
                disabled={busy || !readable}
                onClick={() => void showPreview(item.version.id)}
                aria-label={`Preview ${item.displayName} captured ${item.version.capturedAt}`}
              >
                Preview captured version
              </button>
            </li>
          ))}
        </ol>
        {more && (
          <button disabled={busy || !readable} onClick={() => void loadOlder()}>
            Load older versions
          </button>
        )}
      </section>
      {previewLoading && (
        <section className="panel">
          <p role="status">Preparing captured preview…</p>
          <button
            onClick={() => {
              previewSerial.current++;
              setPreview(null);
              void cancelPreview().then((result) => {
                if (!result.ok && live.current) setError(result.error.message);
              });
            }}
          >
            Cancel preview
          </button>
        </section>
      )}
      {preview && readable && (
        <section className="panel" aria-labelledby="preview-heading">
          <h2 id="preview-heading">Captured preview: {preview.displayName}</h2>
          <p className="content-hash">{preview.sourceLabel}</p>
          <p>
            {new Date(preview.version.capturedAt).toLocaleString()} ·{" "}
            {preview.version.byteLength.toLocaleString()} verified original
            bytes
          </p>
          <p className="content-hash">SHA-256: {preview.version.contentHash}</p>
          {preview.warning && <p>{preview.warning}</p>}
          {preview.text !== null && (
            <pre className="captured-preview">{preview.text}</pre>
          )}
          {preview.truncated && (
            <p>
              Preview truncated. The complete original bytes remain in the
              captured version.
            </p>
          )}
          <button
            onClick={() => {
              previewSerial.current++;
              setPreview(null);
              void cancelPreview();
            }}
          >
            Close preview
          </button>
          <RecoveryCopy key={preview.version.id} preview={preview} />
          <RecoveryOverwrite
            key={`overwrite-${preview.version.id}`}
            preview={preview}
          />
        </section>
      )}
    </>
  );
}
