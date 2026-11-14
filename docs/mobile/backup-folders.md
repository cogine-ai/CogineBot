# Native backup folders (#156)

The current Import bot editor offers **Choose backup folder** alongside **Choose
package file**. A successful selection replaces the source only after inventory,
bounded reads, shared projection and a second inventory check finish. Preview and
Import as new bot remain separate explicit actions. Archive recovery stays available.

## Implementation

- iOS: opening-mode folder picker, temporary security-scoped access and coordinated
  reads. Only local application Documents directories are accepted; ubiquitous
  items and other locations are rejected.
- Android: `ACTION_OPEN_DOCUMENT_TREE`, read-only access and `DocumentsContract`
  child queries. Only the system external-storage provider is accepted. Loading or
  error cursors, unknown sizes, virtual documents and repeated IDs fail selection.
  No persistent grants or broad storage permissions are requested.
- Hidden entries are included. Native traversal counts directories against the
  shared 2,000-entry limit and additionally caps depth at 64. Shared encoding owns
  path validation, normalization collisions, workspace selection, Skill dependency
  checks and content limits. Native readers enforce the supplied shared limits:
  400,000 bytes per read file and 4 MiB across reads.
- Native URLs/document IDs stay in an opaque session. Only relative paths, sizes
  and bounded bytes cross the bridge. Only projected content reaches preview.
  Credential reads retain the base branch's explicit opt-in and model matching;
  no model preference behavior is introduced.
- Cancellation preserves the old draft. Permission, inventory and selected-file
  read failures reject the new selection, including optional-config I/O errors.
  Existing shared omissions for known unsupported/oversized optional content stay
  visible in review. Changed inventory or byte lengths cannot publish partial data.
- Scope changes and newer edits reject late results. Replacement, completion,
  recovery and editor cleanup dispose the session. iOS releases security-scoped
  access; Android drops session references (the OS controls the lifetime of its
  temporary activity grant). No backup is copied to an app cache.

## System / file provider matrix

Device access was not authorized. No row claims real native compilation, a tested
OS version, successful system authorization or production provider certification.
Both native implementations exist; **both platform acceptance checks remain
unfinished**, pending real builds and system-provider evidence.

| System / provider | Implemented behavior | Evidence / boundary |
| --- | --- | --- |
| iOS / local app Documents visible in Files | Folder picker, scoped coordinated traversal and reads | Swift syntax and module discovery only; build, picker visibility, hidden entries, revocation and import unproven |
| iOS / iCloud Drive | Reject; use archive | Logic inspected; real picker behavior unproven |
| iOS / third-party File Provider, shared containers or other locations | Reject; use archive | Completeness is not guaranteed; no provider certification |
| Android / system external-storage provider, primary or removable | SAF tree selection, child queries, bounded reads | Module discovery only; build, authorization, hidden entries, media removal and import unproven |
| Android / Downloads, cloud or third-party DocumentsProvider | Reject; use archive | No complete-enumeration contract accepted; device behavior unproven |
| Expo Go / builds without the module | Error and archive recovery | Offline missing-module test; directory support unavailable in these builds |

Android root-selection restrictions remain in force. iOS folders must be in a
selectable local Documents location. Failure shows “Could not read the complete
folder. Choose a backup archive instead.” only after a failed attempt. Fallback
does not complete C1 or certify a platform.

## C1–C4 evidence

| Criterion | Implementation / substitute evidence | Still unproven |
| --- | --- | --- |
| C1 | Both modules and current Bot import entry; UI tests require preview and explicit confirm | Real builds, system grants/reads, screenshots and persisted imports on both platforms |
| C2 | Synthetic OpenClaw/Hermes ZIP/folder tests compare selection groups, hidden dependency warnings, projected files, server-parsed documents and warnings with memory on/off; old regressions retained | Persistent backend/Web cross-read; arbitrary layouts and provider enumeration |
| C3 | Offline cancellation, permission, incomplete inventory, unreadable required/optional files, entry/file/total limits, changed inventory, stale scope and late-result tests; archive recovery | Native OS revocation and provider failures during reads |
| C4 | Matrix distinguishes implemented adapters, rejected providers and unfinished acceptance | Actual OS/provider versions and screenshots |

ZIP ordering is not semantic; projected files are compared by path. Existing
archive manifest/owner binding and conservative shared directory rules remain.
This does not claim universal equivalence for arbitrary layouts or manifest metadata.

Offline fixtures and mocked native access are substitute evidence only. Swift
parsing and Expo discovery do not compile or run native code. No offline bundle is
presented as device proof. No device, emulator, server or paid upstream was used.
Native-only UI cannot be captured by web CI; no unrelated screenshot is substituted.

Authorized acceptance must record actual OS/provider and app/backend commits,
walk folder → preview → confirm for both backup formats, exercise cancellation,
revocation, incomplete/unreadable/oversized selections and scope changes, then
cross-read synthetic imported Bots from Web. Management schedules independent
acceptance; this development turn does not wake it.


API references: [Apple directory access](https://developer.apple.com/documentation/uikit/providing-access-to-directories)
and [Android DocumentsContract](https://developer.android.com/reference/android/provider/DocumentsContract).
These describe the APIs, not validation of this implementation.
