import { useEffect, useState } from "react";
import type { Result, RuntimeSnapshot, StorageUsage } from "@rewind/contracts";
import { HowItWorks, formatBytes, plural } from "./ui";

export function StorageManagement({
  runtime,
}: {
  runtime: RuntimeSnapshot | null;
}) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [hours, setHours] = useState(72);
  const [limit, setLimit] = useState(2048);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [includeKept, setIncludeKept] = useState(false);
  const readable = Boolean(runtime?.secureStorage && window.rewind?.storage);
  useEffect(() => {
    let mounted = true;
    if (!readable) return;
    void window.rewind.storage
      .usage()
      .then((result) => {
        if (!mounted) return;
        if (result.ok) {
          setUsage(result.value);
          setHours(result.value.preferences.retentionHours);
          setLimit(result.value.preferences.storageLimitBytes / 1024 ** 2);
        } else setError(result.error.message);
      })
      .catch(() => {
        if (mounted) setError("Storage usage is unavailable.");
      });
    return () => {
      mounted = false;
    };
  }, [readable]);
  async function run(
    operation: () => Promise<Result<StorageUsage>>,
    success: string,
  ) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await operation();
      if (result.ok) {
        setUsage(result.value);
        setMessage(success);
        setConfirm(false);
      } else setError(result.error.message);
    } catch {
      setError("Storage operation could not be confirmed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel" aria-labelledby="storage-heading">
      <h2 id="storage-heading">History and storage</h2>
      <p>
        Old history is cleaned up automatically. Kept checkpoints are never
        cleaned up.
      </p>
      <p className="hint">
        Saving, cleaning up or deleting here stops recording and turns off
        automatic recording. You'll need to allow recording again afterward.
      </p>
      <HowItWorks>
        <p>
          Expired history is removed when Rewind starts and every minute while
          it's open. If storage runs low, the oldest history that isn't kept can
          be removed sooner.
        </p>
      </HowItWorks>
      {usage && (
        <p role="status">
          {formatBytes(usage.totalBytes)} used ·{" "}
          {plural(usage.activityCount, "activity", "activities")} ·{" "}
          {plural(usage.versionCount, "file version")} ·{" "}
          {plural(usage.keptCheckpointCount, "kept checkpoint")}
        </p>
      )}
      {usage?.overQuota && (
        <p role="alert" className="error">
          Storage is full. Recording can't continue until you free up space or
          raise the limit.
        </p>
      )}
      <div className="settings-list">
        <label>
          Keep history for (hours)
          <input
            aria-label="Data retention period"
            type="number"
            min={1}
            max={8760}
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
          />
          {hours >= 24 && (
            <span className="hint">
              {" "}
              ≈ {plural(Math.round((hours / 24) * 10) / 10, "day")}
            </span>
          )}
        </label>
        <label>
          Storage limit (MB)
          <input
            aria-label="Storage limit"
            type="number"
            min={16}
            max={2048}
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="controls">
        <button
          disabled={busy || !readable}
          onClick={() =>
            void run(
              () =>
                window.rewind.storage.update({
                  retentionHours: hours,
                  storageLimitBytes: limit * 1024 ** 2,
                }),
              "Storage settings saved and cleanup verified.",
            )
          }
        >
          Save storage settings
        </button>
        <button
          disabled={busy || !readable}
          onClick={() =>
            void run(() => window.rewind.storage.cleanup(), "Cleanup verified.")
          }
        >
          Clean up now
        </button>
        <button
          className="end-button"
          disabled={busy || !readable}
          onClick={() => setConfirm(true)}
        >
          Delete history…
        </button>
      </div>
      {confirm && (
        <div
          className="notice"
          role="group"
          aria-label="Confirm history deletion"
        >
          <p>
            Delete recorded history from every session? Kept checkpoints stay
            unless you include them. Session dates and privacy settings stay.
          </p>
          <p className="hint">
            Deleting removes search indexes and compacts the encrypted database.
            It can't guarantee forensic erasure from SSDs, Windows backups, swap
            files or copies made elsewhere.
          </p>
          <label>
            <input
              type="checkbox"
              checked={includeKept}
              onChange={(event) => setIncludeKept(event.target.checked)}
            />{" "}
            Also delete kept checkpoints
          </label>
          <div className="controls">
            <button
              className="end-button"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    window.rewind.storage.deleteHistory({
                      includeKept,
                      confirmed: true,
                    }),
                  "History deletion verified. Recording permission is off.",
                )
              }
            >
              Confirm deletion
            </button>
            <button disabled={busy} onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <p className="hint">
        The limit covers Rewind's database and its journal files. Cleanup can
        briefly need extra disk space.
      </p>
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
