# Copy credentials between deployments

Use a bot's **Advanced** settings to copy its saved passwords and API keys to a bot you own on another deployment. Start on the receiving deployment, enter the source deployment's exact HTTPS origin, then open the protected source page. Sign in to each deployment with the account that owns the selected bot.

Select credentials at the source. At the target, review both deployment fingerprints, the account/Space/bot mapping, and the per-item plan. Existing target credentials are kept by default; an overwrite needs an explicit choice and a new preview. Approve the plan at the target, then confirm the same plan at the source to begin copying. The pairing's write authorization lasts five minutes from its creation.

The source is retained. Website logins copy only the protected username and password; extra sign-in methods stay at the source. OAuth connections need authorization at the target. Command variables, TOTP seeds, 1Password tokens, provider settings, files, and chat history are outside this flow. Ordinary bot packages continue to contain no credential values.

Web and Electron use the protected transfer pages. Mobile can start pairing and check recent results in bot settings, then open the protected page to complete the two-sided review. This does not change the mobile app's connected deployment or put credentials into a chat.

## Check an uncertain result

Reopen the saved transfer page and choose **Check status**. A lost response is not proof that a write failed. Status checks read durable receipts and inspect an existing pending write; they do not create another secret, adopt it, or delete it. They can persist receipt observations and discard an expired local pairing grant. An explicit continuation can recover the same intent when its original authorization remains valid. An unknown remote write is never retried as a second create.

A copied receipt records the original acceptance. Later status checks can separately report that the target credential changed or was removed. They do not restore its old value.

Stopping a transfer prevents further admission. An operation already in flight may finish, and accepted results remain copied. Stopping does not revoke a credential already received by the other deployment. Remove an accepted target credential through its normal management controls if needed. Deleting a source credential is always a separate action.

## Deployment requirements and recovery

Both deployments need public HTTPS origins and a reachable backend. Private, loopback, metadata and private MagicDNS destinations are refused, including through redirects. The transfer feature is unavailable on an HTTP deployment; other application features remain available. Each deployment keeps a persistent signing identity encrypted with its configured secret store. An unreadable identity fails closed rather than silently changing its fingerprint.

Values travel only between the two backends over HTTPS, inside the bound transfer protocol, and are encrypted through the target's configured secret store. They are not returned in transfer metadata, receipts, browser fields, or model input. Each deployment remains responsible for its own TLS endpoint and server access.

Completion or explicit stopping retires the encrypted pairing grant when no continuation needs it. Expired grants lose write authority even when their session is never revisited; they are discarded on a later status check. There is no background retention sweep for untouched expired sessions.

After a whole-database restore, old transfer write authority must be revoked before exposing the API. The development restore script applies `scripts/restore-transfer-fence.sql` in the same transaction as the SQL import. For other restore tooling, keep application writers stopped, restore into the intended database, apply that file with SQL errors treated as fatal, and only then restart writers. The fence rotates stored credential revisions and revokes old transfer grants without deleting accepted receipts or unresolved provider evidence. A normal restart does not revoke transfers. Restoring a database cannot undo external writes that already happened.

Confirmed, unadopted writes remain protected if their owner, Space or bot disappears. Operators can inspect and retire orphaned confirmed writes through the existing secrets CLI, using the currently configured store:

```sh
pnpm --filter @rakazo/api secrets:infisical --cleanup-orphaned-transfers --dry-run
pnpm --filter @rakazo/api secrets:infisical --cleanup-orphaned-transfers
```

This mode does not run a storage migration and works with encrypted-only storage. It keeps accepted credentials, restore-fenced evidence and uncertain reservations. An uncertain delete retains its marker for an explicit retry. Keep provider access until pending writes have been reconciled; a provider's missing-key response does not exclude a late create.
