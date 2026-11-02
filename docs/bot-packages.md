# Bot packages

Choose **Import bot** when creating a Bot, or open the package tools in a Bot's
settings to export a portable JSON copy. Web and Electron share the same interface;
mobile uses its document picker and system share sheet. The existing full backup
export remains available separately.

## Review and import

Paste JSON or choose a UTF-8 file up to 4 MiB. Supported formats are
`coginebot.package/v1`, `openmaus.grok/1` and `grokbot-bundle/v1`. This flow reads
the supplied JSON; a public link does not retrieve private instructions.

Choose **Preview** and read the profile, original Skill instructions, routines,
connection requirements and omitted-content report. Recognized credentials are
redacted before preview and export. Ordinary email addresses and instruction
formatting are preserved. Automated detection cannot identify every secret: inspect
the reviewed content and the exported file before sharing it.

Import creates a new Bot in your current Space. It never updates an existing Bot,
copies a model account or starts a Run. Package Skills remain pending until you
explicitly activate them. Activation creates a shared Skill available to your Bots
in that Space; a conflicting name requires an explicit rename and cannot overwrite
an existing or built-in Skill. Imported routines start paused with notifications
off. Connection requirements are reminders; use the existing connection settings
and permission controls to configure each service.

**Include memory** starts off. Enabling it copies the package's included notes into
the new Bot's isolated memory. Import does not fetch external memory or copy shared
account memory. The package supports at most 200 Skills, 50 routines, 30 connection
requirements and 100 memory notes. Notes total at most 1 MiB, with 256 KiB per note.
Unsupported components and redactions appear in the preview.

Previews authorize a fixed reviewed document for ten minutes. Changing the source,
name or memory choice requires a new preview. Expired preview records are cleaned
in bounded batches by subsequent package requests; an idle server does not promise
deletion at the exact expiry time.

## Interrupted requests

If an import response is lost, choose **Check status** before retrying. Recovery
keeps the same request identity, so retries cannot create a second Bot. **Recent
imports** lets you explicitly recover one of your latest requests in the current
Space after closing the screen. A server-admitted import can be resumed from its
stored reviewed document even after its preview expires.

Cancelling an unresolved import prevents that request from creating a Bot later.
Cancellation and closing the screen do not undo a completed import. Removing the
resulting Bot also cannot cause an old request to recreate it. If Skill activation
loses its response, read its current status before another activation attempt.

## Export and sharing

Export includes the Bot profile, pending package Skills, routines and connection
requirements. Shared Skills are included only when you select them; built-in
Skills are excluded. Memory is off by default and, when selected, includes only
notes owned by that Bot. Models, credentials, fleet relationships, computer state,
conversation history and connection grants are not copied. Review the exclusions
before downloading or sharing the JSON.

Mobile writes a temporary file with a random directory name before opening the
share sheet. The local share cache is bounded to ten files and 40 MiB; files older
than 24 hours are reclaimed on a later share attempt. The share sheet returning
does not prove that another app has finished reading the file. Once handed to
another app, a shared copy cannot be revoked through this cache.

## Offline validation

Deterministic parser and controller fixtures cover input limits, credential
redaction, interrupted replies, cancellation races and stale account/Space results.
Authenticated HTTP/PostgreSQL and browser acceptance cover actual transactions,
Skill conflicts, explicit export and recovery after a lost response:

```sh
pnpm test:integration -- --spec=bot-packages --sandbox=fake --runtime=scripted
pnpm test:e2e -- --spec=bot-packages --sandbox=fake --runtime=scripted
```

These checks do not establish real model/provider access, installed mobile-device
sharing or an installed Electron window's behavior.
