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

## Integration boundary

The existing routine detail route can host a separately saved trigger editor.
Issue #141's ordinary routine update deliberately omits external triggers; trigger
updates must likewise omit name, prompt, schedules, timezone, model and active state.
No unpublished #141 implementation is required for these independent components.
The combined #141 editor entry must be verified after that change is available.

## Evidence limits

Automated offline tests are substitute evidence. Real iOS/Android input and result
screenshots, authorized upstream delivery, and App/Web readback on the same instance
remain unproven until independently exercised. Native-only UI cannot be evidenced
by an unrelated web CI screenshot.
