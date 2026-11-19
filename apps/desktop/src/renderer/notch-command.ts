import type { DesktopPage, SessionAction } from "@rewind/contracts";

export type NotchIntent =
  | { kind: "session"; action: Exclude<SessionAction, "get"> }
  | { kind: "open"; page?: DesktopPage }
  | { kind: "checkpoint" }
  | { kind: "search"; text?: string; browser?: true };

// Small explicit local command vocabulary, never an invented AI response.
export function parseNotchCommand(value: string): NotchIntent {
  const text = value.trim();
  const normalized = text.toLowerCase().replace(/[?.!]$/, "");
  const action =
    /^(?:please )?(start|pause|resume|end)(?: (?:my |the )?(?:session|recording))?$/.exec(
      normalized,
    )?.[1];
  if (action)
    return { kind: "session", action: action as Exclude<SessionAction, "get"> };
  if (/^(?:save|create)(?: a)? checkpoint$/.test(normalized))
    return { kind: "checkpoint" };
  if (/^(?:open|show) rewind$/.test(normalized)) return { kind: "open" };
  if (/^(?:restore|recover)(?: a| my)? file$/.test(normalized))
    return { kind: "open", page: "Files" };
  if (/^(?:open|show|manage) (?:settings|permissions)$/.test(normalized))
    return { kind: "open", page: "Settings" };
  if (
    /^(?:what was i working on|show (?:my )?(?:recent )?activity|recall)$/.test(
      normalized,
    )
  )
    return { kind: "search" };
  if (
    /^(?:show|find) (?:my )?(?:recent )?(?:websites|browser history|web pages)(?: i visited)?$/.test(
      normalized,
    )
  )
    return { kind: "search", browser: true };
  return {
    kind: "search",
    text: text
      .replace(/^(?:search(?: for)?|find|recall)\s+/i, "")
      .slice(0, 500),
  };
}
