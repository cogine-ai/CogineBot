# ChatGPT plan PostgreSQL lock validation

Date: 2026-10-28.

The PR follow-up candidate based on `dc444133` (`main` base `ec89d1ef`) passed all
three opt-in suites together: **8 of 8 tests passed** against a fresh disposable
PostgreSQL 17 container after applying the repository's migrations. The suites
used independent Prisma clients, synthetic credentials, and mocked OAuth HTTP;
no OpenAI service or real account was contacted.

All eight tests also passed through the official integration harness on its
isolated PostgreSQL 16 databases. The three suites are registered in that
harness, so the repository CI integration lane will execute them.

Real browser callback acceptance then exposed a missing scope allowlist entry
for account-level registration secrets. Before the forward migration, both new
registration tests failed on `secrets_scope_check` (`23514`). After applying the
migration to a fresh PostgreSQL 17 database, all four suites passed together:
**10 of 10 tests passed**. The new suite is also registered in the official
integration harness.

The [PostgreSQL 16 integration job for `832ea785`](https://github.com/cogine-ai/CogineBot/actions/runs/40584176943/job/122471359006)
subsequently passed all four suites: three model-binding tests, three
first-finalization tests, two registration tests and two credential-lock tests.
This CI result extends the earlier eight-test harness run above.

The regression uses the production login factory, encrypted secret store and
Prisma persistence wrapper. A separate database query verifies the registration
is committed and encrypted before the synthetic token endpoint is called. It
also checks incomplete-registration retention, returning-client reuse, owner
isolation, and the account-only/space-only scope matrix for existing, new and
unknown secret kinds. Only OAuth HTTP is mocked. The same wrapped registration
write passed with an intentional rollback in the isolated live acceptance
database after its migration; no probe records remained.

A later registration-publication review added three concurrency cases. All
three failed against the old implementation and passed after the profile-lock
fix. Separate Prisma clients exercise both sign-out/login orders and two
verified completions that began from the same incomplete registration. The
tests use real signed ID-token/JWKS verification, encrypted records and the
production persistence wrapper; only OAuth/model HTTP is synthetic. Sign-out
retains the latest verified identity and label, and a competing completion
cannot replace an already verified subject. The registration suite now contains
five tests and remains in the official integration harness.
The resulting four-suite batch passed all 13 tests through that harness.

- PostgreSQL reported a waiting advisory lock for the second client. Its callback
  could enter only after the first credential transaction committed.
- A recognized pending-rotation error committed the synthetic checkpoint row
  before the error reached the caller. An ordinary error rolled its row back.
- A ChatGPT binding held `FOR SHARE` through its scalar bot-pin write. A competing
  removal's `FOR UPDATE` waited, then saw the committed reference and refused to
  remove the connection.
- When removal acquired `FOR UPDATE` first, the waiting binding found the
  connection removed and inserted no dangling bot pin.
- A Serializable binding with an older snapshot failed to lock a removed
  connection and inserted no bot pin. PostgreSQL reported `40001`, surfaced by
  Prisma as `P2010` with the driver's transaction-conflict metadata, which the
  existing transaction retry helper recognizes.
- A control reproduced the first-login race: without a user/provider lock, an
  absent-row check allowed a concurrent credential insert to survive a prepared
  empty removal.
- With the shared connection lock, first finalization ahead of an empty
  disconnect blocked that disconnect until publication committed, then the
  disconnect detected the changed connection and refused to report empty success.
- With empty disconnect ahead of first finalization, publication blocked at the
  exact gap after the absent-row check until the removal transaction committed.
  The finalization transaction used the production Serializable isolation level.
- The credential-lock probe was subsequently narrowed to its exact backend,
  database, advisory key and two-integer lock form. Both credential-lock tests
  passed again on fresh PostgreSQL 17, including an unrelated-key negative check.

Reproduction uses the repository's existing opt-in PostgreSQL test conventions:

```sh
pnpm test:integration -- --sandbox=fake --runtime=scripted \
  '--spec=(chatgpt-plan-(credential-lock|finalization|registration)|model-bindings)\.postgres\.test\.ts'

# To use a separately managed disposable PostgreSQL database:
DATABASE_URL='<disposable PostgreSQL URL>' pnpm --filter @rakazo/db migrate
VERIFY_DATABASE=1 DATABASE_URL='<disposable PostgreSQL URL>' pnpm exec vitest run \
  packages/adapters/src/chatgpt-plan-credential-lock.postgres.test.ts \
  apps/api/src/model-bindings.postgres.test.ts \
  apps/api/src/chatgpt-plan-finalization.postgres.test.ts \
  apps/api/src/chatgpt-plan-registration.postgres.test.ts
```

The credential-lock suite creates and drops its own randomly named table. The
binding and finalization suites remove their synthetic account and organization
fixtures. The PostgreSQL 17 validation container was removed, and its absence
was verified after the run. The official harness completed its own teardown.
This verifies shared database locks, transaction behavior, and binding/removal
interleavings, including first publication into an empty connection slot;
these PostgreSQL suites do not establish real-account authorization, model
access, quota behavior or installed native acceptance. See the dated manual
acceptance snapshot in [validation](chatgpt-plan-validation.md) and the PR's
separate live acceptance record for that evidence.
