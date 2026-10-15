# Repository automation

The active [Repository CI workflow](../.github/workflows/repository-ci.yml) checks the source checkout and contains a separate, credentialed mobile OTA publishing job. It runs on pushes to `main`, pull requests, and manual dispatch. It has no scheduled trigger or release-tag trigger. Newer runs cancel older checks for the same branch or pull request.

The source-check jobs use GitHub-hosted Ubuntu runners, Node.js 24.16.0, and pnpm 9.15.0. Action revisions are pinned to full commit hashes. Checkout does not persist Git credentials, the repository token has only `contents: read`, and no repository or environment secrets are passed to the source checks. Those jobs cannot deploy the application, publish packages or releases, push branches, or post issue and pull-request comments. They store dependency caches and can upload synthetic UI screenshots and failed-check diagnostics, retained for seven days. The mobile publishing job described below is separate from these offline checks.

## Checks and boundaries

| Check | What it executes |
| --- | --- |
| Repository documentation and workflows | `node scripts/check-repository.mjs` and `bash scripts/lint-workflows.sh`, without a workspace dependency installation. The workflow linter downloads a version-pinned, checksum-verified tool from its official release. |
| Lint and typecheck | `pnpm lint` and `pnpm check`. |
| Web production build | `pnpm --filter @rakazo/web build`; no desktop or mobile package is built. |
| Default offline unit tests | The complete default `pnpm run test` suite with two workers and a JSON result file. Live provider, computer, and database opt-ins are empty. No tests are excluded to hide known failures. |
| Official PostgreSQL integration | `pnpm test:integration -- --sandbox=fake --runtime=scripted`, using the isolated 33-suite harness. Testcontainers starts a disposable PostgreSQL 16 container and creates a separate database from the migrated template for each suite. Model-dependent fixtures use scripted responses or a loopback model emulator. |
| Selected fake web E2E | The official `pnpm test:e2e` harness with `--sandbox=fake --runtime=scripted` and the spec selection recorded in the active workflow. It starts a disposable PostgreSQL container, local API, and headless Chromium. The optional ticket board stays disabled unless explicitly enabled for its dedicated checks. |

Each dependency-based lane performs `pnpm install --frozen-lockfile --ignore-scripts` and then explicit Prisma generation. The integration and browser harnesses also generate and migrate their disposable databases. No dependency lifecycle scripts, Electron installer, desktop application, mobile emulator, or sandbox computer image is run by these lanes.

These are offline product checks: they do not call paid models, provision remote computers, or use real customer data. They are not network-isolated. GitHub Actions, Node.js, pnpm, package registry downloads, the PostgreSQL test image, the workflow-linter release, and the Chromium test binary require network access. Unit tests can start local fixture processes, and model emulators can serve loopback HTTP requests. That is different from validating a real model or computer workflow.

The clean checkout must not contain `.env` files or production credentials. `NODE_ENV=test` prevents the harness's root environment loader from loading a developer environment; Prisma and Vite have their own environment-file behavior, so do not add `.env` files to CI. `VERIFY_PROVIDERS`, `VERIFY_DATABASE`, `VERIFY_LOGGING`, `RUN_COMPUTER_E2E`, and `RUN_COMPUTER_REPLAY_DOCKER` are empty in the workflow. The PostgreSQL harness enables `VERIFY_DATABASE=1` only inside its isolated run. Runtime and sandbox selection are fixed, with no input allowing a manual run to switch to a real provider.

The selected browser specs cover desktop layout, conversation and draft behavior, mentions, groups, approvals, avatars, peer messages, and file preview/download behavior. Passing them does not establish real-model task quality, correctness across changing requirements, or release readiness.

## Results and failures

The [preparation baseline](preparation-baseline.md) records the preceding local checks. Its default unit run had 7,456 passes, two failures, and 231 skips. The two launcher failures reproduced on the original macOS environment; Linux results are a separate check. This workflow keeps the complete default suite blocking, without `continue-on-error` or selective exclusions.

The new workflow has not been declared passing merely because its configuration was added. Use the run for the exact current commit as evidence. A successful check establishes only the scope of that lane; skipped tests and unexecuted lanes remain unverified. The official full PostgreSQL lane was not run during the native PostgreSQL preparation checks, so its first GitHub run is new evidence.

