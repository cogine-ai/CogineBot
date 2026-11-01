# GitHub plugin installations

Open **GitHub plugins** from the web Plugins panel or mobile Integrations settings.
Enter a public `https://github.com/owner/repository` URL, optionally with a ref or
plugin subdirectory, and choose **Preview**. Review the original Skill instructions,
remote MCP endpoints, skipped components and version details before installing.
Electron uses the same panel as the web app.

Preview does not install anything. Installation re-fetches the exact reviewed commit
and verifies its content digest. It imports self-contained `SKILL.md` files as
read-only Skills in the current user's Space and remote HTTPS HTTP/SSE MCP server
definitions. Imported servers start disabled with no allowed tools. Configure and
approve them separately through the existing MCP controls; installation never
connects a server, runs repository code or grants tool permissions.

Only public github.com sources are supported. The importer limits acquisition to
30 seconds, 200 files, 4,000,000 total bytes, 100,000 bytes per file and 200 supported
components. Symlinks, submodules and paths outside the selected plugin directory
are rejected. Local processes, hooks, companion files and variable templates are
not imported; the preview lists skipped components. Marketplace discovery and a
guided connection flow are not included in this version.

MCP header values use the existing encrypted secret store and never appear in the
public preview or installation receipt. A package that repeats a detected header
credential in public content is rejected. Inspect all instructions before installing;
the importer does not certify their intent. Existing or built-in Skill names cannot
be overwritten.

If an installation response is interrupted, choose **Check status** before retrying.
The same request identifies its durable outcome, including failures and removals;
it cannot reinstall a removed plugin. A new preview creates a new installation
intent. Closing a preview writes nothing; closing after installation begins does
not undo a committed installation.

The installation owner or current Space owner can remove a plugin. Removal first
disables its servers and instructions and closes its pending connection/tool approval
cards. Never-dispatched tool requests receive a removal result; a waiting Run resumes
only when no other input is pending. Already-dispatched external work is not undone.
Credential cleanup failures remain visible as **Cleanup incomplete** and can be retried.
An unacknowledged credential write remains pending until its provider outcome can be
reconciled; it is never reported as successful cleanup.

## Offline validation

The parser and shared UI controller have deterministic unit fixtures. PostgreSQL
acceptance uses authenticated application HTTP, real transactions and a real durable
worker, with synthetic repository data and local emulated MCP transports:

```sh
pnpm test:integration -- --spec=plugin- --sandbox=fake --runtime=scripted
pnpm test:e2e -- --spec=github-plugins --sandbox=fake --runtime=scripted
```

These checks do not establish live GitHub availability, hosted secret-store deletion,
real OAuth, or installed native-device acceptance.
