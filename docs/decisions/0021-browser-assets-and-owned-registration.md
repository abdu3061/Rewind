# ADR 0021: Packaged browser assets and owned per-user registration

Status: implemented locally for Rasit's review. The complete desktop setup manager, worker wiring and public browser controls remain in progress.

## Context and choice

The verified MV3/native/engine path needs actual distributable assets and owned registration. Shipping C# source alone or registering a test executable is insufficient. Compiling an installed host on a user's machine would add a runtime compiler dependency, and writing its configuration beside a packaged executable could fail in a protected installation directory.

Forge's `generateAssets` hook now compiles the reviewed host/broker/registration sources for Windows x64 using the Windows Framework64 C# compiler, then builds the normal extension with Vite. Development start and packaging run the same hook. Build output is ignored under `apps/desktop/.generated/browser`; the Vite plugin retains its normal ASAR input filter. `extraResource` places the directory at `resources/browser` outside ASAR. There is no host configuration, registration, native connection or consent grant in this hook.

An inventory pins the development extension ID and normal host name, native executable bytes/hash and each extension file's size/hash. Verification bounds file counts, sizes and aggregate bytes, rejects extra/missing files, traversal/case collisions, redirected asset directories and changed bytes. Full-width inode values and before/after nanosecond timestamps supplement hashing during bounded reads. Windows `lstat` and handle `stat` expose different device fields, so those fields are not compared. This checks package consistency; an adjacent inventory is not independent signature attestation or protection from a compromised application/same-user environment. Installation still needs native destination proof and verified creation.

## Registration primitive

The same compiled executable provides a private `--registration` mode. A typed utility adapter sends one bounded JSON request over stdin, with hidden-window execution, a deadline, bounded output and strict result validation. No renderer/browser API exposes an executable, registry path, host name, raw message or arbitrary command. The normal name is `com.rewind.bridge`; generated tests alone use `com.rewind.test.<nonce>`.

The native helper inspects the exact Chrome/Edge NativeMessagingHosts entry in both 32-bit and 64-bit per-user and machine views. Any machine entry is a conflict; machine keys are never modified. Unknown default values, extra named values, subkeys and expandable-string values are conflicts. Updates require the utility installer's previously verified owned manifest path. This primitive does not establish receipt ownership by itself; the setup manager must verify its durable receipt and files before passing that path.

New keys use `RegCreateKeyEx` with disposition checking rather than opening an entry that raced with creation. A per-user/browser/host named mutex serializes Rewind installers across processes; an abandoned mutex still triggers full state checks. Every write is read back, shared WOW64 keys are handled, and success requires the requested state in both views. Interruptions/uncertain results report failure and require inspection; there is no all-or-nothing cross-view registry claim or silent success after a partial write. The registry API has no compare-and-swap for an unrelated same-user writer: this is conservative ownership handling and serialization among Rewind instances, not hostile same-user attestation.

Removal deletes only the verified owned default value and verifies that registration is absent. It leaves empty keys in place, preserving other registry data and avoiding recursive key deletion. Reinstallation into these empty keys requires a retained ownership receipt. Test cleanup separately removes only its exact generated empty keys after successful unregister. No production host has been registered by development tools or tests.

## Required composition and evidence

The next setup manager must create a verified per-user host/config/manifest generation, durably record ownership before registration, handle interrupted/partial updates, verify actual desktop/browser images, stop/drain/revoke browser collection before maintenance and retain truthful per-browser status. Automatic updates or startup must not grant recording approval. The existing native mutual process/image/pipe proof remains required; registration alone never authorizes a browser observation.

Actual executable tests cover normal asset generation, PE/x64 output, rejection without configuration, hashes, missing/extra/changed/redirected assets, registration/update/removal in both views, conflicting foreign defaults/values/subkeys/types and concurrent installers. Installed Chrome/Edge relay and encrypted-session tests now use the production registration primitive with temporary names and profiles. The package test verifies the actual copied resources, all hashes and rejection without configuration. Full check/build/app/browser results are recorded in the integration report. No dependency or lockfile change is needed; build machines require the Windows Framework64 C# compiler. No runtime host compiler is introduced.
