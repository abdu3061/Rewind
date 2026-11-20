import { useEffect, useRef, useState } from "react";
import { RecoveryCopy } from "./recovery-copy";
import { RecoveryOverwrite } from "./recovery-overwrite";
import { currentPreview } from "./captured-preview";
import { usePreviewRequest } from "./use-preview-request";
import { EmptyState, HowItWorks, formatBytes, plural } from "./ui";
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
          Rewind saves a version of a supported file each time it changes while
          you're recording.
          {runtime?.automaticRecording
            ? " Automatic recording protects the folders below."
            : " Turn on automatic recording on the Dashboard, or add project folders here."}
        </p>
        <p className="hint">
          Adding or removing a folder pauses recording and turns off automatic
          recording until you allow the new set of folders.
        </p>
        <HowItWorks summary="What's supported">
          <p>
            Text and code, Markdown, DOCX and PDF files up to 16 MB, on local
            NTFS drives with paths under 240 characters. Existing files aren't
            imported, and unchanged content isn't copied again. Work from before
            recording, while paused or never saved can't be recovered.
          </p>
          <p>
            Hidden files, build folders, links/junctions, app profiles and
            unsupported files are skipped. If a folder is replaced, select it
            again. A saved file doesn't prove a document was read.
            {runtime?.automaticRecording
              ? " Automatic setup remembers your permission."
              : " Manual permission ends when Rewind restarts."}
          </p>
          <p>
            Saved text is indexed locally so Search can find it. File contents
            are never shared with Gemini.
          </p>
        </HowItWorks>
        <div className="controls">
          <button
            disabled={busy || !readable}
            onClick={() =>
              void run(
                () => window.rewind.files.selectFolder(),
                "Folder added. Allow file protection to start saving versions.",
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
                  "File protection allowed until Rewind restarts. Start or resume a session to begin.",
                )
              }
            >
              Allow file protection
            </button>
          ) : (
            <button
              className="end-button"
              disabled={busy || !readable}
              onClick={() =>
                void run(
                  () => window.rewind.files.permission(false),
                  "File protection is off. Capture has stopped.",
                )
              }
            >
              Revoke file protection
            </button>
          )}
        </div>
        <p role="status" className="hint">
          File protection {runtime?.filePermission ? "on" : "off"} · capture{" "}
          {protection?.status.state ?? "unavailable"}
          {protection
            ? ` · ${plural(protection.status.captured, "version")} saved since Rewind opened${protection.status.pending ? `, ${protection.status.pending} waiting` : ""}${protection.status.skipped ? `, ${protection.status.skipped} skipped` : ""}${protection.status.failed ? `, ${protection.status.failed} failed` : ""}`
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
                    "Folder removed. Versions already saved stay until they expire.",
                  )
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        {message && <p role="status">{message}</p>}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
      <section className="panel" aria-labelledby="versions-heading">
        <h2 id="versions-heading">Saved file versions</h2>
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
          <EmptyState title="No saved versions yet">
            Versions appear here when protected files change while you're
            recording.
          </EmptyState>
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
                {formatBytes(item.version.byteLength)} ·{" "}
                {item.version.mediaType}
              </p>
              <button
                disabled={busy || !readable}
                onClick={() => void showPreview(item.version.id)}
                aria-label={`Preview ${item.displayName} captured ${item.version.capturedAt}`}
              >
                Preview
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
          <h2 id="preview-heading">Preview: {preview.displayName}</h2>
          <p className="content-hash">{preview.sourceLabel}</p>
          <p>
            {new Date(preview.version.capturedAt).toLocaleString()} ·{" "}
            {formatBytes(preview.version.byteLength)} · verified
          </p>
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
