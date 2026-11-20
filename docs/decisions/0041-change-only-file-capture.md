# ADR 0041: Capture changed files without importing existing contents

19 November 2026. User-requested policy change; locally implemented for Rasit's architecture/security review.

## Problem and policy

The user explicitly rejected initial recovery copies of every existing supported file and the resulting redundancy, parsing, storage and CPU cost. This supersedes the baseline-import policy described in ADRs 0038–0040. Application observations remain foreground-window metadata; filesystem activity does not identify which person or app made a save.

Only supported files created or changed during an approved active recording run trigger a recovery read. Startup, Resume and reopening do not import existing files or changes made while stopped. The first saved copy is the content after an observed save; pre-recording contents and intermediate saves that were never captured cannot be recovered. Existing retained history is not silently deleted and remains subject to retention/Keep and confirmed maintenance.

## Native change source

The existing Windows helper adds a private `watch`/`changes` protocol. One `FileSystemWatcher` per approved root is armed under native root/ancestor leases before collector startup commits. It uses LastWrite/Size/FileName notifications, recursive scope, a 16 KiB native buffer and at most 100 roots. Its callbacks inspect bounded relative names only, skip hidden-name/cache/build trees and unsupported extensions, and coalesce each path for 400 ms quiet time or a maximum two-second window. Its private queue holds at most 2,000 paths per root; native errors or overflow remain explicit capture gaps. Notification duplicates and overflow behavior follow the [official FileSystemWatcher documentation](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher.error?view=netframework-4.8).

Every drain revalidates the original root identity. Changed-file metadata uses current native path/ancestor/identity/sharing checks. A metadata failure returns an untrusted retry hint without following the path through a general filesystem existence API. Notifications never authorize a read. Immediately before reading original bytes, the collector rechecks current active engine authority, exclusions and native root/path/reparse/hardlink/size/sharing proofs; stale or stopped work is rejected and bytes are wiped.

Polling drains only the notification queue, normally once per second, without recursive scans or existing-file body reads. `list` remains available privately for bounded native verification/setup tests but is not used by recording. A pre-commit engine context is retried without content reads so other source startup cannot cause the collector to stop scheduling prematurely.

## Bounded work and duplicate suppression

The utility merges notifications into a 2,000-path backlog and handles at most 32 files or 32 MiB of source bytes per poll. Approved nested roots are covered by their already-approved ancestor instead of registering duplicate watchers/captures; conservative ASCII path folding avoids conflating distinct Unicode folder names. Exclusions still apply beneath that ancestor, and all stored folder approvals/identities remain unchanged. Locked/unavailable files get at most three read attempts with increasing delay; newer notifications can schedule subsequent legitimate work. Excluded/unsupported files never reach content reads. Idle polls send no progress snapshots, and progress notifications are batched rather than sent for every captured file.

There is no periodic full-body rehash, retention refresh or unchanged-version renewal. Changed bytes are hashed once; a bounded cache of 20,000 changed paths avoids duplicate publication within a run. After a restart/cache miss, the latest actually retained version for the resolved file ID is checked through trusted storage metadata. Equal hashes and lengths suppress a new version, activity record and derived-content indexing. A→B→A remains a real sequence of changes, while the existing content-addressed encrypted blob store shares identical original bytes.

The settings/renderer cannot provide a native notification or bypass source authorization. Main/renderer architecture, helper exit confirmation, encryption, current source receipts, recovery confirmations, Keep and quotas remain intact. Native watcher handles disappear with the acknowledged helper exit on Pause/End/revoke/worker shutdown; queued changes are not replayed after Resume or restart.

## Verification

Native synthetic fixtures prove that 2,500 existing files produce no startup import and that an actual save is delivered/coalesced with current root proof. Collector tests assert zero enumeration/content reads on idle polls, no retention refresh, deduplication after restart, bounded batches/retries, current engine authority, overflow reporting, stale-byte wiping and actual close retries. Runtime/app fixtures save explicitly after recording acknowledges active; they do not recreate production baseline import through a synthetic product mode.

The packaged performance fixture uses 2,501 existing files, checks zero idle versions, samples recording-engine CPU/working-set growth and checks that changed-only versions remain usable in Timeline/Search and after restart. These engine metrics do not include the external PowerShell helper and are not a universal whole-system benchmark. Results and remaining limits are recorded in the [implementation report](../audit/change-only-file-capture.md).
