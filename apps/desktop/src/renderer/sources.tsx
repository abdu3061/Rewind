import { useState } from "react";
import type { RuntimeSnapshot } from "@rewind/contracts";
import {
  AppWindowIcon,
  FolderSimpleIcon,
  GlobeIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import type { SettingsTab } from "./settings";

type Go = (page: "Files" | "Settings", tab?: SettingsTab) => void;

/**
 * One place to see every recording source and its permission. Presentation
 * only: each action calls the same engine command as before (ADR 0043).
 */
export function SourcesPanel({
  runtime,
  onGo,
}: {
  runtime: RuntimeSnapshot | null;
  onGo: Go;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = runtime?.service === "ready";
  const automatic = runtime?.automaticRecording === true;
  const windows = runtime?.preferences.collectionConsent ?? false;
  async function setWindows(consent: boolean) {
    setBusy(true);
    setError(null);
    try {
      // Saved exclusions are kept; they are edited in Settings › Recording.
      const result = await window.rewind.privacy.update({
        collectionConsent: consent,
        excludedApplications: runtime?.preferences.excludedApplications ?? [],
        excludedFolderPaths: runtime?.preferences.excludedFolderPaths ?? [],
      });
      if (!result.ok) setError(result.error.message);
    } catch {
      setError("Could not save recording preferences.");
    } finally {
      setBusy(false);
    }
  }
  const status = (on: boolean) =>
    on ? (automatic ? "On · automatic" : "On until restart") : "Off";
  return (
    <section className="panel sources" aria-labelledby="sources-heading">
      <h2 id="sources-heading">Recording sources</h2>
      <p className="hint">
        What Rewind may record. Nothing is captured unless a source is on and a
        session is active.
      </p>
      <ul className="source-list">
        <li>
          <AppWindowIcon size={20} aria-hidden="true" />
          <span className="row-main">
            <strong>Windows activity</strong>
            <small>App names, window titles and times</small>
          </span>
          <span className={windows ? "chip on" : "chip"}>
            {status(windows)}
          </span>
          {windows ? (
            <button
              className="danger"
              disabled={busy || (!ready && !runtime?.secureStorage)}
              onClick={() => void setWindows(false)}
            >
              Revoke recording permission
            </button>
          ) : (
            <button
              className="primary"
              disabled={busy || !ready}
              onClick={() => void setWindows(true)}
            >
              Allow Windows activity
            </button>
          )}
        </li>
        <li>
          <FolderSimpleIcon size={20} aria-hidden="true" />
          <span className="row-main">
            <strong>Protected files</strong>
            <small>New versions of files you save</small>
          </span>
          <span className={runtime?.filePermission ? "chip on" : "chip"}>
            {status(runtime?.filePermission ?? false)}
          </span>
          <button
            aria-label="Manage protected files"
            onClick={() => onGo("Files")}
          >
            Manage
          </button>
        </li>
        <li>
          <GlobeIcon size={20} aria-hidden="true" />
          <span className="row-main">
            <strong>Chrome and Edge</strong>
            <small>Title and website of the tab you're viewing</small>
          </span>
          <span className={runtime?.browserPermission ? "chip on" : "chip"}>
            {runtime?.browserPermission ? "On until restart" : "Off"}
          </span>
          <button
            aria-label="Manage browser activity"
            onClick={() => onGo("Settings", "Browsers")}
          >
            Manage
          </button>
        </li>
        <li>
          <SparkleIcon size={20} aria-hidden="true" />
          <span className="row-main">
            <strong>Gemini questions</strong>
            <small>Optional; you review every question first</small>
          </span>
          <span className={runtime?.assistant.permission ? "chip on" : "chip"}>
            {runtime?.assistant.permission ? "On until restart" : "Off"}
          </span>
          <button
            aria-label="Manage Gemini questions"
            onClick={() => onGo("Settings", "Gemini")}
          >
            Manage
          </button>
        </li>
      </ul>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
