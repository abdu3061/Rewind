# ADR 0030: Public reviewed Gemini questions

Status: Implemented locally for Rasit's review. Live-account and interactive native-entry acceptance remain manual gates.

Owner: Rasit. Date: 19 November 2026.

## Decision and implemented behavior

Settings configures a user-owned Gemini key through a main-owned Windows credential dialog. The main process supplies only its actual window handle/process identity and the utility's public expiring RSA challenge. The native helper seals its input directly to that utility recipient. Main forwards only sealed bytes, observes private review cancellation, and returns configured/off status. Cancelled entry returns a distinct null result; mismatched or failed entry cannot report a saved credential. Concurrent configuration cannot replace a recipient underneath an open dialog. Quit closes the owned helper before shutting down the utility.

The renderer has explicit validated state/configure/permission/forget/prepare/ask/cancel/stop capabilities. It never receives an API key, RSA challenge, sealed packet, raw IPC or generic filesystem capability. Renderer-supplied excerpts, private credential commands, arbitrary endpoint/transport fields and unconfirmed operations are rejected. Every response is validated.

Cloud permission is separate from configuring a key, recording permissions and an active session. It expires on app/service restart and privacy or explicit history maintenance revokes it. Settings changes pause active recording and never resume it automatically. Each question requires a local sharing review and a separately checked subset of its actual observations before Send. Local keyword/date/session/type search remains available without Gemini.

Search selects one to twelve actual observations from current results. The engine prepares immutable bounded metadata/excerpts and classifies window titles as title-only evidence. The user sees the exact question, records, timestamps and expiry. The official SDK receives only the approved pool, and its one read-only tool selects excerpts from that pool. Answers show actual source citations and uncertainty; missing information and provider failures are explicit. Page text, file contents, full file paths, query strings and fragments are omitted. The assistant cannot recover, overwrite, delete or confirm any operation.

Runtime state and review/answer receipts carry a fresh utility generation and an authorization revision. UI rejects stale responses, clears reviews/answers on authority changes and bounds display with wall and monotonic expiry. Selection changes cancel unused reviews; a late local preparation is cancelled after navigation. Leaving Search cancels an active question. Model output is rendered as text, including markup-looking strings. Reuse of the checkpoint evidence picker bounds the sharing list and long untrusted text wraps within the existing design system.

Underlying SDK work remains visibly busy until actual settlement, even after an abort acknowledgement. A settlement notification updates UI state; old work cannot be replaced with a fresh SDK instance. Actual encrypted-source failures fault the recording service and revoke cloud authority, while a bad provider response remains a bounded request failure.

## Synthetic verification boundary

Packaged tests use fresh marked temporary profiles and actual main/preload/utility/engine/cipher/SDK paths. An additional bounded `assistant-fixture.json` marker is read only from an already validated explicit CLI test profile. It enables a fixed offline responder and a synthetic sealed key. No endpoint, executable script or transport function can be supplied through a renderer or worker message. A nonsynthetic runtime rejects the fixture flag. Ordinary profiles use native entry and the fixed Google transport; building or opening the app grants nothing.

The offline responder supports deterministic answers, provider failure, insufficient evidence and abortable pending work. It never calls the network. The actual SDK, ciphertext persistence, source leases, approvals, response validation, renderer escaping and shutdown still run. This is a test seam rather than a normal-app success mock.

## Evidence and limits

Packaged assistant tests verify configuration without approval, local review before Send, unchecked-default sharing choices, selected-subset citations, escaped hostile markup, invalid public arguments, restart denial, provider failures, insufficient information, Stop and explicit key removal with history preserved. Utility tests additionally cover a transport ignoring abort and real encrypted source corruption. Main tests verify sealed-only routing, cancellation, recipient identity, concurrent configuration and honest closure failures. Existing Windows helper tests compile and exercise actual CNG/native-buffer-to-cipher interoperability.

No live Gemini account request or positive interactive Windows credential submission is claimed. The computer-use skill requires guidance that says, "Do not automate user authentication dialogs"; this run treats the credential prompt as covered by that rule and leaves interactive entry for manual acceptance. Tests do not use personal activity, real browser history or a live key. Independent security/provider-policy review, licensing, signing, installer/distribution and broader version-one features remain separate release gates.
