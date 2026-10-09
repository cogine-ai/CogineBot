# CogineBot

**Source code for persistent bots, shared APIs, and multiple clients.**

**English** · [简体中文](README.zh-CN.md)

[Get started](#get-started) · [Development](docs/development.md) · [Contribute](CONTRIBUTING.md) · [Baseline](docs/preparation-baseline.md) · [Automation](docs/automation.md) · [Apache-2.0](LICENSE)

CogineBot is an independently maintained open-source repository based on [Rakazo](https://github.com/elie222/rakazo), maintained by [cogine-ai](https://github.com/cogine-ai). It contains the inherited bot runtime, backend, and web, desktop, and mobile clients.

**Current stage: repository preparation and source validation.** Real-model task quality, real-computer recovery, and public-hosting readiness remain unverified in this repository. No CogineBot hosted service, release image, or installer is available.

## What is here

- Persistent bots, Spaces, conversations, memory, and routines
- Peer-bot delegation and asynchronous result messages
- File tools, artifact previews, and download paths
- Shared API with web, Electron, and Expo clients
- Model connections and optional computer/integration adapters

These capabilities are present in the retained Rakazo source; validation varies by configuration. Existing `@rakazo/*` package names and application UI remain upstream-derived.

The [recorded preparation baseline](docs/preparation-baseline.md) includes type checking, a web build, selected PostgreSQL and browser checks, and the default offline unit suite. That unit run had **7,456 passes, 2 failures, and 231 skips**. The two launcher failures remain documented; scripted/fake-provider checks do not establish real-model task quality or real-computer recovery.

For current changes, inspect the results for the commit under review in [repository CI](https://github.com/cogine-ai/CogineBot/actions/workflows/repository-ci.yml). The quality-pass branch's checks are separate from the recorded preparation baseline.

## Get started

Use Node.js 24 and pnpm 9.15.0; the exact supported Node ranges are in [package.json](package.json).

```sh
git clone https://github.com/cogine-ai/CogineBot.git
cd CogineBot
node scripts/check-repository.mjs
```

This first check inspects repository documentation and automation metadata. It needs no installed dependencies, database, model key, or application secrets.

For source validation, start from a clean checkout with no provider credentials or `VERIFY_*` opt-ins in the shell:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm db:generate
corepack pnpm check
corepack pnpm lint
NODE_ENV=test corepack pnpm run test --maxWorkers=2
```

Dependency installation needs package-registry access; these checks require no paid inference. Prisma client generation does not require a running database. The recorded macOS baseline contains the two launcher failures noted above; report your actual results rather than assuming a green suite.

See the [development guide](docs/development.md) for prerequisites, the local UI/API, verification layers, and troubleshooting. This repository is developed from source; links and image channels in retained upstream guides identify Rakazo resources.

## Find your way around

```text
apps/       web, API, worker, Electron, Expo, and website
packages/   contracts, domain logic, persistence, adapters, UI, test tooling
infra/      local services, computer images, and supervisor
scripts/    development and repository checks
docs/       development, verification, operations, and provenance notes
```

| Need | Read |
| --- | --- |
| Set up and choose the right check | [Development](docs/development.md) |
| Understand what was actually tested | [Preparation baseline](docs/preparation-baseline.md) |
| Distinguish emulated execution from model quality | [Agent verification](docs/agent-verification.md) |
| Understand repository CI and archived workflows | [Automation](docs/automation.md) |
| Trace the upstream starting point and sync policy | [Upstream provenance](UPSTREAM.md) |
| Submit a change or report a vulnerability | [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) |

## License and acknowledgments

CogineBot preserves Rakazo's history from [`794a76da6eb0a73532a89cf57d2f202ef9b6b6c8`](https://github.com/elie222/rakazo/commit/794a76da6eb0a73532a89cf57d2f202ef9b6b6c8), its [Apache-2.0 license](LICENSE), and existing copyright and attribution notices. Identified copied components retain their additional terms in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); that file is not a complete dependency or asset inventory.

This is an independently maintained derivative project. See [UPSTREAM.md](UPSTREAM.md) for the relationship and update policy. The original [README.upstream.md](README.upstream.md) is retained verbatim for reference.

Modified on 2026-10-09 for CogineBot's project introduction and source development guidance; original upstream documentation is preserved separately.
