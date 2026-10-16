# Contributing to CogineBot

Help make the source easier to run, the behavior easier to verify, and the results easier to trust. Start with [README.md](README.md), the [development guide](docs/development.md), and [AGENTS.md](AGENTS.md).

## Choose a focused change

Useful contributions include reproducible bug reports, documentation corrections, offline test coverage, accessible UI improvements, and provider-neutral fixes. Keep a PR to one problem. Discuss task orchestration changes, new providers, dependencies, public-hosting behavior, and release automation in an issue before committing to a large implementation.

Distinguish inherited Rakazo source capabilities from changes actually made in CogineBot. Describe implemented behavior and its validation evidence; do not present unconfirmed product ideas as a roadmap or supported behavior. Preserve `README.upstream.md` as the original reference; record upstream changes through [UPSTREAM.md](UPSTREAM.md).

## Verify at the right level

| Check | Requirements and purpose |
| --- | --- |
| `node scripts/check-repository.mjs` | Node only. Fast static check of repository documentation/automation; no dependencies, database, model, or app secrets. |
| `corepack pnpm db:generate` | Installed locked dependencies. Generate Prisma clients; no running database required. |
| `corepack pnpm check` | Type checking across the monorepo. |
| `corepack pnpm lint` | Biome lint and formatting checks. |
| `NODE_ENV=test corepack pnpm run test --maxWorkers=2` | Broader offline unit suite. Scripted runtime/fake providers by default; use a clean shell without `VERIFY_*` opt-ins or live credentials. |
| `corepack pnpm test:integration` | Docker/Testcontainers and PostgreSQL product checks. Longer than units; no paid inference by default. |
| `corepack pnpm test:e2e` | Docker and Playwright web checks with emulated providers by default. |
| `corepack pnpm test:pi` | Pi protocol checks against local model fixtures; no model key. |

Install with `corepack pnpm install --frozen-lockfile --ignore-scripts`. See [development.md](docs/development.md) for setup and the larger test matrix. A static repository check is not a substitute for behavior tests.

The initial [2026-10-09 preparation baseline](docs/preparation-baseline.md) recorded **two launcher failures** and skipped suites; it does not describe the current commit's results. Report the command, commit, environment class, pass/fail/skip totals, and whether the failure matches [preparation-baseline.md](docs/preparation-baseline.md). A different PATH passing locally does not prove those failures were fixed. Preserve failed results; do not disable assertions or relabel skipped checks as passing.

Use targeted tests for behavior changes and run the relevant broader checks. Documentation-only changes should verify commands, links, and rendering. Report tests you did not run and why. Consult [automation.md](docs/automation.md) for the active workflows. Repository source-check lanes use read-only permissions and no product credentials; the separate trusted-`main` mobile OTA job and release workflows can publish with their explicitly configured credentials. Preserved upstream CI descriptions do not define this repository's active checks.

Live model, hosted computer, and connector checks require an explicit opt-in and a bounded budget. Release and OTA operations follow their reviewed publishing scope and credentials; they are not ordinary source validation. Keep default tests deterministic and offline. Do not run the Electron desktop E2E suite as routine verification on a maintainer's machine; it opens real windows and can steal focus.

## Keep public contributions safe

README screenshots are generated from the full web UI with synthetic data and mocked services. After installing dependencies and Playwright Chromium, run `node scripts/readme-screenshots.mjs`; its [source](scripts/readme-screenshots.mjs) documents the setup. It does not use a running deployment or real accounts. Keep private reference images and acceptance reports out of these public assets.

- Use synthetic data and placeholders. Never commit `.env`, credential files, tokens, production data, customer details, private URLs, or generated evidence containing them.
- Sanitize issue and PR output: remove authentication headers, secret values, personal paths, account identifiers, and private screenshots. Retain only the evidence needed to reproduce the issue.
- Store model and connector credentials through existing secret/connection mechanisms. Add compatible models through shared connection settings; avoid provider-specific configuration in core logic.
- Preserve original copyright, license, and attribution notices. Mark modified files as required by their license and update [third-party notices](THIRD_PARTY_NOTICES.md) for newly copied material or assets.
- Review `git status` and the staged diff before publishing. Never force-add ignored files to attach an unreviewed report.

For vulnerabilities, read [SECURITY.md](SECURITY.md) and use [private vulnerability reporting](https://github.com/cogine-ai/CogineBot/security/advisories/new). Keep exploit details and secrets out of public issues.

## Open a pull request

Target `main` and use the repository PR template. Explain the concrete problem, the resulting behavior, and how you verified it. Link related issues and call out changes to data handling, permissions, compatibility, or dependencies when relevant.

If your checkout also has a Rakazo upstream remote, run `gh repo set-default cogine-ai/CogineBot` before opening or watching a PR with GitHub CLI. Confirm the target repository so feedback and changes go to CogineBot.

For UI changes, include a shareable screenshot or CI screenshot link. Quote new user-facing copy and explain why it is needed. Keep English and Chinese README content aligned when changing the project's scope, setup, or status.

Check the PR's current-head results rather than relying on the historical baseline or an earlier successful run. Wait for required checks and maintainer review, address actionable feedback, and update the description when the scope changes. Publishing images and desktop/Android releases uses separate workflows; mobile OTA uses the separate publishing job in Repository CI. These publishing paths are not authorized merely by passing read-only source checks. Follow the [desktop release guide](docs/desktop-release.md) for its release sequence.

Modified on 2026-10-16 to separate current source checks and publishing paths from the initial preparation baseline; inherited attribution and repository instructions are retained.
