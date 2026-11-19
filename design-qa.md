# Rewind desktop / notch visual verification

Source truth: user attachment `b763c9f2-ee83-4c11-a91f-77f57de7ed39/image-2.png` (1672 × 941) and `image-1.png` (1254 × 1254). The first defines a premium native overlay concept; wallpaper, annotations, unsupported microphone/shortcut claims and illustrative answers are context, not app content. The mascot sheet defines glossy blue/lavender arrow character direction. The full desktop retains its existing page structure as explicitly requested.

Implementation: real packaged Electron screenshots under `docs/design/premium-notch/`. Expanded native window is 760 CSS/DIP pixels wide at device scale 1; compact native bounds 144 × 64. Desktop client is 1149 × 761 at scale 1 (1180 × 800 outer Windows window). Full-page captures extend vertically through the existing forms. No source design exists for those full-app pages; review them for consistency, readability and preserved workflows, not fictional pixel fidelity.

## Comparison history

Iteration 1 combined evidence: [comparison-iteration-1.png](docs/design/premium-notch/comparison-iteration-1.png). Source central panel cropped at (302,145), 1068 × 230, normalized to 760 × 164; implementation shown at actual 760-pixel width. Both appear in the same technical comparison image, with the source overview below. Focused panel comparison makes typography, actions, mascot and spacing readable.

- [P2] Quick-action affordances too weak. Source has distinct soft glass buttons; implementation has bare labels and an icon-only recovery shortcut. Add bounded tinted button surfaces and a visible Restore file label.
- [P2] Dashboard cards misaligned by a generic adjacent-panel margin. Restrict that margin to direct main children; keep the existing two-card grid aligned.
- [P2] Dashboard routes are buried below the full consent form. Move its existing Timeline/Files cards immediately below session controls, with all approval disclosures retained in the form below. This improves the first viewport without weakening consent.
- [P2] Small notch metadata and command type need more comfortable optical sizing. Increase command input to 14px and functional status/footer/open controls to 11px; maintain high-contrast navy/lavender tokens and visible focus rings.

Revised combined evidence: [comparison-final.png](docs/design/premium-notch/comparison-final.png), with the same normalized source crop and real 760-pixel implementation. Quick actions now have contiguous tinted surfaces and a visible Restore file label; input/status text is more legible. The [dashboard](docs/design/premium-notch/dashboard.png) verifies aligned cards and visible routes above the retained consent form. The earlier dashboard issue was observed in the initial full-page capture in this conversation; the saved `dashboard-iteration-1.png` already shows its correction. No remaining actionable P0/P1/P2 visual findings were found in the revised comparison.

A subsequent search capture revealed a transient clipped frame before native bounds caught up with ResizeObserver. Capture now waits for measured panel height to fit the actual window viewport. The revised [search response](docs/design/premium-notch/notch-search.png) includes all five actual matches, the bounded scroll region and persistent footer. This was capture timing, not a fixed-height panel or hidden final controls.

## Required surfaces

- Typography: local Segoe UI Variable/Segoe UI system family, matching the reference's modern rounded system-UI direction without a remote font. Input is 14px, functional utility text 11px, actions 12px; headings/body use the established desktop hierarchy. Rechecked focus rings, weight, small text and wrapping in the revised captures. The concept is art direction rather than a font specification; its source typeface is not identified.
- Spacing/layout: actual native bounds include only eight-pixel shadow margins; dynamic height avoids a large invisible click target. Response area scrolls. Narrow/short work areas retain access through scrolling and Tab. Dashboard cards are aligned and precede the consent form. The real overlay is intentionally taller than the 760 × 164 normalized concept crop because it adds native restore/hide controls, truthful source status and permission access. Its 760 × 270 idle window and 760 × 506 response window remain compact and bounded; no wallpaper is embedded.
- Colors/tokens: navy sidebar/overlay, restrained blue/lavender/purple accents, soft bordered light desktop cards. Actual recording uses a small rose indicator; session-active alone never claims recording.
- Image quality: genuine transparent 1254 × 1254 generated arrow PNG, inspected at source and in 40/74-pixel UI sizes. Character uses real raster art; standard interface icons use the pinned Phosphor library. No simulated raster artwork or screenshot-as-UI.
- Copy/content: concise product copy, explicit local search labels, actual source-derived matches and acknowledged operations. Consent, sensitive-title, source limitations, recovery warnings and cloud reviews remain in their real workflows. No microphone, fake answer, unsupported shortcut legend or fabricated success.

## Interaction evidence

Packaged synthetic-profile tests verify compact inactive appearance, hover, Escape, Tab/Enter access, native click-away, hide, native restore, second-instance activation, page/draft preservation, smaller isolated bridge, actual recording synchronization, local matches, reviewed checkpoint persistence, concurrent-observation selection stability, deletion invalidation and acknowledged active-recording close/restart. Both renderer page errors and console errors are checked by the transition test; none were observed. Full regression/release reproduction is recorded separately in the implementation report. Physical display hotplug, every fullscreen app and assistive-technology acceptance are separate from mocked monitor geometry coverage.

Final result: passed

No remaining actionable P0/P1/P2 visual findings. Existing independent security, native live-account, physical-device and release acceptance gates remain unchanged.
