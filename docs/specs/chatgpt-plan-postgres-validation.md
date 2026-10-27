# ChatGPT plan PostgreSQL lock validation

Date: 2026-10-28.

The rebased candidate based on `main` commit `ec89d1ef` passed both opt-in suites
together: **5 of 5 tests passed** against a fresh disposable PostgreSQL 17
container after applying the repository's migrations. The suites used independent
Prisma clients, synthetic credentials, and mocked OAuth HTTP; no OpenAI service
or real account was contacted.

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

Reproduction uses the repository's existing opt-in PostgreSQL test conventions:

```sh
DATABASE_URL='<disposable PostgreSQL URL>' pnpm --filter @rakazo/db migrate
VERIFY_DATABASE=1 DATABASE_URL='<disposable PostgreSQL URL>' pnpm exec vitest run \
  packages/adapters/src/chatgpt-plan-credential-lock.postgres.test.ts \
  apps/api/src/model-bindings.postgres.test.ts
```

The credential-lock suite creates and drops its own randomly named table. The
binding suite removes its synthetic account and organization fixtures. The
validation container was removed, and its absence was verified after the run.
This verifies shared database locks, transaction behavior, and binding/removal
interleavings; real-account authorization, model access, quota behavior, and
native desktop acceptance remain untested.
