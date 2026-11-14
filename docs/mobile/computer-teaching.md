# Mobile computer teaching (#148)

Target: `feature/mobile-parity`, based on `2bc6297b35d3a77e28e6eac9bf623b081c7e63b2`.
This includes #141–144 and #147; #145 and #146 are not prerequisites.

## Implementation and deterministic evidence

| Criterion | Implementation | Offline evidence |
| --- | --- | --- |
| C1 | Computer page exposes goal/start, recording status, stop and Bot-owned draft cards. During teaching, the existing framebuffer and native keyboard send ordered `computer/input` requests so execution and recording share the backend route. Touch coordinates use reported framebuffer dimensions. Stop drains input first. | `computer-teaching.test.tsx`, `teaching-input.test.ts`, `teaching-touch-surface.test.tsx`, existing `teaching-session.test.ts` |
| C2 | Name, when-to-use, inputs, steps, checks, return requirements, approvals and failure handling are editable. Test updates the current draft first; View result opens the Bot thread. Save updates, saves and reads the same persisted skill. Unsaved edits survive focus changes and failed writes. | `computer-teaching.test.tsx`, `taught-skill-editor.test.ts` |
| C3 | Saved cards open `/routine` with Bot/skill identity. The existing #141 screen reads the saved skill in its verified Space, checks Bot/status, and seeds its existing name/prompt fields using `formatSkillRunPrompt`. | `taught-skill-editor.test.ts` validates saved-only ownership and generated instructions; UI test verifies the existing route handoff. |
| C4 | Re-entry reads skills; failed or uncertain start/stop/status reads lock start until recovery. Transport requests are bound to Space/session and focus generation. Queued input is discarded on owner loss or failure; explicit reopening can recover without replay. Desktop-host/recovery states cannot start teaching. | Controller, UI and input queue tests cover restoration, failed reads/writes, scope cancellation and capability controls. |

This uses `skills` (Bot-specific taught playbooks), not #143's `agentSkills` shared documents.
No provider SDK, service configuration or database schema changed.

## Unproven boundaries — needs-owner

These tests use synthetic fixtures and substitute transports. They are not real-device or real-provider acceptance.

- iOS and Android application screenshots and full native touch/keyboard usability are unproven. Native simulator/device tooling was unavailable; no platform installation was attempted.
- Recording/executing against an authorized graphical computer and model is unproven.
- App/Web persistence readback against the same authorized instance is unproven. Both clients use the existing persisted skills API; unit evidence does not prove deployed interoperability.
- Native-only UI cannot be represented by the existing web CI screenshots. No unrelated screenshot is offered as evidence. Existing `apps/web/e2e/teach-task.spec.ts` covers the web teaching screen; it does not establish mobile parity.

For owner verification, use a synthetic list export: start on each platform, enter text and click/drag/scroll, stop, edit every field, test and inspect the Bot thread, save, reopen, read the same skill on Web, and open the prefilled routine. Repeat with lost responses and a Bot/Space switch. Record application/backend commits and platform versions with screenshots.

## Verification and cleanup

Development used Node 22 and Corepack pnpm 9.15 with the existing offline cache and single-worker targeted Vitest runs. Mobile and core type checks, formatting, localization coverage, teaching controller/UI/input tests, and existing recording/keyboard/routine-editor/session regression tests were run. No PostgreSQL service, test database, role or connection was created; no app server, simulator, browser, paid upstream or production instance was started.

CI and independent acceptance are managed separately. No acceptance session was started by development; at most two independent rounds are allowed. The reported PG2 model-connections / parallel routines-create failure is outside this path, was not reproduced here, and is not described as flaky.

## First acceptance revision: keyboard ownership and original regressions

First acceptance on `7354e3db8c4a992e56f9634c131e16be377a711c` failed F1 and F2. The original offline evidence above did not cover the page's pre-ready keyboard buffer or the two original computer-page suites.

- **F1 negative control:** before changing product code, the permanent page test restored a recording, opened the computer, withheld keyboard-ready, typed synthetic text, closed the computer and stopped teaching. It failed because no `computer/input` was dispatched. The ready-first control passed and waited for a pending input request before stopping.
- **F1 fix:** recording commands now enter the teaching queue immediately and never enter the renderer's keyboard-ready buffer. Closing the renderer cannot discard those commands; the existing stop drain owns them. Both ready-before-input and delayed-ready cases pass, stop waits for pending input, and a late ready message does not duplicate input. A separate page test preserves ordinary non-recording keyboard buffering and one-time delivery after ready.
- **F2:** the original 39 computer-screen/visibility tests first reproduced their missing `useRouter` mock failures. Fixtures now supply the router, native controls, scoped synthetic request context and empty skills list needed by the real teaching component. All original behavior assertions remain; all 39 pass. This was a test-fixture failure, not evidence of an actual native application crash.
- **Verification:** eight targeted files / 70 tests pass, covering both original page suites plus keyboard, teaching UI/controller, input queue and touch mapping. Mobile type/SDK checks and Biome pass. Node 22 / pnpm 9.15, `nice -n 10`, one worker, no file parallelism, existing caches; no database or native platform installation.

This is a development repair for the second and final independent acceptance round, not an independent acceptance verdict. Real-device, authorized provider/model and same-instance App/Web evidence remain unproven / needs-owner. No additional user-facing copy was introduced.
