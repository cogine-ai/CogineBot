# Preparation baseline

Recorded on 2026-10-09 for upstream revision `794a76da6eb0a73532a89cf57d2f202ef9b6b6c8`. These checks preceded the documentation-only CogineBot initialization. Runtime source and the dependency lockfile were unchanged.

## Executed checks

| Check | Result and scope |
| --- | --- |
| Source integrity | Complete history reachable from the fixed revision retained; clean upstream tree and Git object integrity checks passed. |
| Dependency installation | pnpm 9.15.0, frozen lockfile, install scripts disabled. Prisma generation performed explicitly. |
| Type checking | Passed; 22 successful Turbo tasks. |
| Lint | Exit 0; 19 warnings and 4 informational findings retained. |
| Web production build | Passed; existing bundle-size warning retained. API/worker validation used type checking and the selected runtime checks; no desktop/mobile release package was built. |
| Default offline Vitest | 7,456 passed, 2 failed, 231 skipped; exit 1. This baseline is not fully green. |
| Selected PostgreSQL checks | 10 suites, 94 passed, no failures or skips. Dedicated PostgreSQL 16.13; each suite used a separate database. |
| Selected web browser checks | Four specs, 23 passed in headless Chromium with a real local API/database, scripted agent runtime, and fake sandbox. |

Environment: macOS arm64, Node.js 24.16.0, pnpm 9.15.0, Prisma 7.10.0, PostgreSQL 16.13, Playwright 1.63.0. Docker daemon was unavailable; the selected native PostgreSQL checks do not establish that the official full Docker/Testcontainers lane passed. Skipped tests are not passing tests.

PostgreSQL suites: `pi-offline.postgres`, `authorization`, `attachments`, `executor-lifecycle`, `journeys`, `space-membership.postgres`, `wakeup.postgres`, `realtime.postgres`, `usage-accounting.postgres`, and `job-reconciler.postgres`.

Web specs: `peer-messages`, `artifact-preview`, `markdown-table`, and `spaces`. They cover selected registration, Space, peer messaging, preview, and download paths. Component CSV download checks do not establish real-model task quality.

## Known test failures

Two launcher tests failed and reproduced in a single-worker rerun with the original host PATH:

- `infra/sandboxes/supervisor/src/focus-or-launch.test.ts`: the launcher's expected argument record was empty.
- `packages/adapters/src/linux-desktop.focus.test.ts`: the expected process record was absent after the wrapper returned success.

The launcher probes can return success after a 0.2-second wait without guaranteeing that the launched process has written its initial record. A synthetic probe confirmed that timing window. A rerun using a different PATH/Python version passed locally, which does not prove a fix or identify the complete platform cause. Linux execution was not part of this native baseline; subsequent repository CI results are separate evidence. No source or test changes were made to hide these failures.

## Dependency and provenance review

A single `pnpm audit --prod --json` returned 81 matching advisory entries: 1 critical, 48 high, 28 moderate, and 4 low. The entries correspond to 71 distinct GHSA identifiers across 26 package names; they are version/dependency-graph findings, not 81 confirmed exploitable runtime paths.

The critical match is [`shell-quote@1.10.0`, GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv), present in API/worker adapter dependency chains. The project's executor imports `parse`; the installed Daytona SDK also imports `quote`. The advisory concerns specific inputs to `quote()`. Actual vulnerable input and execution reachability were not established. Runtime-chain candidates also include `@modelcontextprotocol/sdk`, `nodemailer`, and `sharp`; configuration and deployment conditions need further review. Dependencies were not automatically upgraded during baseline capture.

Root Apache-2.0 text and existing source notices are retained. Identified copied MIT material receives full license text in `THIRD_PARTY_NOTICES.md`. A bounded reachable-history text scan produced candidates classified as fixtures/examples; it did not confirm live credentials. Binary-only and uncovered content remain outside that conclusion. Source attribution, asset provenance, and any future binary distribution review are separate obligations.

## Validation boundaries

These preparation checks did not establish real-model task quality, real computer recovery, shared-hosting isolation, or release readiness. They do not define a product roadmap or require a particular role count, workflow, or output format.

No paid model calls, real computer workflow, public deployment, or company release were part of these preparation checks.

Updated on 2026-10-09 to separate recorded validation from unconfirmed product ideas; the original check results are retained.
