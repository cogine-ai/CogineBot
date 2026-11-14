# Mobile routine trigger parity

Baseline: main `24f414f6d1192a315714ce46c7ad39bdf24e5b0a`.

| Web capability | Editable fields / behavior |
| --- | --- |
| Webhook | Enabled; bot webhook endpoint, provision/rotate shared secret |
| GitHub | Enabled; bot GitHub endpoint, same shared secret; no repository/event filters in Web |
| Message | Slack only when installed workspace connection or messaging provider is available; Teams remains unavailable; preserve existing providers |
| Calendar changed / starting | Connected native account, calendar ID, calendar/single/series/instance target, event ID; starting lead minutes |
| Notion content | Page ID |
| Notion properties | Page or data source ID, optional property IDs |
| Notion comments | Page, block or discussion target; page ID, block ID or discussion and anchor block IDs |
| Gmail received / thread-label changed | Label IDs and/or thread ID |
| Drive changed / trashed | File ID |
| Slack mention / DM / channel message | Channel ID; optional thread timestamp for channel messages |
| SharePoint item changed | Site and list IDs |
| Excel range changed | Drive, workbook item, worksheet IDs and A1 range |
| Planner task changed | Plan ID |
| Teams channel message | Team and channel IDs (application event, distinct from unavailable generic Teams message trigger) |
| Feishu / WeCom calendar changed | Calendar ID |
| DingTalk calendar changed | User and calendar IDs, ISO start/end times |
| Telegram pinned message changed | Chat ID |
| Discord channel message / command | Channel ID; command additionally server ID, command ID and name |

All application events use connected native accounts and backend authorization.
No provider SDK or upstream credentials belong in the editor.

## Integration

The implementation integrates with #141's routine create/edit form on
`feature/mobile-parity` (merged baseline `7bbc3e1e79bc03ed3bfcf29795542722a3e8a97c`).
External fields expand only on request. All changes save together; cancellation
unmounts the draft, while failed saves and same-owner focus changes preserve it.
Only edited fields are submitted. Untouched application specs and CAS versions
are preserved, and model, timezone and active state are omitted.

The existing `/routine` deep link and `/plugins` settings sheet are reused; returning
from account settings refreshes capabilities without clearing the form. There are
no new routes, provider SDKs or native dependencies. Native switches, choice menus,
confirmation alerts and existing text controls serve both mobile platforms.
Webhook and GitHub endpoints use the selected server. Explicit shared-secret
rotation is a separate confirmed bot action; cancelling routine edits never saves
the routine draft. Provisioning is checked again when enabling an inbound trigger.

## Offline coverage

- Shared serializer and sparse patches cover all 22 open kinds, all Calendar target
  variants, Notion page/data-source/block/discussion variants, optional Gmail/Slack
  filters, array limits, duplicate IDs and untouched spec preservation.
- Mobile component tests exercise fields and readback through a substituted RPC,
  external-only creation, scheduled coexistence, unavailable accounts/providers,
  permission failures, cancellation, account-settings return and stale scopes.
- Backend tests run real observation matching on serialized drafts for each branch,
  including wrong resources, accounts, versions and applicable field filters;
  existing Webhook/GitHub and messaging ingress tests cover match/non-match delivery.
- Static and dynamic labels are checked for Chinese, German and Russian.

## Evidence limits

Automated offline tests are substitute evidence. Real iOS/Android input and result
screenshots, authorized upstream delivery, and App/Web readback on the same instance
remain unproven until independently exercised. Native-only UI cannot be evidenced
by an unrelated web CI screenshot.

## Verification record

The mobile suite passed 2,504 tests across 170 files before the final fixture
packaging and callback guards. The final focused run passed 531 tests across
13 files, including those affected by the final changes. Routine/API router
regressions passed 12 selected tests (152 unrelated tests were not selected).
Mobile SDK validation and mobile/core/web/adapters type checks passed. Changed
files passed Biome and whitespace checks. All commands used Node 22, Corepack
pnpm 9.15, reduced process priority and one test worker.

No task database, role, application listener or simulator was created for this
verification. No hosted provider or production call was made.
