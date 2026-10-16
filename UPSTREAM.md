# Upstream provenance

| Item | Value |
| --- | --- |
| Company repository | <https://github.com/cogine-ai/CogineBot> |
| Upstream repository | <https://github.com/elie222/rakazo> |
| Starting revision | `794a76da6eb0a73532a89cf57d2f202ef9b6b6c8` |
| Reachable commits at the starting revision | 1,132, including the starting commit |
| Initial adaptation date | 2026-10-09 |
| Latest integrated upstream snapshot | `932534d7785f0c51b6a0aed54d0096ea8b36eb11` |
| Root license | Apache-2.0, retained verbatim |

The company `main` branch begins with all history reachable from the fixed starting revision. At initialization, the adaptation added project documentation and identified third-party license notices without changing runtime behavior or dependency versions. `README.upstream.md` preserves the README from that initial baseline, with its original names and distribution references; it is a historical source reference, not the current CogineBot installation guide.

This is an independent repository, with upstream history preserved without requiring GitHub's fork relationship. Upstream branches and tags are not mirrored into the company remote. Later upstream revisions are incorporated through reviewed integrations, including the fixed snapshot above.

For a development checkout, use `origin` for CogineBot and `upstream` for Rakazo:

```sh
git remote add upstream https://github.com/elie222/rakazo.git
git fetch --no-tags upstream
```

Review proposed upstream updates on a separate branch, record the source revision and conflicts, and repeat the relevant verification before integrating them. Never replace company history with a force push or blindly mirror upstream branches and tags.

The latest integrated revision is a complete upstream snapshot. Maintenance changes are combined with the existing CogineBot adaptations rather than copied over whole files. The retained product contracts and deliberately deferred capability changes are recorded in [upstream adaptations](docs/upstream-adaptations.md). Source integration does not publish an upstream release or configure its hosted services.

CogineBot now has its own public application identity, installer and image destinations, and update channels. [Version 0.2.1](https://github.com/cogine-ai/CogineBot/releases/tag/v0.2.1) is a published desktop release. Internal `@rakazo/*` package names and compatible configuration keys remain intentionally unchanged; upstream attribution and license notices are retained.

GitHub Actions were disabled at initialization. Reviewed source checks, container and desktop releases, Android APK publishing, and the trusted-main mobile OTA job are now active as described in [automation.md](docs/automation.md). The remaining inherited workflows stay archived outside the active workflow directory. Scheduled jobs, production SSH deployment, and report publishing require a separate reviewed activation.

No upstream `NOTICE` file existed in the initial fixed tracked tree. Existing source notices and copyrights remain intact. `THIRD_PARTY_NOTICES.md` adds the complete license text for identified copied MIT material; review asset provenance and binary/container distribution obligations against the actual contents of each release.
