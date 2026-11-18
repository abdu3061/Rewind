import { useEffect, useRef, useState } from "react";
import type {
  AssistantAnswerReceipt,
  AssistantEvidence,
  AssistantReviewReceipt,
  Result,
  RuntimeSnapshot,
} from "@rewind/contracts";

export function AssistantSettings({
  runtime,
}: {
  runtime: RuntimeSnapshot | null;
}) {
  const state = runtime?.assistant;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [remove, setRemove] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function run(action: "configure" | "allow" | "deny" | "forget") {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result =
        action === "configure"
          ? await window.rewind.assistant.configure(true)
          : action === "forget"
            ? await window.rewind.assistant.forget(true)
            : await window.rewind.assistant.permission(action === "allow");
      if (!mounted.current) return;
      if (!result.ok) setError(result.error.message);
      else {
        setRemove(false);
        setMessage(
          action === "configure"
            ? result.value === null
              ? "Credential entry cancelled."
              : "Key saved in encrypted local storage. Cloud approval is still off."
            : action === "forget"
              ? "Saved key removed. This does not revoke it in your Google account or promise forensic erasure."
              : action === "allow"
                ? "Cloud questions approved for this launch. Review each question in Search before sending."
                : "Cloud approval revoked. Any active answer was cancelled.",
        );
      }
    } catch {
      if (mounted.current) setError("Gemini settings could not be confirmed.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const ready = runtime?.service === "ready",
    waiting = busy || state?.busy;
  return (
    <section className="panel" aria-labelledby="assistant-settings-heading">
      <h2 id="assistant-settings-heading">Optional Gemini questions</h2>
      <p>
        Local keyword search works without Gemini. Cloud questions send your
        reviewed question and selected recorded observations to Google using
        your Gemini account. Page text, file contents and full file paths are
        excluded from this feature.
      </p>
      <p>
        Configure your key in a native Windows dialog, using its Password field.
        Rewind stores it in encrypted local storage. Saving a key grants no
        cloud permission. Approval expires on app/service restart. Privacy
        changes and explicit history maintenance revoke approval; evidence
        changes invalidate its reviews and answers. Changing cloud settings
        pauses an active recording session; resume explicitly afterward.
      </p>
      <p role="status">
        {state?.configured
          ? "A Gemini key is configured."
          : "No Gemini key is configured."}{" "}
        {state?.permission
          ? "Cloud questions are approved for this launch."
          : "Cloud approval is off."}
      </p>
      <div className="controls">
        <button
          disabled={!ready || waiting}
          onClick={() => void run("configure")}
        >
          {state?.configured ? "Replace Gemini key" : "Configure Gemini key"}
        </button>
        {!state?.permission ? (
          <button
            className="primary"
            disabled={!ready || waiting || !state?.configured}
            onClick={() => void run("allow")}
          >
            Allow cloud questions for this launch
          </button>
        ) : (
          <button
            className="end-button"
            disabled={!ready}
            onClick={() => void run("deny")}
          >
            Revoke cloud approval
          </button>
        )}
      </div>
      {state?.configured && (
        <div>
          <label>
            <input
              type="checkbox"
              checked={remove}
              onChange={(event) => setRemove(event.target.checked)}
            />{" "}
            Remove the saved Gemini key from Rewind
          </label>
          <button
            disabled={!ready || !remove || waiting}
            onClick={() => void run("forget")}
          >
            Confirm key removal
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

interface AnswerView {
  receipt: AssistantAnswerReceipt;
  evidence: AssistantEvidence[];
  question: string;
}
export function AssistantSearch({
  runtime,
  selectedIds,
  clearSelection,
}: {
  runtime: RuntimeSnapshot | null;
  selectedIds: readonly string[];
  clearSelection(): void;
}) {
  const state = runtime?.assistant;
  const stamp = `${state?.generation ?? ""}:${state?.revision ?? -1}`;
  const selection = selectedIds.join(",");
  const latest = useRef({
    stamp,
    selection,
    ready: runtime?.service === "ready",
    permission: state?.permission ?? false,
  });
  latest.current = {
    stamp,
    selection,
    ready: runtime?.service === "ready",
    permission: state?.permission ?? false,
  };
  const [question, setQuestion] = useState(""),
    [review, setReview] = useState<AssistantReviewReceipt | null>(null),
    [approved, setApproved] = useState<string[]>([]),
    [answer, setAnswer] = useState<AnswerView | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const live = useRef(true),
    activeReview = useRef<string | null>(null),
    asking = useRef(false),
    displayDeadline = useRef(Infinity);
  function clearReview() {
    const id = activeReview.current;
    activeReview.current = null;
    if (id) void window.rewind.assistant.cancel(id).catch(() => {});
    setReview(null);
    setApproved([]);
  }
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (activeReview.current)
        void window.rewind.assistant
          .cancel(activeReview.current)
          .catch(() => {});
      if (asking.current) void window.rewind.assistant.stop().catch(() => {});
    };
  }, []);
  useEffect(() => {
    setReview(null);
    setApproved([]);
    setAnswer(null);
    activeReview.current = null;
  }, [stamp]);
  useEffect(() => {
    const id = activeReview.current;
    activeReview.current = null;
    if (id) void window.rewind.assistant.cancel(id).catch(() => {});
    setReview(null);
    setApproved([]);
  }, [selection]);
  const expiresAt = review?.review.expiresAt ?? answer?.receipt.expiresAt;
  useEffect(() => {
    if (!expiresAt) return;
    displayDeadline.current =
      performance.now() + Math.max(0, Date.parse(expiresAt) - Date.now());
    const expire = () => {
      if (
        Date.now() < Date.parse(expiresAt) &&
        performance.now() < displayDeadline.current
      )
        return;
      setReview(null);
      setApproved([]);
      setAnswer(null);
      const id = activeReview.current;
      activeReview.current = null;
      if (id) void window.rewind.assistant.cancel(id).catch(() => {});
      if (asking.current) void window.rewind.assistant.stop().catch(() => {});
      setError("This evidence review or answer expired. Prepare a new review.");
    };
    expire();
    const timer = setInterval(expire, 500);
    return () => clearInterval(timer);
  }, [expiresAt]);
  function current(generation: string, revision: number) {
    return (
      live.current &&
      latest.current.ready &&
      latest.current.permission &&
      `${generation}:${revision}` === latest.current.stamp
    );
  }
  async function prepare() {
    setBusy(true);
    setError("");
    setAnswer(null);
    clearReview();
    try {
      const result = await window.rewind.assistant.prepare({
        question,
        activityIds: [...selectedIds],
      });
      if (!live.current) {
        if (result.ok)
          void window.rewind.assistant
            .cancel(result.value.review.id)
            .catch(() => {});
        return;
      }
      if (!result.ok) setError(result.error.message);
      else if (
        current(result.value.generation, result.value.revision) &&
        selection === latest.current.selection &&
        Date.parse(result.value.review.expiresAt) > Date.now()
      ) {
        activeReview.current = result.value.review.id;
        setReview(result.value);
      } else {
        void window.rewind.assistant
          .cancel(result.value.review.id)
          .catch(() => {});
        setError(
          "Cloud approval or evidence selection changed. Prepare a new review.",
        );
      }
    } catch {
      if (live.current)
        setError("The local evidence review could not be prepared.");
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function send() {
    if (!review || !approved.length) return;
    const selected = review.review.evidence.filter((record) =>
      approved.includes(record.key),
    );
    setBusy(true);
    setError("");
    asking.current = true;
    activeReview.current = null;
    try {
      const result = await window.rewind.assistant.ask({
        id: review.review.id,
        keys: [...approved],
        confirmed: true,
      });
      if (!live.current) return;
      if (!result.ok) setError(result.error.message);
      else if (
        current(result.value.generation, result.value.revision) &&
        Date.parse(result.value.expiresAt) > Date.now() &&
        performance.now() < displayDeadline.current
      )
        setAnswer({
          receipt: result.value,
          evidence: selected,
          question: review.review.question,
        });
      else
        setError(
          "Cloud approval or evidence expired before this answer could be displayed.",
        );
    } catch {
      if (live.current) setError("No assistant answer could be confirmed.");
    } finally {
      asking.current = false;
      if (live.current) {
        setBusy(false);
        setReview(null);
        setApproved([]);
      }
    }
  }
  async function stop() {
    setAnswer(null);
    clearReview();
    try {
      const result: Result<true> = await window.rewind.assistant.stop();
      if (live.current && !result.ok) setError(result.error.message);
    } catch {
      if (live.current)
        setError("Request cancellation could not be confirmed.");
    }
  }
  const permitted = runtime?.service === "ready" && state?.permission;
  return (
    <section
      className="panel assistant-search"
      aria-labelledby="assistant-search-heading"
    >
      <h3 id="assistant-search-heading">Ask about selected evidence</h3>
      <p>
        Select up to 12 observations below, then write a question. Preparing a
        local review sends nothing to Google. Each question needs a separate
        review and explicit Send. This searches only the evidence you select.
      </p>
      {!permitted && (
        <p>
          Configure Gemini and allow cloud questions in Settings to use this
          optional feature. Keyword search remains local.
        </p>
      )}
      <p>{selectedIds.length} observations selected.</p>
      <label htmlFor="assistant-question">Question for Gemini</label>
      <textarea
        id="assistant-question"
        rows={3}
        maxLength={1000}
        value={question}
        disabled={busy || Boolean(review)}
        onChange={(event) => {
          setQuestion(event.target.value);
          setAnswer(null);
        }}
      />
      <div className="controls">
        <button
          disabled={
            !permitted ||
            busy ||
            state?.busy ||
            !question.trim() ||
            !selectedIds.length ||
            Boolean(review)
          }
          onClick={() => void prepare()}
        >
          Prepare local sharing review
        </button>
        <button
          disabled={busy || !selectedIds.length}
          onClick={() => {
            clearReview();
            clearSelection();
          }}
        >
          Clear evidence selection
        </button>
        {(busy || state?.busy) && (
          <button className="end-button" onClick={() => void stop()}>
            Stop Gemini request
          </button>
        )}
      </div>
      {review && (
        <section aria-label="Question sharing review">
          <h4>Review question and evidence</h4>
          <p>{review.review.question}</p>
          <p>
            Google receives this question, the titles/timestamps of checked
            observations, and bounded excerpts requested from that approved set.
            Expires {new Date(review.review.expiresAt).toLocaleString()}.
            Sending cannot be undone by deleting local history.
          </p>
          <div className="evidence-picker">
            {review.review.evidence.map((record) => (
              <article key={record.key}>
                <label>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={approved.includes(record.key)}
                    onChange={(event) =>
                      setApproved((keys) =>
                        event.target.checked
                          ? [...keys, record.key]
                          : keys.filter((key) => key !== record.key),
                      )
                    }
                  />{" "}
                  Share {record.key}: {record.title || "Untitled observation"}
                </label>
                <p>
                  <time dateTime={record.occurredAt}>
                    {new Date(record.occurredAt).toLocaleString()}
                  </time>{" "}
                  · {record.evidence}
                </p>
                <p>{record.excerpt}</p>
              </article>
            ))}
          </div>
          <div className="controls">
            <button
              className="primary"
              disabled={!permitted || busy || !approved.length}
              onClick={() => void send()}
            >
              Send reviewed question to Gemini
            </button>
            <button disabled={busy} onClick={clearReview}>
              Cancel sharing review
            </button>
          </div>
        </section>
      )}
      {busy && (
        <p role="status">
          {asking.current
            ? "Waiting for a verified Gemini answer..."
            : "Preparing the local evidence review..."}
        </p>
      )}
      {!busy && state?.busy && (
        <p role="status">
          Earlier assistant work is still in progress or stopping.
        </p>
      )}
      {answer && (
        <section aria-label="Gemini answer">
          <h4>Gemini answer</h4>
          <p>{answer.question}</p>
          <p className="assistant-answer-text">{answer.receipt.answer.text}</p>
          <p>
            {answer.receipt.answer.insufficientEvidence
              ? "The selected evidence does not establish a complete answer."
              : "Answer based on the cited selected observations. Verify the sources below."}
          </p>
          {answer.receipt.answer.sources.map((source, index) => {
            const record = answer.evidence.find(
              (item) => JSON.stringify(item.source) === JSON.stringify(source),
            );
            return (
              <details key={JSON.stringify(source)}>
                <summary>
                  Source {index + 1}: {record?.title || "Recorded observation"}
                </summary>
                {record && (
                  <>
                    <p>
                      {new Date(record.occurredAt).toLocaleString()} ·{" "}
                      {record.evidence}
                    </p>
                    <p>{record.excerpt}</p>
                  </>
                )}
              </details>
            );
          })}
        </section>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
