# UX, copy and layout audit — 20 November 2026

Scope: the desktop renderer (`apps/desktop/src/renderer`) and the notch, reviewed against the synthetic Playwright captures in `test-results/` (taken after the last renderer change, `504ccdd`). No code changed.

Priority key: **P0** fix first, has the biggest effect on how the app feels · **P1** important structural or flow change · **P2** polish · **P3** nice to have.

Constraint carried through every item: AGENTS.md requires consent disclosures, the session lifecycle and per-source approvals to stay accurate. The recommendations shorten and relocate that copy; they never remove a disclosure from the moment the user grants consent. Anything that changes how consent works (items 7 and 19) needs Rasit's review. Abdullah owns UX sign-off.

## Summary

The notch is the strongest surface: short, calm and obviously useful. The main window is the opposite. It reads like a compliance document:

- About **3,000 words** of explanatory prose across the renderer. Settings alone is about 1,100 words and roughly 4,400 px tall.
- Every panel opens with 2–4 paragraphs of implementation caveats before the first control.
- Privacy status is stated three times on every page.
- Dashboard and Settings render the **same setup card and the same Windows-activity form**.
- Timeline and Search are the **same component** behind a flag, so each page shows the other's controls.
- Lists, previews and recovery stack vertically, so the user scrolls past everything to reach the detail they clicked.

Fix the copy and the page chrome first (cheap, high impact). Then restructure Dashboard, Settings and the list/detail layout.

---

## P0 — Highest impact

### 1. Too much text everywhere

| Where                     | Now                                                                                                                                                                                                        | Change to                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Every panel               | 2–4 paragraphs before the first control (e.g. Search: _"A window title does not prove that a file was saved or read. Browser metadata needs both approvals. Idle and lock detection remain unavailable…"_) | A one-line subtitle. Move caveats into a collapsed **"How this works"** disclosure per section, or one **Privacy & limits** page. |
| Files › Protected folders | 3 paragraphs + a fine-print block (NTFS, 240 chars, reparse points, hardlinks)                                                                                                                             | _"Rewind saves a version each time a supported file changes while recording."_ plus a "What's supported?" link.                   |
| Windows activity form     | _"Use nonsensitive development sessions while independent security review is pending."_                                                                                                                    | Remove it from the UI. It is a team note and belongs in beta notes.                                                               |
| Storage                   | Forensic-erasure caveat, compaction caveat                                                                                                                                                                 | Keep it, but only inside the **Delete history** confirmation dialog, where it matters.                                            |
| Dashboard footnote        | _"Closing the window ends the session and quits…"_                                                                                                                                                         | This is critical behaviour hidden in fine print. See item 19.                                                                     |

Rule of thumb for the rewrite: **one sentence of purpose, then the control.** Explain limits at the point of failure (an error or empty state), not up front.

### 2. Repeated page chrome

Every page shows the eyebrow `YOUR WORK, WITH CONTEXT`, the H1, a "Synthetic verification mode / On your device" badge, the **"Encrypted local history · Cloud off · You choose what Rewind remembers"** banner, _and_ the sidebar block ("Collection off · No active recording authorization · Cloud approval is off"). That's about 170 px of the same message on every page.

- Remove the eyebrow and the banner (`App.tsx:231-258`).
- Keep one status: the sidebar footer pill, showing **● Recording / ❚❚ Paused / ○ Off**, plus a small cloud icon only when Gemini is on. Clicking it opens Settings › Recording.
- Show the encryption/secure-storage state only when it's **bad** (a red banner), not when it's fine.

### 3. Settings is one giant page that duplicates Dashboard

`App.tsx:431-458` stacks RecordingSetup, RecordingPreferences, BrowserSettings, AssistantSettings and StorageManagement into a single panel. Two of those also appear on Dashboard.

- Split Settings into tabs or a left sub-nav: **Recording · Files · Browsers · AI (Gemini) · Storage · Privacy & limits**.
- Remove `RecordingPreferences` from Dashboard. Show `RecordingSetup` on Dashboard **only until it's completed**, then never again (it stays in Settings › Recording).
- Drop the stray "Privacy settings" notice and the two trailing paragraphs (`App.tsx:438-456`). They only describe where other things are.

### 4. Doubled backslashes in a placeholder (bug)

`recording.tsx:141`: `placeholder="C:\\Users\\YourName\\Documents\\Private"` renders literally as `C:\\Users\\…` because JSX attribute strings don't process escapes. Use `placeholder={"C:\\Users\\YourName\\Documents\\Private"}` or single backslashes.

---

## P1 — Structure and flows

### 5. The Dashboard says nothing about your work

Today it has a consent card, session buttons, two cards that just repeat the sidebar nav, and the advanced form. It has no activity, files or checkpoints.

Proposed Dashboard (Home):

