import { useEffect, useRef, useState } from "react";
import type {
  RecoveryOverwriteProposal,
  RecoveryOverwriteResult,
  VersionPreview,
} from "@rewind/contracts";

export function RecoveryOverwrite({ preview }: { preview: VersionPreview }) {
  const [proposal, setProposal] = useState<RecoveryOverwriteProposal | null>(
      null,
    ),
    [receipt, setReceipt] = useState<RecoveryOverwriteResult | null>(null),
    [attempt, setAttempt] = useState<RecoveryOverwriteProposal | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const live = useRef(true),
    outstanding = useRef<string | null>(null),
    pending = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (outstanding.current)
        void window.rewind.recovery.cancel(outstanding.current);
    };
  }, []);
  async function choose() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setReceipt(null);
    setAttempt(null);
    try {
      const result = await window.rewind.recovery.chooseOverwrite(
        preview.version.id,
      );
      if (!live.current) {
        if (result.ok && result.value)
          await window.rewind.recovery.cancel(result.value.id);
        return;
      }
      if (result.ok) {
        setProposal(result.value);
        outstanding.current = result.value?.id ?? null;
      } else setError(result.error.message);
    } catch {
      if (live.current) setError("The existing target could not be reviewed.");
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function confirm() {
    if (!proposal || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setAttempt(proposal);
    outstanding.current = null;
    try {
      const result = await window.rewind.recovery.confirmOverwrite(
        proposal.id,
        true,
      );
      if (!live.current) return;
      setProposal(null);
      if (result.ok) setReceipt(result.value);
      else setError(result.error.message);
    } catch {
      if (live.current) {
        setProposal(null);
        setError(
          "Overwrite could not be confirmed. Inspect the reviewed target and preservation filename before retrying.",
        );
      }
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  async function cancel() {
    if (!proposal || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await window.rewind.recovery.cancel(proposal.id);
      if (!live.current) return;
      if (result.ok) {
        outstanding.current = null;
        setProposal(null);
      } else setError(result.error.message);
    } catch {
      if (live.current)
        setError("Recovery cancellation could not be confirmed.");
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }
  return (
    <details className="recovery-copy">
      <summary>Optional: overwrite an existing file</summary>
      <p>
        Choose an existing file to replace with this captured version. Close
        editors using that file first. Rewind checks its current contents again
        and refuses changed or locked targets.
      </p>
      <p>
        Before writing, Rewind saves and verifies the current bytes as a
        separate preservation file in the target folder. This is an ordinary
        file outside encrypted history; retention and history deletion do not
        remove it. Keep it until you have checked the recovery.
      </p>
      <p>
        An interrupted write can leave an incomplete target. The verified
        preservation file remains available to recover the current bytes. Rewind
        does not open or run either file.
      </p>
      {!proposal && (
        <button disabled={busy} onClick={() => void choose()}>
          Choose existing file for overwrite
        </button>
      )}
      {proposal && (
        <section
          aria-label="Review overwrite recovery"
          className="recovery-review"
        >
          <h4>Review overwrite recovery</h4>
          <p>Captured source: {proposal.sourceLabel}</p>
          <p>
            Captured at {new Date(proposal.capturedAt).toLocaleString()};{" "}
            {proposal.byteLength.toLocaleString()} bytes.
          </p>
          <p className="content-hash">
            Captured SHA-256: {proposal.contentHash}
          </p>
          <p>
            Replace: <strong>{proposal.destinationLabel}</strong>
          </p>
          <p>
            Current file: {proposal.currentByteLength.toLocaleString()} bytes.
          </p>
          <p className="content-hash">
            Current SHA-256: {proposal.currentContentHash}
          </p>
          <p>
            Preserve current bytes first as:{" "}
            <strong>{proposal.preservationLabel}</strong>
          </p>
          <p>
            This review expires at{" "}
            {new Date(proposal.expiresAt).toLocaleTimeString()}. Preservation
            must succeed before the existing file changes.
          </p>
          <div className="controls">
            <button disabled={busy} onClick={() => void confirm()}>
              Confirm preserve current file and overwrite
            </button>
            <button disabled={busy} onClick={() => void cancel()}>
              Cancel overwrite recovery
            </button>
          </div>
        </section>
      )}
      {busy && <p role="status">Verifying recovery operation…</p>}
      {receipt && (
        <div role="status">
          <p>
            Overwrite saved and verified: {receipt.destinationLabel} (
            {receipt.byteLength.toLocaleString()} bytes).
          </p>
          <p>
            Current bytes preserved and verified: {receipt.preservationLabel} (
            {receipt.preservedByteLength.toLocaleString()} bytes).
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {error && attempt && (
        <p>
          Reviewed preservation filename:{" "}
          <strong>{attempt.preservationLabel}</strong>. Inspect this file and
          the target before another recovery.
        </p>
      )}
    </details>
  );
}
