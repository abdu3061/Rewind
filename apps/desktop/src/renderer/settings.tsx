import { useRef, type KeyboardEvent } from "react";
import type { RuntimeSnapshot } from "@rewind/contracts";
import { RecordingPreferences } from "./recording";
import { RecordingSetup } from "./recording-setup";
import { BrowserSettings } from "./browser-settings";
import { AssistantSettings } from "./assistant";
import { StorageManagement } from "./storage-management";
import { SearchIndexSettings } from "./content-search";

export const settingsTabs = [
  "Recording",
  "Browsers",
  "Gemini",
  "Storage",
] as const;
export type SettingsTab = (typeof settingsTabs)[number];

export function Settings({
  runtime,
  tab,
  onTab,
}: {
  runtime: RuntimeSnapshot | null;
  tab: SettingsTab;
  onTab(tab: SettingsTab): void;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = settingsTabs.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % settingsTabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + settingsTabs.length) % settingsTabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? settingsTabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    onTab(settingsTabs[next] ?? "Recording");
    tabRefs.current[next]?.focus();
  }
  return (
    <>
      <div
        className="tabs"
        role="tablist"
        aria-label="Settings sections"
        onKeyDown={onKeyDown}
      >
        {settingsTabs.map((item, index) => (
          <button
            key={item}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            role="tab"
            id={`settings-tab-${item}`}
            aria-selected={tab === item}
            aria-controls="settings-panel"
            tabIndex={tab === item ? 0 : -1}
            className={tab === item ? "tab selected" : "tab"}
            onClick={() => onTab(item)}
          >
            {item}
          </button>
        ))}
      </div>
      <div
        className="stack"
        role="tabpanel"
        id="settings-panel"
        aria-labelledby={`settings-tab-${tab}`}
      >
        {tab === "Recording" && (
          <>
            <RecordingSetup runtime={runtime} />
            <RecordingPreferences runtime={runtime} />
          </>
        )}
        {tab === "Browsers" && <BrowserSettings runtime={runtime} />}
        {tab === "Gemini" && <AssistantSettings runtime={runtime} />}
        {tab === "Storage" && (
          <>
            <StorageManagement runtime={runtime} />
            <SearchIndexSettings runtime={runtime} />
          </>
        )}
        <p className="footnote">
          Rewind never captures keystrokes, clipboard contents, screenshots,
          page text or private browsing.
        </p>
      </div>
    </>
  );
}
