import { useEffect, useRef, useState } from "react";
import type {
  RecoveryCopyProposal,
  RecoveryCopyResult,
  VersionPreview,
} from "@rewind/contracts";

export function RecoveryCopy({ preview }: { preview: VersionPreview }) {
  const [proposal, setProposal] = useState<RecoveryCopyProposal | null>(null);
  const [receipt, setReceipt] = useState<RecoveryCopyResult | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const live = useRef(true),
    outstanding = useRef<string | null>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (outstanding.current)
        void window.rewind.recovery.cancel(outstanding.current);
    };
  }, []);
  async function choose() {
    setBusy(true);
    setError("");
    setReceipt(null);
    try {
      const result = await window.rewind.recovery.chooseCopy(
        preview.version.id,
      );
      if (!live.current) {
        if (result.ok && result.value)
          await window.rewind.recovery.cancel(result.value.id);
        return;
      }
      if (!result.ok) setError(result.error.message);
      else {
        setProposal(result.value);
        outstanding.current = result.value?.id ?? null;
      }
    } catch {
      if (live.current)
        setError("The recovery destination could not be prepared.");
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function confirm() {
    if (!proposal) return;
    setBusy(true);
    setError("");
    try {
      const result = await window.rewind.recovery.confirmCopy(
        proposal.id,
        true,
      );
      outstanding.current = null;
      if (!live.current) return;
      setProposal(null);
      if (result.ok) setReceipt(result.value);
      else setError(result.error.message);
    } catch {
      if (live.current)
        setError(
          "Recovery could not be confirmed. Check the chosen destination before retrying.",
        );
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function cancel() {
    if (!proposal) return;
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
      if (live.current) setError("Cancellation could not be confirmed.");
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return (
    <div className="recovery-copy">
      <h3>Recover as a separate copy</h3>
      <p>
        Choose a new filename. The complete verified original bytes will be
        saved, including content beyond this preview. Existing destinations are
        rejected. Overwrite recovery is not available yet.
      </p>
      <p>
        The saved copy is an ordinary file outside Rewind's encrypted history.
        Retention and history deletion do not delete recovered copies. Rewind
        does not open or run the recovered file.
      </p>
      {!proposal && (
        <button
          className="primary"
          disabled={busy}
          onClick={() => void choose()}
        >
          Choose recovery copy destination
        </button>
      )}
      {proposal && (
        <section aria-label="Review recovery copy" className="recovery-review">
          <h4>Review recovery copy</h4>
          <p>Captured source: {proposal.sourceLabel}</p>
          <p>
            Captured at {new Date(proposal.capturedAt).toLocaleString()} ·{" "}
            {proposal.byteLength.toLocaleString()} bytes
          </p>
          <p className="content-hash">SHA-256: {proposal.contentHash}</p>
          <p>
            New file: <strong>{proposal.destinationLabel}</strong>
          </p>
          <p>
            This confirmation expires at{" "}
            {new Date(proposal.expiresAt).toLocaleTimeString()}. The source and
            destination will be checked again before writing.
          </p>
          <div className="controls">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void confirm()}
            >
              Confirm save recovery copy
            </button>
            <button disabled={busy} onClick={() => void cancel()}>
              Cancel recovery copy
            </button>
          </div>
        </section>
      )}
      {busy && <p role="status">Verifying recovery operation…</p>}
      {receipt && (
        <p role="status">
          Recovery copy saved and verified: {receipt.destinationLabel} (
          {receipt.byteLength.toLocaleString()} bytes).
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
