# Mobile routine trigger parity

Integration baseline: `feature/mobile-parity` at `7bbc3e1e79bc03ed3bfcf29795542722a3e8a97c` (includes #141/#142; excludes #143).

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

## Save concurrency and recovery

Native-event replacements include the complete original ID/version set. The
backend compares that set under the Routine lock, inside the same serializable
transaction as the ordinary fields and deletions. Unknown additions, changed
omitted rows, or concurrent removals conflict and roll everything back. Legacy
requests without a baseline cannot delete omitted rows; sparse non-event writes
are unaffected. The Web editor supplies the same precondition.

Both editors retain a stable mutation ID for a save intent. The backend binds its
receipt to the authenticated user, Space, operation, target and canonical request.
Receipt and data commit atomically. Replaying an acknowledged or ambiguous save
reads the current owned result without creating another Routine or changing a
new trigger's identity, armed time, cursor or lease. Reusing the intent with changed
input conflicts instead of silently applying another mutation. Deleted results
are not recreated. Receipts contain hashes and result IDs, not submitted prompts
or credentials. The additive migration installs user/Space RLS atomically when
upgrading a protected deployment, including deployments with default table grants.

Selecting the current account, event, Calendar target or Notion target is a no-op.
Actual changes still clear dependent fields and retain trigger ID/version.

## Verification record

The acceptance failures were reproduced before product changes: four real
API/PostgreSQL failures and five component failures. Permanent regressions cover
those cases, simultaneous writes, a resource-verification pause across another
commit, receipt rollback, cross-user/Space replay and deleted-result replay.
The changed-value matrix uses 38 explicit branches, distinct valid values, exact
payloads and every reopened field (including multiline filters). Schema/picker
set equality and absence of duplicates are independently asserted.

The focused repair suite passed 575 tests across 13 files, including authenticated
API/PG transactions and protected-upgrade rollback tests. The final UI run passed 162 tests in three files. The complete RLS catalog passed
28 tests on a fresh synthetic database with password authentication; mixed-authority
restricted-pool tests also passed. The final API run passed 174 tests, including
exact 401/404 permission assertions and the ten save-transaction regressions.
The final shared intent/UI run passed 227 tests, including native/non-secure Web
ID generation without new platform dependencies. Mobile SDK validation and
mobile/core/db/web/adapters/API type checks passed. All runs use reduced
priority and one worker; only synthetic local databases and fake/scripted providers
are involved. Real upstream authorization and native-platform evidence remain
unproven.

For CI job 132272158973, the failing measurement is Send after Enter, after Attach
file passed. The locator resolved a visible Send node before its box became null;
the later error snapshot again contains Send and a completed reply. The composer,
its test and styles are identical between the original PR head and its base.
A running-state node replacement is a candidate cause, not a proven diagnosis.
Independent source exports of base and original head each passed three local runs
with Node 22 and cached Chromium 1217. These differ from CI's Linux/Node 24/browser
environment and do not clear the CI failure. No chat logic or test was changed.
