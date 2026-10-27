# ChatGPT plan provider review

Date: 2026-10-28. Comparison base: `ec89d1ef`.

The implementation was reapplied to the current model connection/revision
contracts before review. Pi remains pinned to `0.87.1`. Real-account acceptance
identified a required forward migration expanding the account-scoped secret
allowlist for ChatGPT registration records; no runtime replacement is introduced.

## Standards

The review covered `AGENTS.md`, `CONTRIBUTING.md`, the PR template and ownership
of adapters, contracts and UI presentation. New import declarations use separate
type imports. Model capabilities come from the authorized account catalog rather
than model-name inference; secret storage and model binding reuse the existing
interfaces. Fixed recovery URLs have one shared source. Native transport and
request/UI state remain separate from token verification and orchestration.

No unresolved documented-standard violations were found in the reviewed change.
Repository lint/type checks, patch whitespace checks and a redacted staged
secret scan complement this review; warnings in unchanged sources are not
reported as new provider defects. No speculative provider framework, alternate
agent runtime or unrelated UI redesign was introduced.

## Spec

The independent authorization, runtime/concurrency and UI reviews identified
the following concrete gaps; each was fixed with regression coverage:

| Finding | Resulting behavior and evidence |
| --- | --- |
| Pi wraps refresh errors, hiding a direct WeakMap checkpoint lookup | Bounded, cycle-safe cause traversal preserves the encrypted successor checkpoint through Pi errors; auth and actual executor regressions cover publication |
| Safe formatting discarded documented terminal refresh codes | A shared allowlist preserves official codes; terminal-status and lookalike/transient matrices verify retirement classification |
| Account switching carried a previous account's model ID | Saved-account/new-account starts omit that ID; hook/settings/E2E tests cover the selected registration |
| A failed profile lookup looked like an empty account list | Only ChatGPT authorization is disabled with scoped recovery copy; unrelated model settings remain usable |
| A binding could appear after disconnect reference checks | Binding `FOR SHARE` and disconnect `FOR UPDATE` serialize the pin write and removal; real PostgreSQL tests cover both orders and a stale Serializable snapshot |
| A reconnect could change the target while disconnect waited | Exact credential/secret/revision fences and an absent-to-present check refuse stale removal before any remote revocation |
| First credential publication could race past an empty disconnect check | Finalization and disconnect share a user/provider transaction lock; a PostgreSQL control reproduces the original absence gap and both guarded orderings pass |
| Generic OAuth client/host fields selected ChatGPT-only validation | The existing ChatGPT catalog marker selects strict validation; bare/wrapped generic records and malformed ChatGPT records have regression coverage |
| Web catalogs lacked new messages and retained the previous sign-in ID | Relevant extracted entries and translations cover all ten locales, with catalog compilation and per-locale regressions |
| A database-wide lock probe could count an unrelated waiter | The probe matches backend, database, exact advisory key and two-integer lock form; an unrelated-key negative check and real PostgreSQL validation pass |
| Acceptance criteria contained joined words | Host address, client IDs, model and surface criteria retain their meaning with readable spacing and punctuation |
| Real callback reached the listener but registration storage failed before token exchange | The existing database scope constraint rejected the new registration kind; a narrow forward migration and real PostgreSQL registration-path regression cover the storage boundary |
| Usage failures were generic and lacked the promised recovery link | Actual Pi error normalization exposes a fixed recovery action on web/mobile; settings/error E2E screenshots verify the trusted link |
| A disconnected placeholder claimed one available model | It now displays only the sign-in state until account discovery succeeds |

The native callback review covered state/PKCE/nonce, client-ID reuse, replay,
identity/audience/issuer checks, cancellation, token-bearing callback rejection,
pending credential execution guards and HTTPS origin pinning. No additional
actionable issue remained in those reviewed boundaries.

Real-account authorization/inference and installed native acceptance were not
run. They remain explicit acceptance gaps, rather than inferred successes from
offline tests or synthetic browser screenshots. The verification record is
[validation](chatgpt-plan-validation.md), including the separate
[real PostgreSQL lock report](chatgpt-plan-postgres-validation.md).
