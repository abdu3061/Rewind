import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserControlState,
  Result,
  RuntimeSnapshot,
} from "@rewind/contracts";
import { HowItWorks, plural } from "./ui";

type Browser = "chrome" | "edge";
const label = (browser: Browser) => (browser === "chrome" ? "Chrome" : "Edge");
const setupLabel: Record<BrowserControlState["setup"]["state"], string> = {
  "not-installed": "not set up",
  installed: "set up",
  "needs-attention": "needs attention",
  unavailable: "unavailable",
};
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
        Records the title, website and time of the tab you're looking at. Page
        text and private browsing are never recorded.
      </p>
      <HowItWorks>
        <p>
          Browser recording needs permission here and in the Rewind extension,
          plus an active session. Query strings and #fragments are removed from
          addresses, and browser window titles are skipped.
        </p>
        <p>
          Permission ends when Rewind, its service or the extension restarts.
          Changing permission or exclusions pauses recording until you start or
          resume. Setting up the connection doesn't install the extension or
          turn on recording.
        </p>
      </HowItWorks>
      {!readable && (
        <p role="status">
          Reconnect the secure recording service to use browser controls.
        </p>
      )}
      {state && (
        <p role="status" data-testid="browser-status" className="hint">
          Browser connection {setupLabel[state.setup.state]},{" "}
          {state.bridge.state} · {plural(state.capture.connected, "browser")}{" "}
          connected · recording {state.capture.state}:{" "}
          {plural(state.capture.captured, "visit")} saved since Rewind opened
          {state.capture.pending ? `, ${state.capture.pending} waiting` : ""} ·
          permission {approved ? "on" : "off"}
        </p>
      )}
      {state?.setup.checkedAt && (
        <p className="hint">
          Connected browsers:{" "}
          {state.setup.registeredBrowsers.map(label).join(", ") || "none"} ·
          checked {new Date(state.setup.checkedAt).toLocaleString()}
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
      <ol className="hint steps">
        <li>Choose your browsers and Set up browser connection.</li>
        <li>
          Open chrome://extensions or edge://extensions and turn on Developer
          mode.
        </li>
        <li>Load unpacked and pick the folder from Open extension folder.</li>
        <li>In the extension, choose Allow and connect.</li>
      </ol>
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
      <p className="hint">
        Up to 200 sites, e.g. example.com (subdomains included). No paths or
        wildcards. History already saved isn't affected.
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
              "Website exclusions saved. Browser permission is off; allow it again and resume the session.",
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
                "Browser activity allowed. Start or resume a session, and allow it in the extension too.",
              )
            }
          >
            Allow browser activity
          </button>
        )}
      </div>
      <p role="status" aria-live="polite">
        {busy
          ? "Waiting for the browser operation..."
          : message ||
            (approved
              ? "Browser activity allowed until Rewind restarts."
              : "Browser activity is off.")}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
