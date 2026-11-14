# Native backup folders (#156)

**Android directory import is incomplete and technically blocked.** The previous
SAF implementation could accept a successful but incomplete inventory. It has
been removed and replaced with an explicit failure. Archive recovery is still
available; it does not fulfill Android directory import or complete this ticket.

iOS retains **Choose backup folder** in the current Import bot editor. A successful
selection replaces the source after bounded traversal, shared encoding and a change
check. Preview and Import as new bot remain separate actions. Neither a second
scan nor an unchanged file list is presented as proof of completeness.

## F1: incomplete Android inventory

The old system-provider whitelist and error/loading checks were insufficient.
AOSP's [FileSystemProvider](https://android.googlesource.com/platform/frameworks/base/+/01cd624ac1c185acef0ce51d4e5d65e7095c3692/core/java/com/android/internal/content/FileSystemProvider.java)
uses `listFilesOrEmpty` in child queries; its metadata tree walk also continues past
failed visits. [FileUtils](https://android.googlesource.com/platform/frameworks/base/+/fbd5595517061bb8965b4f1a6cdc16009df66cbe/core/java/android/os/FileUtils.java)
turns a null file listing into an empty array. Authority, successful cursors,
repeated scans and metadata counts therefore cannot certify the missing subtree.

The native Android module now rejects directory selection. The JS boundary also
rejects successful Android selections from older installed native modules and
releases their sessions before any file read or shared projection. Permanent
negative controls return successful stable full-looking and partial inventories;
the latter omits a hidden Skill dependency. They demonstrate that the incomplete
input loses its warning under shared encoding, then require rejection by the
actual mobile adapter. Existing error/cancel/scope/draft/archive tests remain.

[等 ZenYang] A usable Android implementation still needs a reviewable reader that
reports traversal failures without filtering or silently omitting descendants,
and authorized native build/provider validation. The investigated SAF APIs supply
no such proof. A URI grant is not a trustworthy raw filesystem path. This change
does not guess paths, request broad storage access, require a new backup manifest,
or claim that an archive fulfills the directory requirement. Any different access
mechanism must be scoped and authorized separately; the requirements are unchanged.

## F2: iOS source boundary

The old predicate searched for a name sequence anywhere in the selected path.
The replacement anchors to the canonical parent of the running app's OS-assigned
`NSHomeDirectory()`. It fails closed unless that home has the expected app container
layout, then requires the selected canonical path to be an immediate UUID app
container's Documents directory or descendant under that exact root. Names nested
under shared or arbitrary roots cannot establish trust. Security-scoped access,
local-volume/ubiquitous checks and coordinated error-reporting traversal remain.

This is a storage-location boundary, not a provider identity certificate or an OS
authorization bypass fix. The production Foundation-only helper is executed against
12 positive/negative cases, including valid UUIDs inside forged shared/arbitrary
paths, component-prefix collisions, traversal and an unknown runtime-home layout.
That host test does not compile or run the iOS module or picker.

## Shared behavior retained

- The iOS reader includes hidden entries, counts directories against the shared
  2,000-entry budget, caps depth at 64, and applies the shared 400,000-byte per-file
  and 4 MiB total-read limits. Shared encoding owns path validation, collisions,
  workspace selection, Skill dependencies, content selection and existing omissions.
- Only projected content reaches preview. Existing explicit credential opt-in and
  model matching remain; no model preference rules are added.
- Cancellation and failed reads preserve the draft. Unreadable optional inputs also
  reject native selection. Scope changes/newer edits discard late results. Source
  replacement, completion, recovery and cleanup release scoped iOS sessions.
- Archive/folder synthetic parity covers content, hidden dependencies, selections,
  warnings and server-parsed documents with memory on/off. ZIP ordering is not
  semantic. Existing manifest/owner rules remain; arbitrary layouts are not certified.

## System / provider matrix

| System / source | Current behavior | Evidence / unfinished work |
| --- | --- | --- |
| iOS / Documents under the runtime-anchored app-container root | Scoped coordinated traversal and reads | Host boundary tests and syntax only; real native build, picker, grant, hidden entries and import unproven |
| iOS / shared containers, arbitrary roots, provider caches outside that boundary | Reject, including nested lookalike container paths | Actual production Swift boundary negative controls; OS/provider behavior unproven |
| iOS / ubiquitous cloud items or nonlocal volumes | Reject; archive recovery | Code inspection; device behavior unproven |
| Android / all providers, including system external storage | Explicit failure; no usable directory reader | **Platform directory implementation incomplete / technically blocked**, not merely missing device evidence |
| Expo Go / build without module | Error and archive recovery | Missing-module regression; no directory support |

No actual OS/provider version is certified. In particular, no row claims Android
complete enumeration, nor that any third-party provider name alone determines an
iOS path's origin. The existing translated recovery message is shown only after a
failed attempt; no new copy or archive-product exemption is introduced.

## C1–C4 evidence and handoff

| Criterion | Current implementation / substitute evidence | Not complete |
| --- | --- | --- |
| C1 | iOS module and explicit preview/confirm UI | Android directory implementation; both platforms' real build/grant/import evidence |
| C2 | Synthetic shared/mobile/server projection parity retained | Android directory workflow and actual backend/Web cross-read |
| C3 | Successful incomplete Android results now fail closed; old cancel/error/limit/scope/draft recovery tests retained | A usable trustworthy Android reader; real OS revocation/provider fault testing |
| C4 | Matrix corrected to distinguish implemented iOS source boundary from Android technical blocker | Actual OS/provider certification and screenshots |

Do not mark #156 PASS or close it from these safety fixes. Independent acceptance
has used round 1 of 2; management schedules the second/final round. The development
session does not wake acceptance or start a third round.

Offline tests use synthetic fixtures and mocked native access. The Foundation
boundary executable, syntax checks and module discovery are not iOS/Android native
builds or device evidence. No device, emulator, server or paid upstream was used.
Native-only UI cannot be captured by web CI; no unrelated screenshot is substituted.
