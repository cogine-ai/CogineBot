# Weekday brief · 替身验收

The real web private chat received messages from the normal routine scheduler and worker. The test clock moved the weekday routine to its next due instant. Gmail and Google Calendar used native account-bound connectors with synthetic OAuth, mail and event responses. The local model classified pending replies. All names, accounts and source items are fictional.

| Scenario | Observed in the private chat | Browser evidence |
| --- | --- | --- |
| 替身 · 首次设置 | The preview showed the two selected sources, a fictional example and 08:30 Asia/Shanghai. There were zero routines until confirmation and one active Monday–Friday routine afterward. | [Preview](preview.png) · [Confirmed](confirm.png) |
| 替身 · 正常一天 | One reply due and two conflicting meetings, with a 10:30–11:00 overlap. The browser opened the original for each. | [Brief](normal.png) · [Mail original](original-thread-jade-83.png) · [First meeting](original-ev-map-71.png) · [Second meeting](original-ev-harbor-24.png) |
| 替身 · 邮箱断连 | The mailbox read returned an access error. “邮箱没查到。” appeared alongside the calendar conflict and its two links. | [Partial brief](offline.png) |
| 替身 · 今天没事 | Both successful reads returned empty lists. The bot delivered “今天没有待回邮件或会议冲突。” | [Empty day](empty.png) |

The browser opened the account-specific Gmail thread URL through a test interception serving the matching synthetic original. Both event URLs served their respective synthetic originals. Live account authorization and upstream delivery remain part of pre-release acceptance.
