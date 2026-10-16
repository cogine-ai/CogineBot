# CogineBot

**English** · [简体中文](README.zh-CN.md)

[Download](https://github.com/cogine-ai/CogineBot/releases/latest) · [Self-host](docs/self-host.md#published-images-no-checkout) · [Development](docs/development.md) · [Contributing](CONTRIBUTING.md)

CogineBot is a self-hosted application for persistent AI Bots, forked from [Rakazo](https://github.com/elie222/rakazo). It supports ongoing conversations, group chats, Bot-to-Bot messaging, files, and a computer workspace. You can choose your models and use the web or desktop client.

## Why this fork

We were among Rakazo's first users, and we're grateful to its author for making the project open source.

Personal agents are still at an early stage, and there are many ideas about what they should be and how they should work. We have our own ideas about design and product direction, and we'd like to explore them through this fork.

CogineBot is maintained independently by [cogine-ai](https://github.com/cogine-ai). So far, we have reworked the chat timeline, sidebar, group interactions, avatars, files, and computer takeover flow. The [adaptation notes](docs/upstream-adaptations.md) describe these changes. We follow upstream and bring over changes that fit.

![CogineBot chat interface](docs/images/conversation.png)

## Features

- Persistent Bots with conversation history, memory, and routines.
- Group chats with multiple Bots, @ mentions, and Bot-to-Bot messages.
- File attachments, previews, version history, and downloads.
- Browser, terminal, and file access through a Bot's computer. Watch first, select **Take control** to interact, and **I'm done** to return control.
- Configurable models, application connections, and computer providers.

Optional services need to be configured on your instance. See the [self-hosting guide](docs/self-host.md).

<details>
<summary>More screenshots</summary>

### Compact sidebar

![CogineBot with the sidebar collapsed](docs/images/conversation-compact.png)

### Group chat

![Group chat with multiple Bots and mentions](docs/images/group-chat.png)

### Files

![File list and document preview](docs/images/files.png)

### Computer

![Bot computer in viewing mode](docs/images/computer.png)

</details>

## Installation

### Desktop

Download installers and checksums from [GitHub Releases](https://github.com/cogine-ai/CogineBot/releases/latest).

| Platform | Package | Signing |
| --- | --- | --- |
| macOS, Apple silicon and Intel | Universal `.dmg` / `.zip` | Signed and notarized |
| Windows x64 | `.exe` installer | Currently unsigned; Windows may show an unknown-publisher warning |
| Linux x64 | `.AppImage` | Checksums and build provenance included |

Choose **This computer** to run a local instance with Docker Engine 26+ and Compose, or **Existing instance** to connect to a server you already run. See [desktop release details](docs/desktop-release.md).

The repository also includes the Expo mobile client. CogineBot does not yet have its own public mobile release or hosted service.

### Self-hosting

Follow the [Docker Compose installation guide](docs/self-host.md#published-images-no-checkout). It covers configuration, optional providers, backups, and updates. The web and desktop clients connect to the same instance.

### Source development

Use Node.js 24 and pnpm 9.15.0. The supported Node range is in [package.json](package.json).

```sh
git clone https://github.com/cogine-ai/CogineBot.git
cd CogineBot
node scripts/check-repository.mjs
```

This checks repository documentation and workflow metadata. For dependencies, tests, and running the application, see [Development](docs/development.md).

Current checks are in [GitHub Actions](https://github.com/cogine-ai/CogineBot/actions/workflows/repository-ci.yml). The [preparation baseline](docs/preparation-baseline.md) records the initial checks; [agent verification](docs/agent-verification.md) describes the test harnesses and what they cover.

## Near-term plans

- **Connectors:** improve application connections and connected-account management.
- **iOS client:** test connections to self-hosted servers and everyday use through TestFlight, then prepare an App Store release.

## Contributing

Issues and pull requests are welcome. For substantial changes, please open an issue first to discuss the scope.

- [Bug reports](https://github.com/cogine-ai/CogineBot/issues/new?template=bug.yml): include the version and steps to reproduce.
- [Feature requests](https://github.com/cogine-ai/CogineBot/issues/new?template=feature-request.yml): describe the use case. Requests for specific application connections are welcome here too.
- [Setup help](https://github.com/cogine-ai/CogineBot/issues/new?template=self-host.yml): desktop, server, or source installation questions.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and review guidelines. Report security vulnerabilities through the [private reporting channel](SECURITY.md).

## Upstream and license

[UPSTREAM.md](UPSTREAM.md) records the source revisions and integration policy. Internal `@rakazo/*` package names and protocol/storage identifiers are retained for compatibility. The original [README.upstream.md](README.upstream.md) is preserved verbatim. See [Automation](docs/automation.md) for this repository's checks and release workflows.

CogineBot preserves Rakazo's history from [`794a76da6eb0a73532a89cf57d2f202ef9b6b6c8`](https://github.com/elie222/rakazo/commit/794a76da6eb0a73532a89cf57d2f202ef9b6b6c8), its [Apache-2.0 license](LICENSE), and existing copyright and attribution notices. Additional terms for identified copied components are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); this is not a complete dependency or asset inventory.

Modified on 2026-10-16 for CogineBot's project introduction, fork rationale, distribution, and contribution information. Original upstream documentation is preserved separately.
