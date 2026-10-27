# ChatGPT plan provider: implementation and validation

Date: 2026-10-28.

## Result

The optional `chatgpt-plan` provider is implemented against the existing Pi
`0.87.1` runtime. Both Pi dependency pins and the package lockfile are unchanged.
No production database migration is introduced. Product login and other model
providers retain their existing paths.

The implementation includes official dynamic registration and returning-client
authorization, verified ID tokens, encrypted registration/credential storage,
account-specific model discovery, native/full loopback callbacks, independent
account selection and strict public Responses inference through the old Pi
parser. Model execution validates the active connection's catalog and image
capabilities. ChatGPT quota failures do not spend a backup API key.

Credential refresh reloads the latest record under a shared PostgreSQL advisory
lock. Cancellation cannot discard an already rotated successor. If identity
verification fails after rotation, the encrypted checkpoint commits before the
error reaches the caller; it remains unusable for inference until validation
succeeds. Disconnect/revocation and credential removal share the same lock.

## Automated evidence

The candidate was rebased to `ec89d1ef`, independently reviewed and fixed;
see [review findings](chatgpt-plan-review.md). Final current-head CI
evidence belongs to the PR and does not retroactively turn live-provider gaps
into accepted behavior.

| Check | Result | Practical limit |
| --- | --- | --- |
| Full default offline run after review | 845 suites passed / 78 skipped; 13,860 tests passed / 841 skipped | Opt-in suites remain skipped; no real-provider success is inferred |
| PostgreSQL validation after rebase | 5 tests passed against an isolated PostgreSQL 17 container | Credential advisory locks and binding/removal row locks; no production database |
| Model-settings browser E2E after rebase | 1 expanded test passed; four screenshots inspected | Synthetic accounts and quota failure with scripted runtime |
| Repository TypeScript after rebase | `pnpm check`: 22 tasks successful | Native installation/device acceptance is separate |
| Web production build | Passed | Vite reported its normal large-chunk advisory |
| Repository Biome after rebase | `pnpm lint` passed | Existing warnings remain; no blocking errors |
| Patch whitespace | `git diff --check` passed | Local uncommitted review artifact |

The complete default run and the focused regression run are reproducible with:

```sh
NODE_ENV=test pnpm run test --maxWorkers=2 --reporter=dot

pnpm exec vitest run \
  chatgpt-plan pi-oauth pi-credentials model-selection model-vision pi-models \
  pi-runtime-models pi-runtime-fallback executor-oauth-retire \
  apps/api/src/router.test.ts packages/contracts/src/index.test.ts \
  packages/contracts/src/local-settings.test.ts \
  apps/desktop/src/browser-auth.test.ts apps/desktop/src/oauth-callback.test.ts \
  apps/web/src/lib/desktop.test.ts \
  apps/web/src/lib/use-model-oauth-signin.test.tsx \
  apps/web/src/pages/ModelSettingsOverlay.test.tsx \
  apps/mobile/lib/model-auth.test.ts

pnpm --filter @rakazo/adapter-kit --filter @rakazo/contracts \
  --filter @rakazo/adapters --filter @rakazo/api --filter @rakazo/worker \
  --filter @rakazo/web --filter @rakazo/desktop --filter @rakazo/mobile check

pnpm --filter @rakazo/web build
```

The browser E2E is named `ChatGPT plan model settings choose a saved account or
add a separate registration` in `apps/web/e2e/model-settings.spec.ts`. It ran in
the repository's isolated PostgreSQL/scripted-runtime harness. Its account-picker
and loopback-wait screenshots verify layout and selection using synthetic labels;
they do not verify real OpenAI authorization or backend-derived account labels.
The harness and ephemeral database were stopped after validation.

See [PostgreSQL validation](chatgpt-plan-postgres-validation.md) for the opt-in
command, actual lock contention evidence and checkpoint commit/rollback checks.
The disposable lock-validation container was also stopped and removed.

## Acceptance traceability

| Spec area | Owning verification |
| --- | --- |
| Dynamic/returning registration, callback binding, JWT/JWKS, scopes, refresh, pending rotation, revoke | `chatgpt-plan-auth.test.ts` |
| Exact request shape, old-Pi text/tool parsing, strict SSE completion, safe failures | `chatgpt-plan-provider.test.ts` |
| Model selection, image capability, unknown-model rejection | `model-selection.test.ts`, `model-vision.test.ts`, `pi-runtime-models.test.ts` |
| Shared refresh, stale snapshots, cancellation, checkpoint publication | `pi-credentials.test.ts`, `executor-chatgpt-plan-refresh.test.ts`, lock suites |
| Metadata/limits retention, token redaction, refresh timing | `chatgpt-plan-integration.test.ts` |
| Encrypted registrations, user isolation, corrupt-record repair, account-switch races, unavailable/empty catalogs | `apps/api/src/chatgpt-plan.test.ts` |
| Optional provider routes, hosted restrictions, transport injection, disconnect deletion, legacy provider compatibility | `apps/api/src/chatgpt-plan-router.test.ts`, `router.test.ts` |
| Native callback safety, local-web polling, account picker and mobile degradation | Desktop/web/mobile focused suites and browser E2E |

## Unperformed acceptance and scope limits

- No real ChatGPT account was authorized and no real OpenAI inference was sent.
  Account eligibility, actual model entitlements, quota behavior, token rotation
  against the live service and actual session revocation remain unverified.
- Native desktop E2E was not run on the local machine, as required by repository
  guidance. Actual installed macOS/Windows/Linux and mobile device acceptance
  remains unperformed.
- Backend-owned web callbacks require the browser and listener to share the host
  network. Local Docker desktop uses native callback capture. Container-only
  web loopback, VM credential transfer and managed/paid hosted authorization are
  not enabled or claimed as accepted by this change.
- Official request/model metadata is a preview contract. Unknown capabilities
  remain conservative; unsupported tools fail explicitly.
- An expired/unverifiable pending response may require reconnecting. Encrypted
  checkpoint recovery does not make an unverified token usable or extend its
  original lifetime.

## Review and rollback

Implementation and this spec remain together on `feat/chatgpt-plan-provider`,
rebased onto the current connection-binding contracts and committed for PR
review. No merge, release or deployment is part of this work. Unrelated changes
in the original checkout were preserved. The isolated worktree is retained for
review.

Rollback removes the optional provider registration and integration code while
leaving existing encrypted user data intact. No Pi version or database migration
needs reversing. Real-account acceptance should be recorded separately before
claiming a production-ready integration.
