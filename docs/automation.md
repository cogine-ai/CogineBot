# Repository automation

The active [Repository CI workflow](../.github/workflows/repository-ci.yml) checks the source checkout. It runs on pushes to `main`, pull requests, and manual dispatch. It has no scheduled trigger or release-tag trigger. Newer runs cancel older checks for the same branch or pull request.

The workflow uses GitHub-hosted Ubuntu runners, Node.js 24.16.0, and pnpm 9.15.0. Action revisions are pinned to full commit hashes. Checkout does not persist Git credentials, the repository token has only `contents: read`, and no repository or environment secrets are passed to commands. It cannot deploy the application, publish packages or releases, push branches, or post issue and pull-request comments. It stores dependency caches and can upload failed-check diagnostic artifacts to this repository, retained for seven days. Those are its intended CI outputs.

## Checks and boundaries

| Check | What it executes |
| --- | --- |
| Repository documentation and workflows | `node scripts/check-repository.mjs` and `bash scripts/lint-workflows.sh`, without a workspace dependency installation. The workflow linter downloads a version-pinned, checksum-verified tool from its official release. |
| Lint and typecheck | `pnpm lint` and `pnpm check`. |
| Web production build | `pnpm --filter @rakazo/web build`; no desktop or mobile package is built. |
| Default offline unit tests | The complete default `pnpm run test` suite with two workers and a JSON result file. Live provider, computer, and database opt-ins are empty. No tests are excluded to hide known failures. |
| Official PostgreSQL integration | `pnpm test:integration -- --sandbox=fake --runtime=scripted`, using the existing 29-suite harness. Testcontainers starts a disposable PostgreSQL 16 container and creates a separate database from the migrated template for each suite. Model-dependent fixtures use scripted responses or a loopback model emulator. |
| Selected fake web E2E | The official `pnpm test:e2e` harness with `--sandbox=fake --runtime=scripted` and the `artifact-preview`, `markdown-table`, `peer-messages`, and `spaces` specs. It starts a disposable PostgreSQL container, local API, and headless Chromium. |

Each dependency-based lane performs `pnpm install --frozen-lockfile --ignore-scripts` and then explicit Prisma generation. The integration and browser harnesses also generate and migrate their disposable databases. No dependency lifecycle scripts, Electron installer, desktop application, mobile emulator, or sandbox computer image is run by these lanes.

These are offline product checks: they do not call paid models, provision remote computers, or use real customer data. They are not network-isolated. GitHub Actions, Node.js, pnpm, package registry downloads, the PostgreSQL test image, the workflow-linter release, and the Chromium test binary require network access. Unit tests can start local fixture processes, and model emulators can serve loopback HTTP requests. That is different from validating a real model or computer workflow.

The clean checkout must not contain `.env` files or production credentials. `NODE_ENV=test` prevents the harness's root environment loader from loading a developer environment; Prisma and Vite have their own environment-file behavior, so do not add `.env` files to CI. `VERIFY_PROVIDERS`, `VERIFY_DATABASE`, `VERIFY_LOGGING`, `RUN_COMPUTER_E2E`, and `RUN_COMPUTER_REPLAY_DOCKER` are empty in the workflow. The PostgreSQL harness enables `VERIFY_DATABASE=1` only inside its isolated run. Runtime and sandbox selection are fixed, with no input allowing a manual run to switch to a real provider.

The four browser specs cover selected registration, Space, peer messaging, artifact preview, and CSV download behavior. Passing them would not establish that the complete Coordinator → Researcher → Reviewer workflow succeeds with a real model, that changing requirements mid-run works, or that a release is ready.

## Results and failures

The [preparation baseline](preparation-baseline.md) records the preceding local checks. Its default unit run had 7,456 passes, two failures, and 231 skips. The two launcher failures reproduced on the original macOS environment; Linux results are a separate check. This workflow keeps the complete default suite blocking, without `continue-on-error` or selective exclusions.

The new workflow has not been declared passing merely because its configuration was added. Use the run for the exact current commit as evidence. A successful check establishes only the scope of that lane; skipped tests and unexecuted lanes remain unverified. The official full PostgreSQL lane was not run during the native PostgreSQL preparation checks, so its first GitHub run is new evidence.

Each dependency-based lane has a timeout and saves command logs. On failure, artifacts include those logs, the unit result file when produced, available harness summaries, and browser reports or screenshots. The workflow deliberately excludes the harness data directories and environment files. A harness that fails before its success summary is written may have no summary file; use the command log and browser diagnostics. Canceled runs may finish without artifacts.

## Archived upstream automation

All 11 inherited workflows are preserved verbatim in [.github/upstream-workflows](../.github/upstream-workflows/). This is a reference directory, outside GitHub's active `.github/workflows` location. Those files cannot be dispatched or triggered from that directory. Their original reusable-workflow paths are also retained as historical text, not rewritten into runnable company automation.

The archive includes image publishing, desktop release/signing, mobile OTA updates, scheduled dependency updates, production SSH deployment, screenshot/report publication, and optional real sandbox tests. Several can write through the built-in GitHub token without custom secrets. Other paths require external credentials, and desktop/Expo/install defaults still identify Rakazo resources. Archiving does not configure a CogineBot release channel.

Repository administrators must disable the previously registered upstream workflow IDs before enabling the new workflow, while the repository-wide Actions switch is still off. After enabling, confirm that only Repository CI runs for the intended commit. Old remote workflow registrations and the repository-wide switch are GitHub settings; moving files does not prove those settings changed.

If the organization allows Actions only for selected repositories, add this repository to that existing allowlist before enabling its switch. Keep the organization policy and other repository selections unchanged. Events received while Actions was disabled are not replayed; a new pull-request update can start the first CI run after enabling.

Future release, deployment, scheduled update, real-provider, or report-publication automation needs a separate authorized change with reviewed destinations, credentials, permissions, budgets, and company-specific channels. Do not restore the archived files to the active directory or reuse upstream production configuration as part of routine CI maintenance.
