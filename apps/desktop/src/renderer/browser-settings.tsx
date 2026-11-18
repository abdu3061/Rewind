import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserControlState,
  Result,
  RuntimeSnapshot,
} from "@rewind/contracts";

type Browser = "chrome" | "edge";
const label = (browser: Browser) => (browser === "chrome" ? "Chrome" : "Edge");
type Confirmation =
  { kind: "install" | "repair" } | { kind: "remove"; browser: Browser };
export function BrowserSettings({
  runtime,
}: {
  runtime: RuntimeSnapshot | null;
}) {
  const [state, setState] = useState<BrowserControlState | null>(null),
    [draft, setDraft] = useState(""),
    [selected, setSelected] = useState<Browser[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const live = useRef(true),
    epoch = useRef(0),
    active = useRef<number | null>(null),
    busyRef = useRef(false),
    dirty = useRef(false),
    selectionDirty = useRef(false);
  const readable = Boolean(runtime?.secureStorage && window.rewind?.browser);
  const accept = useCallback((value: BrowserControlState) => {
    setState(value);
    if (!dirty.current) setDraft(value.excludedSiteHosts.join("\n"));
    if (!selectionDirty.current)
      setSelected([
        ...new Set([
          ...value.setup.availableBrowsers,
          ...value.setup.registeredBrowsers,
        ]),
      ]);
  }, []);
  useEffect(() => {
    live.current = true;
    epoch.current++;
    let stopped = false,
      reading = false;
    const refresh = async () => {
      if (!readable || reading || busyRef.current) return;
      reading = true;
      const ticket = epoch.current;
      try {
        const result = await window.rewind.browser.state();
        if (!stopped && ticket === epoch.current) {
          if (result.ok) accept(result.value);
          else setError(result.error.message);
        }
      } catch {
        if (!stopped && ticket === epoch.current)
          setError("Browser controls are unavailable.");
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2000);
    return () => {
      stopped = true;
      live.current = false;
      clearInterval(timer);
    };
  }, [readable, accept]);
  async function run(
    operation: () => Promise<Result<BrowserControlState>>,
    success: string,
    options: { priority?: boolean; saveDraft?: boolean } = {},
  ) {
    if (busyRef.current && !options.priority) return;
    const ticket = ++epoch.current;
    active.current = ticket;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await operation();
      if (!live.current || ticket !== epoch.current) return;
      if (result.ok) {
        if (options.saveDraft) dirty.current = false;
        accept(result.value);
        setMessage(success);
        setConfirmation(null);
      } else {
        setError(result.error.message);
        const refreshed = await window.rewind.browser.state();
        if (live.current && ticket === epoch.current && refreshed.ok)
          accept(refreshed.value);
      }
    } catch {
      if (live.current && ticket === epoch.current)
        setError("The browser operation could not be confirmed.");
    } finally {
      if (active.current === ticket) {
        busyRef.current = false;
        active.current = null;
        if (live.current) setBusy(false);
      }
    }
  }
  async function openFolder() {
    const ticket = ++epoch.current;
    setError("");
    setMessage("");
    try {
      const result = await window.rewind.browser.openExtensionFolder();
      if (live.current && ticket === epoch.current) {
        if (result.ok)
          setMessage(
            "Extension folder opened. Load this folder as an unpacked extension in your browser.",
          );
        else setError(result.error.message);
      }
    } catch {
      if (live.current && ticket === epoch.current)
        setError("The extension folder could not be opened.");
    }
  }
  const approved = runtime?.browserPermission ?? false,
    working = busy || Boolean(state?.busy),
    enabled = readable && Boolean(state),
    setupAvailable = enabled && state?.setup.state !== "unavailable";
  const browsers = [
    ...new Set([
      ...(state?.setup.availableBrowsers ?? []),
      ...(state?.setup.registeredBrowsers ?? []),
    ]),
  ];
  return (
    <section
      className="panel recording-preferences"
      aria-labelledby="browser-heading"
    >
      <h2 id="browser-heading">Chrome and Edge activity</h2>
      <p>
        Browser metadata needs separate approval here and in the extension, plus
        an active session. Rewind records the focused regular tab's title,
        website path and time. Query strings and fragments are removed. Private
        browsing, page text and browser window titles are excluded.
      </p>
      <p>
        Approval expires when Rewind, its service or the extension restarts.
        Permission and exclusion changes pause recording; start or resume
        explicitly afterward. Setup does not install the extension or approve
        recording.
      </p>
      {!readable && (
        <p role="status">
          Reconnect the secure recording service to use browser controls.
        </p>
      )}
      {state && (
        <p role="status" data-testid="browser-status">
          Setup {state.setup.state}; connection {state.bridge.state};{" "}
          {state.capture.connected} connected client(s). Capture{" "}
          {state.capture.state}: {state.capture.captured} events saved this run,{" "}
          {state.capture.pending} pending. Browser approval{" "}
          {approved ? "on" : "off"}.
        </p>
      )}
      {state?.setup.checkedAt && (
        <p className="footnote">
          Setup last checked {new Date(state.setup.checkedAt).toLocaleString()}.
          Recorded registrations:{" "}
          {state.setup.registeredBrowsers.map(label).join(", ") || "none"}.
        </p>
      )}
      {state?.setup.error && (
        <p className="error" role="alert">
          {state.setup.error.message}
        </p>
      )}
      {state?.setup.state === "not-installed" &&
        !state.setup.availableBrowsers.length && (
          <p>
            No supported Chrome or Edge installation was detected. Install one,
            then restart Rewind.
          </p>
        )}
      {(state?.capture.state === "unavailable" ||
        state?.bridge.state === "unavailable") && (
        <p className="footnote">
          {runtime?.service === "unavailable"
            ? "Use Reconnect recording service above to reset the connection."
            : "Close and reopen Rewind to reset the browser connection."}{" "}
          Fresh approval is required afterward.
        </p>
      )}
      <div
        className="browser-options"
        role="group"
        aria-label="Browsers for local connection"
      >
        {browsers.map((browser) => (
          <label key={browser}>
            <input
              type="checkbox"
              checked={selected.includes(browser)}
              disabled={!setupAvailable || working}
              onChange={(event) => {
                selectionDirty.current = true;
                setSelected((current) =>
                  event.target.checked
                    ? [...current, browser]
                    : current.filter((kind) => kind !== browser),
                );
                setConfirmation(null);
              }}
            />
            {label(browser)}
            {!state?.setup.availableBrowsers.includes(browser) &&
              " (installation not detected)"}
          </label>
        ))}
      </div>
      <div className="browser-actions">
        <button
          disabled={
            !setupAvailable ||
            working ||
            !selected.length ||
            Boolean(state?.setup.repairAvailable)
          }
          onClick={() => setConfirmation({ kind: "install" })}
        >
          Set up browser connection
        </button>
        <button
          disabled={!setupAvailable || working}
          onClick={() => void openFolder()}
        >
          Open extension folder
        </button>
        {state?.setup.registeredBrowsers.map((browser) => (
          <button
            key={browser}
            disabled={!enabled || working || state.setup.repairAvailable}
            onClick={() => setConfirmation({ kind: "remove", browser })}
          >
            Remove {label(browser)} connection
          </button>
        ))}
        {state?.setup.repairAvailable && (
          <button
            disabled={!enabled || working}
            onClick={() => setConfirmation({ kind: "repair" })}
          >
            Repair interrupted setup
          </button>
        )}
      </div>
      {confirmation && (
        <div
          className="browser-confirm"
          role="group"
          aria-label="Confirm browser connection change"
        >
          <p>
            {confirmation.kind === "install"
              ? `Set up the local connection for ${selected.map(label).join(" and ")}?`
              : confirmation.kind === "remove"
                ? `Remove the owned ${label(confirmation.browser)} connection?`
                : "Complete the recorded interrupted setup operation?"}{" "}
            Recording will pause and browser approval will be off. Existing
            saved history remains available.
          </p>
          <div className="browser-actions">
            <button
              disabled={working}
              onClick={() => {
                if (confirmation.kind === "install")
                  void run(
                    () => window.rewind.browser.install(selected, true),
                    "Browser setup verified. Browser approval is off.",
                  );
                else if (confirmation.kind === "remove")
                  void run(
                    () =>
                      window.rewind.browser.remove(confirmation.browser, true),
                    "Browser connection removed. Browser approval is off.",
                  );
                else
                  void run(
                    () => window.rewind.browser.repair(true),
                    "Browser setup repair verified. Browser approval is off.",
                  );
              }}
            >
              Confirm{" "}
              {confirmation.kind === "install"
                ? "setup"
                : confirmation.kind === "remove"
                  ? "removal"
                  : "repair"}
            </button>
            <button disabled={working} onClick={() => setConfirmation(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <p className="footnote">
        After setup, open chrome://extensions or edge://extensions, enable
        Developer mode and use Load unpacked to select the opened extension
        folder. Then use Allow and connect in the extension. Only the approved
        active session can record.
      </p>
      <label htmlFor="browser-site-exclusions">
        Excluded websites (one host per line)
      </label>
      <textarea
        id="browser-site-exclusions"
        rows={3}
        maxLength={254000}
        value={draft}
        disabled={!enabled || working}
        placeholder="Example: private.example.com"
        onChange={(event) => {
          dirty.current = true;
          setDraft(event.target.value);
          setMessage("");
        }}
      />
      <p className="footnote">
        Up to 200 hosts, including their subdomains. Enter host names without
        URLs, paths or wildcards. Exclusions affect future recording; manage
        existing evidence in History and storage.
      </p>
      {state && !state.policyValid && (
        <p className="error" role="alert">
          Review the saved website exclusions before approving browser
          recording.
        </p>
      )}
      <div className="browser-actions">
        <button
          disabled={!enabled || working}
          onClick={() =>
            void run(
              () =>
                window.rewind.browser.exclusions(
                  draft
                    .split(/\r?\n/)
                    .map((host) => host.trim())
                    .filter(Boolean),
                ),
              "Website exclusions saved. Browser approval is off; approve and resume explicitly.",
              { saveDraft: true },
            )
          }
        >
          Save website exclusions
        </button>
        {approved ? (
          <button
            disabled={!readable}
            onClick={() =>
              void run(
                () => window.rewind.browser.permission(false),
                "Browser recording is off.",
                { priority: true },
              )
            }
          >
            Stop browser recording
          </button>
        ) : (
          <button
            disabled={
              !enabled ||
              working ||
              state?.setup.state !== "installed" ||
              state.bridge.state !== "ready" ||
              state.capture.state === "unavailable" ||
              !state.policyValid
            }
            onClick={() =>
              void run(
                () => window.rewind.browser.permission(true),
                "Browser approval saved. Start or resume explicitly and approve the extension separately.",
              )
            }
          >
            Allow browser activity for this launch
          </button>
        )}
      </div>
      <p role="status" aria-live="polite">
        {busy
          ? "Waiting for the browser operation..."
          : message ||
            (approved
              ? "Browser activity is approved for this launch."
              : "Browser activity permission is off.")}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
