# ADR 0039: Continue bounded folder scans without stopping recording

19 November 2026. Implemented locally for Rasit's architecture/privacy review.

## Problem

Automatic Desktop/Documents/Downloads setup exposed the selected-folder scanner's fatal 2,000-entry limit. A single overlong nested entry also set overflow and stopped every collector. Separately, the Windows activity helper treated a foreground process disappearing during lookup as a broken recording service. The user's existing operational log contains only `SERVICE_UNAVAILABLE`, so it cannot establish which source caused their reported incident. These are reproduced failure paths, not a claim that the specific incident has been conclusively diagnosed.

## Decision

The private native listing response may include `continuation` and a bounded `skipped` count. Each request visits at most 2,000 entries and yields after a 500 ms cooperative work budget, inside the existing helper request deadline. A helper keeps a depth-first enumeration cursor for at most 100 enrolled roots. Directory depth, path length, file size, reparse, case sensitivity, NTFS and sharing restrictions remain unchanged. Constant helper code is compressed before PowerShell command encoding to fit Windows' command-line limit; paths, requests and document bytes still use private stdin/stdout.

Every page verifies the selected root's original native identity. Each active directory frame also revalidates its saved native identity under current ancestor leases before advancing its enumerator. Unsupported long/deep entries and inaccessible or changed nested directories are skipped with visible incomplete-coverage status. An unavailable or replaced selected root remains fatal. Enumeration never grants file-read authority: every original-byte read independently repeats current root, path, native identity, sharing and size checks. Reparse targets remain inaccessible.

The collector processes one page per root per poll and retains observations across pages. Its change-detection cache is capped at 20,000 entries; eviction can cause a later verified capture to be published again. Storage retention and physical usage backpressure remain authoritative. Pending scan status distinguishes continuation from a completed pass. Pause/end/revoke still cancel the helper and await actual exit, discarding enumerators and queued work; no cursor survives worker restart or grants permission.

A missing foreground process produces no observation. Other helper failures remain fatal. Fatal capture-gap messages identify the application, file or browser source with fixed text and no private upstream diagnostics. Recording is never shown as active after a fatal gap.

## Verification

Native temporary fixtures cover complete enumeration beyond 2,000 entries, bounded paired response arrays, authority rejection between pages, supported files alongside overlong entries, existing replacement/reparse/hardlink/locked-file protections and cancellation. Collector tests cover cross-page change detection, visible skipped-entry status and stopped-page rejection. Stubbed user32 tests reproduce a disappearing process without observing personal activity. A packaged synthetic default-folder test combines more than 2,000 unsupported entries, an overlong entry and a recoverable supported file.

The build and observed check results are recorded in the [recording repair report](../audit/recording-service-repair.md). Physical Known Folder redirection and cloud/offline folder acceptance remain manual gates.