1. **Status hero**: the mascot, the current state ("Recording since 9:14 · 3 files saved"), and **one** primary action.
2. **Recently changed files**: the last 5, each with a "Restore" action.
3. **Last session**: duration, top apps, file count, and "Open in Timeline".
4. **Checkpoints**: the latest 3, plus "Save checkpoint".
5. Remove the Timeline/Files "nav cards" (`App.tsx:364-409`).

### 6. Session controls show four buttons when 1–2 apply

Start, Pause, Resume and End are always rendered, and most are disabled. "Stay in your flow." / "A good place to pick things up." are filler. Status casing is inconsistent ("ended", "Not Started").

- Show **one state-aware primary**: Start → Pause ⇄ Resume, plus a secondary **End session** only while a session exists.
- Use a single status chip with consistent casing: _Recording · Paused · Ended · Not started_.

### 7. Five different "Allow" buttons across the app

"Allow and start recording", "Allow Windows activity for this launch", "Allow file protection for this launch", "Allow browser activity for this launch", "Allow cloud questions for this launch". "Launch" is internal jargon, and users can't tell which ones they still need.

- Present one **Sources** list (Settings › Recording, mirrored as a compact block on Home). Each row shows the source, its status and a toggle: _Windows activity · Files · Chrome/Edge · Gemini_.
- Once the one-time automatic setup is done, hide the per-launch buttons under "Advanced".
- Replace "for this launch" with "until Rewind restarts" where it still applies.
- ⚠ This changes how consent is presented, not the engine rules, so it still needs Rasit's review and must keep the ADR 0038 semantics.

### 8. Timeline and Search are the same screen

`RecordedHistory` has a `search` flag (`recording.tsx:202`). As a result, Timeline has a "Search history" box and an "Apply filters" button, and Search has the full Timeline filter form, content indexing controls, the Gemini panel and the activity list.

- **Timeline** should be chronological browsing: entries grouped by **day → session**, filters as compact chips (Session, Type, Date), and no search box.
- **Search** should be one large search field at the top. Results go in tabs (**Activity · File contents**), filters collapse into a "Filters" button, and "Ask AI" is a separate button (see item 14).

### 9. Timeline rows are oversized and repetitive

Each entry takes about 120 px for three short lines, and the full date repeats on every row.

- Use compact rows of about 44 px: app icon or initial · title · relative time ("2 min ago").
- Put date and session as sticky group headers.
- Show the app name once per run of consecutive entries from the same app.

### 10. Files: versions aren't grouped by file, and preview/recovery is far away

Each version repeats the filename, full path, "34 original bytes · text/plain" and a full-width "Preview captured version" button. The preview, then "Recover as a separate copy", then "Optional: overwrite" all render **below** the whole list. The SHA-256 is shown inline.

- Use a **master–detail layout**: file list on the left (one row per file, with a version count). Selecting a file opens its **version history** on the right, with a preview and **Restore copy** / **Overwrite…** actions.
- Format sizes as "71 B" or "1.2 MB". Truncate paths in the middle, with the full path on hover.
- Move the hash under a "Details" disclosure.
- Turn "Protected folders" into a compact list with **+ Add folder**, and move it to Settings › Files.

### 11. Checkpoints: creating one is a form, not an action

The session picker shows `11/20/2026, 1:21:27 AM · paused · d3cf0204` (an internal ID). The checkbox fieldsets have large empty gaps. There's a "Refresh evidence and clear selection" button. The detail view shows a full session UUID.

- **Quick save**: a name field plus Save. It defaults to the current or last session and all of its recent items, matching the notch's "Save checkpoint".
- **"Choose items…"** opens the detailed picker, with tidy rows and select-all per group.
- Show saved checkpoints as cards (name, time, "3 files · 12 activities", ★ Kept). Open details in a side panel or drawer.
- Remove session IDs and UUIDs from the UI. Label sessions as "Today, 09:14–11:02".

### 12. Jargon

| Now                                     | Plain language                                    |
| --------------------------------------- | ------------------------------------------------- |
| evidence / observations                 | activity, files                                   |
| Collection off / active                 | Recording off / on                                |
| authorization, approval for this launch | permission (until Rewind restarts)                |
| original bytes, MiB                     | size (KB/MB/GB)                                   |
| capture gaps                            | "Rewind wasn't recording"                         |
| retained history                        | saved history                                     |
| Data retention period (hours): 72       | Keep history for: **3 days** ▾ (day/week presets) |
| Storage limit (MiB): 2048               | Storage limit: **2 GB** ▾                         |
| Recovery backups                        | Earlier versions                                  |

---

## P2 — Polish

### 13. Manual refresh buttons

"Refresh versions", "Refresh checkpoints" and "Refresh evidence…" exist even though the runtime pushes change events. Update lists live, and keep at most a small ↻ icon.

