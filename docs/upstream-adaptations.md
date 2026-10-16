# Upstream adaptations

The latest integrated upstream snapshot is Rakazo revision [`932534d7785f0c51b6a0aed54d0096ea8b36eb11`](https://github.com/elie222/rakazo/commit/932534d7785f0c51b6a0aed54d0096ea8b36eb11), compared with the retained common baseline [`794a76da6eb0a73532a89cf57d2f202ef9b6b6c8`](https://github.com/elie222/rakazo/commit/794a76da6eb0a73532a89cf57d2f202ef9b6b6c8). The snapshot has been integrated; retain both histories when reviewing later upstream changes. This document records source and behavior decisions; it is not a test report or release announcement.

## Retained product contracts

| Area | Contract |
| --- | --- |
| Desktop shell | Expanded name and last-message rows, persistent collapsed avatar rail, pinned separator, account and Files footer, existing creation and search entry points. |
| Conversation | Continuous chat, left-aligned Bot and peer source identity, Space-wide mentions, existing default responder and routing rules. |
| Composer | One initial line growing to six visible lines, separate controls row for wrapped text or attachments, scoped draft versions and idempotent send attempts. |
| Groups | Existing creation nonce and signature, stable shared member read order, member-save synchronization and late-response isolation. |
| Attention | Activity motion and notification are independent; yellow is approval only and takes priority over blue unread; no presence state. |
| Avatars | Static Gaze identity with synchronized activity motion; historical and uploaded portraits remain static. See [avatar system](avatar-system.md). |
| Files | Latest items at the bottom, older pages prepended while preserving the current reading anchor, selected-version preview and exact download behavior. |
| Approvals | All actionable approvals remain reachable; MCP settings and cards synchronize atomically; peer approval projection exposes the card without unrelated internal activity. |
| Computer control | Opening watches first; explicit **Take control** acquires control. **I’m done** returns control and stays in watching mode, with Team and Private run associations using the existing continuation behavior. No new pause or task mechanism is added. |

Implementation details can change to absorb equivalent upstream fixes. These contracts, rather than entire files or exact CSS structures, define the adaptations.

## Combined maintenance changes

- Authentication dependencies, cache control, MCP token refresh, computer recovery, tool-call protocol guards and skill source preservation are brought in as complete calling chains.
- Group member creation and replacement retain caller order through ordered writes, using the existing shared read order and creation-idempotence contract. Consequently, the first member of a newly created group follows the caller's selection order.
- Artifact upload retries use the upstream upload nonce contract, derived from the existing composer send attempt and attachment identity. Lost receipts can reuse the accepted artifact without creating a second version.
- Bot export is restricted to that Bot's workspace, excluding hidden root state and escaping symlinks. Binary files retain their bytes through the export manifest's encoding field. This is Bot export, not a whole-computer backup.
- Group deletion requires confirmation, while cancelling and reopening member settings during a pending save retain the existing session isolation.

## Deliberately deferred exposure

- The upstream sidebar density setting, work-status replacement text and uploaded-photo activity ring are not applied to the retained conversation presentation.
- ZIP remains outside the shared accepted attachment types. Public routine creation and update do not expose independent model overrides; underlying model-pin schema and correctness code remain available for a separately reviewed activation.
- Peer unread and reply classification retain the current conversation behavior. The upstream quieter internal-peer notification policy is a separate product decision.
- The optional ticket board retains its upstream contracts, wiring and existing `TICKET_BOARD_ENABLED` switch, defaulting off. Disabled mode must not expose Board routes, tools, context or navigation. Enabling it changes capabilities and requires a separate product decision.

Do not create additional compatibility layers for pre-launch historical records. Verify migrations using fresh and current-baseline synthetic databases instead. Preserve the group nonce migration alongside upstream schema additions.

## Automation boundary

The reviewed container, desktop, and Android APK publishing workflows are active
in `.github/workflows`, with CogineBot destinations and product identities.
Repository CI retains its offline source-check lanes and carries the upstream
compatible-mobile-OTA job after those checks on `main` pushes. The remaining
workflows, including upstream production SSH deployment, stay archived in
`.github/upstream-workflows`. See [automation boundaries](automation.md).

[Desktop version 0.2.1](https://github.com/cogine-ai/CogineBot/releases/tag/v0.2.1)
is published with the project's own installers and update feeds, alongside its
versioned app, computer, and updater images. This does not establish that every
optional path, including mobile store distribution, has been released. Each
future artifact still needs successful checks, the required signing or Expo
credentials, and destination verification before it is advertised. Source integration
does not authorize deploying to production or using a developer's data or
credentials for tests.
