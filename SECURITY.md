# Security

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/cogine-ai/CogineBot/security/advisories/new). Private reporting is enabled for this repository. Do not disclose an unfixed vulnerability in a public issue or pull request.

Include the affected commit, a minimal reproduction using synthetic data, the expected and observed behavior, and the potential impact. Indicate whether the issue is already public. Redact credentials and personal data; never include a complete `.env` file or a production account.

## Scope and current status

Reports about code maintained in this repository are welcome, including inherited Rakazo code. Relevant areas include authentication, authorization, credential storage, sandbox boundaries, host commands, and integrations. Vulnerabilities in external services should also be reported to their owners; describe any impact on this repository in a private report here.

CogineBot has published [version 0.2.1](https://github.com/cogine-ai/CogineBot/releases/tag/v0.2.1). Reports should identify the affected release or exact commit; no long-term support window is defined here. The upstream provenance is recorded in [UPSTREAM.md](UPSTREAM.md). The [preparation baseline](docs/preparation-baseline.md) is a historical record from the initial adaptation, not the current release's security or test status.

A published desktop release does not establish that every self-hosted configuration is suitable for shared public hosting. Review the [self-hosting guide](docs/self-host.md) and the applicable authentication, secret-storage, and computer-isolation settings for your deployment.

For non-security bugs or development questions, use [Issues](https://github.com/cogine-ai/CogineBot/issues). No response time or bounty is promised by this policy.

Modified on 2026-10-16 to reflect CogineBot's published release and distinguish historical validation from current reports. The original policy remains in the upstream Git history.
