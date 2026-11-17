import { useEffect, useState } from "react";
import type { Result, RuntimeSnapshot, StorageUsage } from "@rewind/contracts";

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
        Expired evidence is removed automatically at startup, before timeline
        queries and every minute while Rewind is open. Kept checkpoints retain
        their evidence. Under storage pressure, the oldest unkept evidence can
        expire sooner.
      </p>
      <p>
        Changing storage settings, cleaning up or deleting history stops
        recording and revokes this launch's approval. Approve and resume
        explicitly afterward.
      </p>
      {usage && (
        <p role="status">
          {(usage.totalBytes / 1024 ** 2).toFixed(2)} MiB used (
          {(usage.databaseBytes / 1024 ** 2).toFixed(2)} MiB database;{" "}
          {(usage.journalBytes / 1024 ** 2).toFixed(2)} MiB journal).{" "}
          {usage.activityCount} activities, {usage.versionCount} versions,{" "}
          {usage.keptCheckpointCount} kept checkpoints.
        </p>
      )}
      {usage?.overQuota && (
        <p role="alert" className="error">
          The quota is exceeded by retained evidence or database overhead.
          Recording cannot continue until space is available.
        </p>
      )}
      <div className="settings-list">
        <label>
          Data retention period (hours)
          <input
            aria-label="Data retention period"
            type="number"
            min={1}
            max={8760}
            value={hours}
            onChange={(event) => setHours(Number(event.target.value))}
          />
        </label>
        <label>
          Storage limit (MiB)
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
            Delete recorded evidence from every session? Kept checkpoints and
            their evidence remain unless you include them. Session dates and
            privacy settings remain.
          </p>
          <label>
            <input
              type="checkbox"
              checked={includeKept}
              onChange={(event) => setIncludeKept(event.target.checked)}
            />{" "}
            Also delete kept checkpoints and their evidence
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
      <p className="footnote">
        Logical deletion removes search indexes and compacts encrypted storage.
        It cannot guarantee forensic erasure on SSDs, OS backups, swap or
        external copies. The quota covers the database and its journals;
        temporary compaction can require additional disk space.
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
