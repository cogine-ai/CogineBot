# Security

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/cogine-ai/CogineBot/security/advisories/new). Private reporting is enabled for this repository. Do not disclose an unfixed vulnerability in a public issue or pull request.

Include the affected commit, a minimal reproduction using synthetic data, the expected and observed behavior, and the potential impact. Indicate whether the issue is already public. Redact credentials and personal data; never include a complete `.env` file or a production account.

## Scope and current status

Reports about code maintained in this repository are welcome, including inherited Rakazo code. Relevant areas include authentication, authorization, credential storage, sandbox boundaries, host commands, and integrations. Vulnerabilities in external services should also be reported to their owners; describe any impact on this repository in a private report here.

CogineBot is in the preparation stage and has no company release with a supported-version policy yet. Current work starts from the fixed upstream revision recorded in [UPSTREAM.md](UPSTREAM.md). Existing dependency advisories and incomplete validation are recorded in the [preparation baseline](docs/preparation-baseline.md); this repository has not been accepted for shared public hosting.

For non-security bugs or development questions, use [Issues](https://github.com/cogine-ai/CogineBot/issues). No response time or bounty is promised by this policy.

Modified on 2026-10-09 to use CogineBot's private reporting route and current release status. The original policy remains in the upstream Git history.
