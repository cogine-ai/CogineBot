# Upstream provenance

| Item | Value |
| --- | --- |
| Company repository | <https://github.com/cogine-ai/CogineBot> |
| Upstream repository | <https://github.com/elie222/rakazo> |
| Starting revision | `794a76da6eb0a73532a89cf57d2f202ef9b6b6c8` |
| Reachable commits at the starting revision | 1,132, including the starting commit |
| Initial adaptation date | 2026-10-09 |
| Root license | Apache-2.0, retained verbatim |

The company `main` branch begins with all history reachable from the fixed starting revision. The initialization commit adds project documentation and identified third-party license notices. It does not modify runtime behavior or dependency versions. The upstream README is copied verbatim to `README.upstream.md`, keeping its repository-relative links usable.

Upstream branches, later revisions, and release tags are not imported into the company remote. This is an independent repository; upstream history is preserved without requiring GitHub's fork relationship.

For a development checkout, use `origin` for CogineBot and `upstream` for Rakazo:

```sh
git remote add upstream https://github.com/elie222/rakazo.git
git fetch --no-tags upstream
```

Review proposed upstream updates on a separate branch, record the source revision and conflicts, and repeat the relevant verification before integrating them. Never replace company history with a force push or blindly mirror upstream branches and tags.

Existing package names, application branding, installer URLs, update channels, and workflows still refer to Rakazo. Their adaptation is separate work. GitHub Actions remain disabled at initialization; image publishing, desktop releases, mobile updates, scheduled jobs, and report publishing must be reviewed before enabling company automation.

No upstream `NOTICE` file exists in the fixed tracked tree. Existing source notices and copyrights remain intact. `THIRD_PARTY_NOTICES.md` adds the complete license text for identified copied MIT material; remaining asset provenance and any future binary/container distribution obligations require review against the actual distributed contents.
