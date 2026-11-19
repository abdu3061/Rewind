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
          ? "Automatic recording is enabled"
          : "Let Rewind remember your work"}
      </h2>
      {!enabled && (
        <p>
          With your approval, Rewind records app names, window titles and times,
          and saves recovery versions of supported files you create or change
          during recording in Desktop, Documents and Downloads. Existing files
          are not imported. No app or folder selection is needed. Titles and
          saved files can contain sensitive information.
        </p>
      )}
      <p>
        Approval is remembered on this Windows account. Rewind starts recording
        when you open it. Pause or End stops this session; turning off automatic
        recording prevents future automatic starts.
      </p>
      <details open={!enabled}>
        <summary>Protected locations and capture limits</summary>
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
          Previously added folders in Files are included too. Add app, file or
          folder exclusions in Settings.
        </p>
        <p className="footnote">
          Saved versions stay encrypted locally and follow your storage and
          retention limits. Unsaved edits, screenshots and keystrokes are not
          captured. Hidden files, system folders, caches and unsupported files
          are skipped; large bursts of changes can exceed capture limits.
          Browser recording and Gemini need separate setup.
        </p>
      </details>
      {enabled &&
        (!runtime?.preferences.collectionConsent ||
          !runtime?.filePermission) && (
          <p role="status">
            Recording approval was not renewed after an interruption or settings
            change. Review your protected locations above, then re-enable
            recording when ready.
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
            ? "Recording this session. Manage exclusions in Settings and captured versions in Files."
            : "This session is stopped or paused. Use Start or Resume to continue; Rewind starts automatically on its next normal opening."}
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
