# CI routing and test partitions

Repository CI selects checks from a pull request's changes. The router compares
its actual head with the merge base of its target branch, including deleted
paths and both sides of renames. Mixed changes take the union of their checks.
A missing comparison, empty diff, unknown path, shared package, dependency or CI
configuration change selects the complete matrix. Main pushes and manual runs
also select the complete matrix.

| Changed scope | Selected application checks |
| --- | --- |
| Allowlisted root documents and documentation assets | None; repository validation and router tests still run |
| `apps/www/` | Marketing build |
| `infra/compose/`, backup/restore scripts, shell test files | Lint/typecheck, ordinary unit tests and both shell test lanes |
| `apps/web/` | Lint/typecheck, Web build, ordinary unit tests, PostgreSQL integration and all selected Web E2E specs |
| Shared code, native apps, dependencies, tooling, or any unknown path | Complete matrix |

The exact allowlist is in `scripts/ci-router.mjs`. Add a narrower route only when
its transitive consumers and required tests are understood. Each run's repository
job summary records the reason and selected lanes. This first version routes
whole lanes rather than trying to infer individual browser journeys.

## Execution and coverage

- Ordinary unit tests exclude shell integration tests. Deployment tests have
  their own job; the remaining shell tests have a second job. Local `pnpm test`
  still discovers the default complete suite.
- `node scripts/check-ci-coverage.mjs` asks Vitest to discover each partition and
  verifies their union equals the default suite, with no duplicates or omissions.
  This check runs in the static lane, including every config/tooling change.
- PostgreSQL uses two jobs. The harness partitions its existing suite list after
  optional spec filtering, then retains a fresh database and process per suite.
- Web uses three Playwright shards and the existing full CI spec allowlist.
  Each shard gets its own backend and database. Files retain their existing
  internal sequencing; this does not enable full intra-file parallelism.
- Successful PR screenshots are collected across Web shards, then all existing
  acceptance screenshot groups are required and published under their existing
  names. Missing required screenshots still fail validation. Intermediate shard
  artifacts can be replaced on retry of the same workflow run.
- `CI result` always runs. It requires the router to succeed and every selected
  matrix job and screenshot validation to succeed. A failed or cancelled selected
  job cannot produce a passing result; intentionally unselected jobs are skipped.
  Main's mobile update waits for this result. Repositories requiring a status
  check can select the stable `CI result` name in their branch rules.

Examples:

```sh
node --test scripts/ci-router.test.mjs
GITHUB_EVENT_NAME=pull_request CI_ROUTER_BASE=origin/main CI_ROUTER_HEAD=HEAD node scripts/ci-router.mjs
node scripts/check-ci-coverage.mjs
CI_TEST_LANE=shell-deploy pnpm test
pnpm test:integration -- --sandbox=fake --runtime=scripted --shard=1/2
pnpm test:e2e -- --sandbox=fake --runtime=scripted --shard=1/3
```

Invalid shard arguments, unmatched integration filters and empty integration
shards fail before starting services. Default local commands do not require a
shard argument. Existing conditional database/provider tests retain their normal
prerequisites; partition coverage checks test discovery, not runtime acceptance.

## Performance budget

Aim for ordinary PR feedback within 5–10 minutes. Measure job wall time and the
slowest test files after changes; splitting jobs does not guarantee this budget.
The deployment file remains internally sequential and can still take over ten
minutes. Additional splitting should follow evidence instead of multiplying all
jobs. Complete runs preserve the existing regression coverage; they also build
the marketing site. Real model, sandbox and native-device acceptance remains a
separate validation task.