### 14. Gemini selection clutters every search result

Every activity row gets a "Select for Gemini review" checkbox, even when Gemini isn't set up. The "Ask about selected evidence" panel always renders.

- Hide this entirely until Gemini is configured and allowed.
- Then add an **"Ask AI"** button that switches the list into selection mode. The review step becomes a modal or side sheet showing exactly what will be sent.

### 15. Index maintenance lives on the Search page

"Index saved content", "Stop content indexing", "Retry unavailable documents" and the "3 of 3 supported saved versions indexed; 0 pending…" line are maintenance controls. Move them to Settings › Storage. On Search, show only a small "Indexing… 40%" chip while indexing is running.

### 16. Visual hierarchy and buttons

- Most buttons are the same outlined style, and disabled ones look nearly enabled (Pause/Resume/End). Define **primary / secondary / ghost / danger** variants, and make disabled states clearly muted.
- Destructive actions ("Delete checkpoint", "Remove", "Delete history…", "End session") aren't styled as destructive. Use the danger variant and a confirmation where data is lost.
- Heading sizes jump around: "Stay in your flow." is about 28 px while sibling panels are about 18 px. Set one scale: page H1 → section H2 → card H3.
- Prose stretches about 120 characters per line on wide windows. Cap text blocks at about 70ch.
- Fieldsets in Checkpoints have large empty top padding.

### 17. Exclusions as free-text textareas

"Excluded applications (one name per line)", "Excluded files or folders (one full path per line)" and "Excluded websites (one host per line)" are textareas. Replace them with **chip lists**:

- **+ Add app**, picking from apps Rewind has already seen.
- **+ Add folder**, using the native dialog.
- **+ Add site**.

Validate inline instead of describing the rules in a paragraph.

### 18. Empty states

"0 recorded events shown." followed by a sentence about approvals reads like an error. Use a friendly empty state: mascot, one line ("Nothing recorded yet"), and **one button** that fixes it ("Start recording").

### 19. Closing the window quits and ends the session

The footnote on Dashboard is the only place this is mentioned. Most tray/notch apps hide to the tray when closed. Options:

- **(a)** Close hides to the notch and Quit lives in the tray menu.
- **(b)** Keep quitting, but show a one-time confirmation ("Closing ends your session. Minimize to keep recording?").

This is a product decision.

### 20. Sidebar status block is verbose

"Approved sources are enabled; see Files and Settings for progress. Cloud approval is off." should become a single pill (see item 2). "Private by design · v0.1 beta" can move to Settings › About.

---

## P3 — Nice to have

21. **Bring the notch's look into the main app.** Its dark glass, concise labels and quick-action buttons are the most polished part of Rewind. Reuse its tokens for the status hero and quick actions on Home. Its footer line "Recording needs separate launch approvals." should also lose the jargon.
22. **Paths**: truncate in the middle everywhere (`C:\Users\…\Documents\report.docx`) and add a "Show in Explorer" action.
23. **Dates**: use relative times inside lists, and absolute times in tooltips and headers.
24. **Keyboard**: `Ctrl+K` focuses Search, `Ctrl+S` saves a checkpoint. Only advertise shortcuts that actually exist.
25. **Onboarding**: replace the long setup card with a 3-step first-run flow: what Rewind records → where (folders) → Allow. Each step has 1–2 sentences, plus a "Details" link for the full disclosure.

---

## Proposed navigation

```
Home          status hero · recent files · last session · checkpoints
Timeline      day → session groups · filter chips
Search        one search box · Activity | File contents tabs · Ask AI (when enabled)
Files         master–detail: files → versions → restore
Checkpoints   quick save · cards · detail drawer
Settings      Recording · Files · Browsers · AI · Storage · Privacy & limits · About
```

## Suggested order of work

| Phase            | Items                  | Risk   | Notes                                                                                                                           |
| ---------------- | ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 1. Copy & chrome | 1, 2, 4, 6, 12, 18, 20 | Low    | Mostly text/CSS. **Playwright app tests match visible text and roles (14 spec files)**, so update selectors in the same change. |
| 2. Layout        | 3, 5, 8, 9, 10, 15, 16 | Medium | Settings tabs, Home redesign, Timeline/Search split, Files master–detail. Renderer-only.                                        |
| 3. Flows         | 7, 11, 13, 14, 17, 19  | Higher | Touches consent presentation and the close behaviour. Needs Rasit's review, and an ADR for 7 and 19.                            |
| 4. Extras        | 21–25                  | Low    |                                                                                                                                 |

Each phase should be its own feature branch and PR into `main`, with `npm run typecheck`, `lint`, `test`, `build` and `test:app` passing, and fresh screenshots attached for Abdullah's UI review.
