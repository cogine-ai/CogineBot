# Developing CogineBot from source

[Project overview](../README.md) · [简体中文入口](../README.zh-CN.md) · [Contributing](../CONTRIBUTING.md) · [Recorded baseline](preparation-baseline.md) · [Automation](automation.md)

This guide separates a fast repository check, source validation, and running the application. Follow the first two without a model key. Runtime examples use an isolated local database and synthetic data.

## 1. Check the repository

Use Node.js 24. The supported range is `^22.22.2 || ^24.0.0 || >=26.0.0` in `package.json`; pnpm is pinned to 9.15.0.

```sh
git clone https://github.com/cogine-ai/CogineBot.git
cd CogineBot
node scripts/check-repository.mjs
```

This check needs only Node: it inspects repository metadata and documentation, not application behavior. It does not install packages or start services. Its result and the current PR checks are separate from the historical [preparation baseline](preparation-baseline.md).

## 2. Validate source without paid inference

Start in a clean checkout with no `.env` file and no `VERIFY_*` opt-ins or provider credentials in the shell. Dependency installation needs registry access. Prisma generation may need its engine download on a fresh machine; it does not connect to a database.

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm db:generate
corepack pnpm check
corepack pnpm lint
NODE_ENV=test corepack pnpm run test --maxWorkers=2
```

`--ignore-scripts` disables automatic dependency lifecycle scripts. Generate clients explicitly rather than enabling every install script. If a particular tool needs an additional build step, identify that dependency and review the step first. Keep the lockfile unchanged for a baseline reproduction.

The shell examples use POSIX syntax. In PowerShell, set `$env:NODE_ENV = "test"` before `corepack pnpm run test --maxWorkers=2`.

The default Vitest setup pins scripted/fake providers unless verification is explicitly enabled. Ordinary test processes do not load the checkout's `.env`; opt-in verification CLIs have different configuration behavior. Do not enable live-provider flags to make an offline test pass.

Some offline desktop-helper tests execute `python3` and shell fixtures. The recorded macOS environment has two launcher failures: an empty argument record and a missing process record. A 0.2-second launch probe does not guarantee that a child's first record is already written. A different PATH/Python rerun passed, while the original host-PATH rerun reproduced both failures. See [known test failures](preparation-baseline.md#known-test-failures); record Python/shell versions and do not claim a platform fix from one green run.

## 3. Run the local UI and API

Application startup adds requirements: an isolated PostgreSQL database, migrations, local runtime configuration, and development secrets. This is separate from the Node-only repository check. The commands below are a source setup guide, not a new runtime acceptance result for the quality-pass PR.

Copy the existing configuration template:

```sh
cp .env.example .env
```

Use a fresh local PostgreSQL database dedicated to development. Edit `DATABASE_URL` and, if set, `REALTIME_DATABASE_URL` to point to it. Set unique local values for `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET`; a Docker supervisor additionally needs its own `SANDBOX_SUPERVISOR_TOKEN`. Random hex values can be generated with `openssl rand -hex 32`; generate a separate value for each secret. Keep `.env` untracked.

For UI/API exploration with fixtures, use these existing settings in `.env`:

```dotenv
NODE_ENV=development
AGENT_RUNTIME=scripted
SANDBOX_PROVIDER=fake
WAKEUP_DRIVER=memory
CLOUD_AGENT_PROVIDER=none
API_HOST=127.0.0.1
PUBLIC_POSTHOG_KEY=
```

Leave model, hosted-computer, messaging, connector, billing, and logging-service credentials empty. This configuration uses scripted responses and a fake computer; it is not a real-model demo. The API owns the in-memory job queue, so this mode does not require a separate worker or supervisor.

With the local database running:

```sh
corepack pnpm db:generate
corepack pnpm db:migrate
```

Start the API and web app in separate terminals from the repository root:

```sh
corepack pnpm --filter @rakazo/api dev
```

```sh
corepack pnpm --filter @rakazo/web dev --host 127.0.0.1
```

Open <http://127.0.0.1:5173>. The API defaults to port 3100. Register a development account and inspect the UI; use the verification harness below for repeatable scripted task scenarios. Existing package names and UI branding remain inherited from Rakazo.

For a full source runtime, `corepack pnpm dev` starts API, worker, web, and supervisor. Configure its database, queue, computer provider, and secrets first; the root command is not the minimal fake-provider UI setup above. The retained [source checkout instructions](../README.upstream.md#local-development-source-checkout) and [computer runtime guide](computer-runtime.md) explain that inherited stack. Their published image names, installers, and update channels belong to upstream Rakazo, not a CogineBot release.

### Model connections

When moving to real-model validation, use the application's shared model connection settings. Compatible endpoints use the same saved connection mechanism for endpoint, model, capabilities, and credentials. Do not add a new provider-specific environment variable to bypass it.

Real agent execution uses `AGENT_RUNTIME=pi`. Choose the test model, allowed tools, synthetic task, computer mode, and spending limit before enabling it. A model connection or one successful response does not establish task quality; record the task's acceptance criteria, results, errors, and actual costs separately.

## Choose a verification layer

| Goal | Command | Additional requirements |
| --- | --- | --- |
| Repository structure and docs | `node scripts/check-repository.mjs` | Node only; no behavior acceptance |
| Offline units and contracts | `NODE_ENV=test corepack pnpm run test --maxWorkers=2` | Locked dependencies, generated clients; some helpers need Python/shell |
| Pi protocol against model fixtures | `corepack pnpm test:pi` | Loopback fixture model; no paid inference |
| PostgreSQL product behavior | `corepack pnpm test:integration` | Docker/Testcontainers |
| Browser behavior | `corepack pnpm test:e2e` | Docker and Playwright Chromium; fake providers by default |
| Local computer replay | `corepack pnpm test:computer-replay` | Docker and a reviewed local computer image; no model key by default |
| List model-quality scenarios | `corepack pnpm test:evals --list` | Lists cases without live inference |

Follow [agent verification](agent-verification.md) for the exact scope of each harness. The preparation baseline's selected native-PostgreSQL and browser runs do not establish that the complete Docker/Testcontainers lane passed. Skipped database, Linux-only, or provider checks remain unverified.

Live canaries, real-model evals, and hosted-computer tests can incur costs and affect external systems. They require an explicit opt-in and a defined scope and budget; they are not a prerequisite for the quick check or the read-only [repository CI](automation.md).

The Electron desktop E2E suite opens real windows and may steal focus on macOS. Leave that acceptance to an appropriate virtual-display/CI environment rather than routine checks on a maintainer's desktop.

## Before a pull request

- Run the checks relevant to your changes and report their scope, including failures and skips.
- Validate English/Chinese README parity, local links, and any documented commands you changed.
- Record environment classes and versions using public-safe placeholders; do not attach personal paths, credentials, raw private logs, or customer data.
- Review the current PR's [repository CI](https://github.com/cogine-ai/CogineBot/actions/workflows/repository-ci.yml) results. Upstream release workflows are archived; this CI does not publish releases, images, or updates.

See [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md) for contribution and private-reporting paths.

Added on 2026-10-09 for CogineBot source development. Commands were mapped to the inherited package scripts and startup code; current-PR execution results are reported by its checks rather than inferred from the preparation baseline.
