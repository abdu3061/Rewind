import { useEffect, useState } from "react";
import type {
  AutomaticRecordingState,
  RuntimeSnapshot,
} from "@rewind/contracts";

export function RecordingSetup({
  runtime,
}: {
  runtime: RuntimeSnapshot | null;
}) {
  const [setup, setSetup] = useState<AutomaticRecordingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (runtime?.service !== "ready" || !window.rewind?.recording) return;
    let mounted = true;
    void window.rewind.recording
      .state()
      .then((result) => {
        if (!mounted) return;
        if (result.ok) setSetup(result.value);
        else setError(result.error.message);
      })
      .catch(() => {
        if (mounted) setError("Recording setup could not be loaded.");
      });
    return () => {
      mounted = false;
    };
  }, [
    runtime?.service,
    runtime?.automaticRecording,
    runtime?.automaticRecordingIssue,
  ]);
  if (!window.rewind?.recording) return null;
  const enabled = runtime?.automaticRecording === true;
  async function configure(value = !enabled) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await window.rewind.recording.configure(value, true);
      if (result.ok) setSetup(result.value);
      else setError(result.error.message);
    } catch {
      setError("Recording setup could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="panel recording-setup"
      aria-labelledby="automatic-recording-heading"
    >
      <p className="eyebrow">ONE-TIME SETUP</p>
      <h2 id="automatic-recording-heading">
        {enabled
          ? "Automatic recording is on"
          : "Let Rewind remember your work"}
      </h2>
      {!enabled && (
        <p>
          Rewind records which apps and window titles you use, and saves a new
          version of supported files whenever you create or change them in
          Desktop, Documents and Downloads. Titles and files can contain
          sensitive information.
        </p>
      )}
      <p>
        You approve once on this Windows account. Recording then starts each
        time you open Rewind; Pause or End stops it, and turning this off stops
        future automatic starts.
      </p>
      <details className="how-it-works" open={!enabled}>
        <summary>What's included</summary>
        <div>
          {setup?.locations.length ? (
            <ul aria-label="Automatic file protection locations">
              {setup.locations.map((location) => (
                <li key={location.name}>
                  <strong>{location.name}</strong>: {location.path}
                </li>
              ))}
            </ul>
          ) : null}
          <p>
            Folders you added in Files are included too. Existing files aren't
            imported. Saved versions stay encrypted on this PC and are cleaned
            up by your storage settings.
          </p>
          <p>
            Not captured: keystrokes, screenshots, unsaved edits, hidden or
            system files, caches and unsupported file types. Very large bursts
            of changes can exceed capture limits. Exclude apps, files or folders
            in Settings; browser and Gemini are set up separately.
          </p>
        </div>
      </details>
      {enabled &&
        (!runtime?.preferences.collectionConsent ||
          !runtime?.filePermission) && (
          <p role="status">
            Recording was paused after an interruption or a settings change.
            Check the locations above, then turn it back on.
          </p>
        )}
      {enabled &&
        (!runtime?.preferences.collectionConsent ||
          !runtime?.filePermission) && (
          <button
            className="primary"
            disabled={busy || runtime?.service !== "ready"}
            onClick={() => void configure(true)}
          >
            Re-enable approved recording
          </button>
        )}
      <button
        className={enabled ? "end-button" : "primary"}
        disabled={busy || !setup || runtime?.service !== "ready"}
        onClick={() => void configure()}
      >
        {busy
          ? "Updating recording..."
          : enabled
            ? "Turn off automatic recording"
            : "Allow and start recording"}
      </button>
      {enabled && (
        <p role="status">
          {runtime?.collection === "active"
            ? "Recording this session."
            : "Not recording right now. Start or resume a session to continue."}
        </p>
      )}
      {(runtime?.automaticRecordingIssue || setup?.issue) && (
        <p role="status">{runtime?.automaticRecordingIssue ?? setup?.issue}</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
