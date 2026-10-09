# CogineBot

An open-source project based on [Rakazo](https://github.com/elie222/rakazo), starting from commit [`794a76da6eb0a73532a89cf57d2f202ef9b6b6c8`](https://github.com/elie222/rakazo/commit/794a76da6eb0a73532a89cf57d2f202ef9b6b6c8).

CogineBot is in the preparation stage. The first planned workflow is coordinated research, review, and a downloadable CSV, with requirements that can change during execution. That complete workflow has not yet been validated with a real model in this repository.

The fixed upstream history is preserved. This initialization changes documentation and adds attribution; application behavior, package names, and runtime configuration remain those of the upstream baseline.

## Development

```sh
git clone https://github.com/cogine-ai/CogineBot.git
cd CogineBot
corepack pnpm install --frozen-lockfile --ignore-scripts
```

The baseline uses pnpm 9.15.0 and a supported Node.js version specified in `package.json`. Runtime development also requires PostgreSQL, generated Prisma clients, and explicit local configuration. See the retained [upstream development instructions](README.upstream.md#local-development-source-checkout) and [self-hosting documentation](docs/self-host.md).

The upstream documentation includes Rakazo-hosted links, installers, images, and update channels. Those references continue to identify upstream resources. CogineBot release images, installers, and a hosted service have not been established.

## Baseline and contribution scope

[Preparation baseline](docs/preparation-baseline.md) records the checks performed, known failures, dependency advisory triage, and the remaining validation work. Browser checks used a scripted runtime and fake computer. Public hosting, real computer recovery, and the full three-role workflow remain unvalidated.

GitHub Actions were disabled when this repository was initialized and remain disabled. The retained upstream workflows include image publishing and mobile updates; adapt those workflows before enabling Actions here. No release tags are imported.

## License and provenance

The upstream [Apache-2.0 license](LICENSE) and existing notices are retained. [Third-party notices](THIRD_PARTY_NOTICES.md) preserve additional attribution and license text for identified copied components. See [UPSTREAM.md](UPSTREAM.md) for the source and synchronization policy.

Modified on 2026-10-09 for CogineBot repository initialization. The original README is preserved verbatim as [README.upstream.md](README.upstream.md).
