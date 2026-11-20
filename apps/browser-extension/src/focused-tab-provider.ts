import type { FocusedBrowserTab } from "./metadata-controller";

export interface BrowserWindowMetadata {
  id?: number | undefined;
  focused: boolean;
  incognito: boolean;
  type?: string | undefined;
}
export interface BrowserTabMetadata {
  id?: number | undefined;
  windowId: number;
  active: boolean;
  incognito: boolean;
  url?: string | undefined;
  title?: string | undefined;
}
/** Implement with nonpopulated windows and one window-scoped active-tabs query. No DOM access. */
export interface BrowserMetadataAccess {
  lastFocusedWindow(): Promise<BrowserWindowMetadata>;
  activeTabs(windowId: number): Promise<BrowserTabMetadata[]>;
  window(windowId: number): Promise<BrowserWindowMetadata>;
}
const validId = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0;
function normalFocusedWindow(window: BrowserWindowMetadata): boolean {
  return (
    window.incognito === false &&
    window.focused === true &&
    window.type === "normal" &&
    validId(window.id)
  );
}

/** One permitted observation. Rechecks authority before each asynchronous API and before reading its result. */
export async function focusedBrowserTab(
  access: BrowserMetadataAccess,
  authorized: () => boolean,
): Promise<FocusedBrowserTab | null> {
  const permitted = () => {
    try {
      return authorized() === true;
    } catch {
      return false;
    }
  };
  if (!permitted()) return null;
  const window = await access.lastFocusedWindow();
  if (!permitted() || !normalFocusedWindow(window)) return null;
  const windowId = window.id!;
  if (!permitted()) return null;
  const tabs = await access.activeTabs(windowId);
  if (!permitted()) return null;
  if (!Array.isArray(tabs) || tabs.length !== 1) return null;
  const tab = tabs[0]!;
  // Never inspect a URL/title before private/active/window checks; do not spread the raw API result.
  if (
    tab.incognito !== false ||
    tab.active !== true ||
    tab.windowId !== windowId ||
    !validId(tab.id)
  )
    return null;
  const tabId = tab.id;
  if (!permitted()) return null;
  const currentWindow = await access.window(windowId);
  if (
    !permitted() ||
    !normalFocusedWindow(currentWindow) ||
    currentWindow.id !== windowId
  )
    return null;
  return {
    id: tabId,
    windowId,
    active: true,
    focused: true,
    incognito: false,
    // The controller rejects restricted/excluded URLs before evaluating title. Keep these lazy.
    get url() {
      return permitted() ? tab.url : undefined;
    },
    get title() {
      return permitted() ? tab.title : undefined;
    },
  };
}