Each dependency-based lane has a timeout and saves command logs. On failure, artifacts include those logs, the unit result file when produced, available harness summaries, and browser reports or screenshots. The workflow deliberately excludes the harness data directories and environment files. A harness that fails before its success summary is written may have no summary file; use the command log and browser diagnostics. Canceled runs may finish without artifacts.

## Release automation

Three inherited release workflows have been adapted to CogineBot and moved into
GitHub's active directory. Their platform formats and channels retain the upstream
mechanisms; adding configuration does not mean a release has been built or published.

| Workflow | Trigger and destination | Required boundary |
| --- | --- | --- |
| [Container images](../.github/workflows/publish-server-image.yml) | `main` pushes, `v*` tags, or manual dispatch publish app, computer, and updater images to `ghcr.io/cogine-ai/coginebot/…`; matching pull requests only validate builds. | Read-only pull-request jobs; GHCR writes only in publishing jobs, with source attestations. |
| [Desktop releases](../.github/workflows/release-desktop.yml) | Stable `vMAJOR.MINOR.PATCH` tags on `main`; manual dispatch must also select such a tag. Downloads and updater feeds go to this repository's GitHub Releases. | Matching desktop version, signed macOS build and notarization, and signed Windows build; all three desktop platforms must succeed. See [desktop release configuration](desktop-release.md). |
| [Android APK](../.github/workflows/release-android-apk.yml) | Manual dispatch from `main`, publishing `coginebot.apk` to the rolling `android` GitHub Release without replacing desktop `latest`. | A self-owned Expo project, public `EXPO_OWNER` / `EAS_PROJECT_ID` variables, and `EXPO_TOKEN`; signing stays with that project's managed keystore. |

The separate [macOS validation workflow](../.github/workflows/validate-desktop-macos.yml)
packages, signs, notarizes, and verifies installers with read-only repository
permissions. It runs on pushes to the integration branch `work/release-ownership`
and supports manual dispatch after reaching the default branch. Its only hosted
outputs are short-lived Actions artifacts containing installers, update metadata,
and checksums. It does not call any of the publishing paths above.

Repository CI also reuses the upstream `publish-mobile-update` job after every
source-check matrix lane succeeds on a `main` push. It inspects the full push
range: compatible mobile JavaScript, TypeScript, and bundled CSS can publish a
production EAS Update; native configuration, assets, dependencies, modules, or
workflow changes block OTA. An unresolved push base is skipped rather than
checking an incomplete range. Immediately before publication, the job checks
that its commit is still the current `main`, preventing an older update from
overwriting a newer one.

Only an eligible OTA publication receives `EXPO_TOKEN`. It uses this project's
`EXPO_OWNER`, `EAS_PROJECT_ID`, and HTTPS `EXPO_PUBLIC_API_URL` repository
variables. `EAS_BUILD_PROFILE=production` applies the same ownership and HTTPS API checks as release builds. Missing release
configuration fails explicitly; it does not use Rakazo's Expo account, disable
OTA, or change the offline source-check jobs. See [mobile releases](mobile-release.md).

The workflows are prepared publishing paths, not proof that GHCR packages,
signed desktop downloads, store listings, or Expo channels are available. Check
the exact workflow result and its published destinations before directing users
to install a release. Signing and store credentials must belong to this project
and must not be committed.

## Archived upstream automation

The remaining inherited workflows stay in
[.github/upstream-workflows](../.github/upstream-workflows/). This reference
directory is outside GitHub's active `.github/workflows` location; files there
cannot be dispatched or triggered from that directory. The archived upstream CI
retains its historical OTA and SSH-deployment text, but only its reviewed OTA job
has been carried into Repository CI. Its production deployment job is not active.

Scheduled dependency updates, production SSH deployment, screenshot/report
publication, and optional real-provider or sandbox tests remain archived. They
must not be re-enabled as part of routine CI maintenance. Any later activation
requires a separate reviewed change covering destinations, credentials,
permissions, and expected resource use. Moving workflow files alone does not
prove that repository or organization Actions settings permit their execution.
