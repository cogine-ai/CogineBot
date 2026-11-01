# Bot collaboration

Space owners can change **Bot collaboration** in that Space's settings. It is
enabled by default. Members can view the setting; organization or deployment
ownership does not grant permission to change a Space that they do not own.

Turning it off prevents new Bot-to-Bot messages, handoffs and assigned work,
including messages through approved agent connections. A connected delivery
requires collaboration to be enabled in both Spaces. A Bot's existing tool
restrictions still apply to its tool calls. The runtime can return an authorized
delegated result even when the worker cannot invoke `message_bot`; Space policy
still controls that automatic return.

Queued work that has not started is cancelled, and waiting collaboration cards
show **Automatic collaboration stopped**. Work already running may finish its
local stage, but cannot dispatch more collaborative work or automatically send
a result back. People can still mention Bots, send ordinary follow-ups and use
helpers within the same Run.

Turning collaboration back on permits new requests. It does not replay cancelled
deliveries or suppressed automatic returns. Settings changes use a revision check
and record the operator, time and previous/new values. If another owner changes
the setting first, refresh before confirming another change.

Upgrade the API and workers together before using this control. Older workers
do not enforce the setting. The schema and provenance migration uses one
transaction and locks the Runs table while adding checks, backfills and indexes.
Stop new API intake and workers for that maintenance window. Measure the lock
duration on a representative copy before scheduling a large deployment.
During rollback, stop policy-controlled work until
policy-aware workers are restored, and retain the policy and delivery records.
