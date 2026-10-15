# Desktop releases

The [release-desktop workflow](../.github/workflows/release-desktop.yml) builds,
signs, notarizes, attests, and publishes CogineBot from a `vMAJOR.MINOR.PATCH` tag
on `main`. Docker image publishing triggers from the same tag. The workflow is
configured for this repository; no signed download is available merely because
this configuration exists. Provision and verify the project's own signing
credentials before running a release.

## Formats and update channel

The inherited platform targets are unchanged: macOS Universal DMG and update ZIP,
Windows x64 NSIS installer, and Linux x64 AppImage.
Generated filenames use the `CogineBot` product name. The application ID,
release destination, and updater point to CogineBot rather than
Rakazo. Internal `@rakazo/*` package names are retained.

Installers, generated `latest*.yml` feeds, blockmaps, `SHA256SUMS`, and build
attestations are produced by the existing workflow and packager. Compare the
actual filenames, feed references, signatures, and downloads before publication;
there is no separate custom release-manifest format.

The desktop updater reads releases from `cogine-ai/CogineBot`. Beta tags do not
satisfy this workflow's stable-tag validation; enabling another desktop channel
would require a separately reviewed change.

## Repository secrets

macOS (required):

| Secret | Value |
| --- | --- |
| `DESKTOP_MAC_CSC_LINK` | Base64 of the `Developer ID Application` certificate exported as `.p12` |
| `DESKTOP_MAC_CSC_KEY_PASSWORD` | Password used when exporting the `.p12` |
| `APPLE_API_KEY_ID` | App Store Connect API key ID (the `XXXXXXXXXX` in `AuthKey_XXXXXXXXXX.p8`) |
| `APPLE_API_ISSUER` | Issuer ID shown on App Store Connect > Users and Access > Integrations |
| `APPLE_API_KEY_P8` | Contents of the `AuthKey_*.p8` file |

The API key needs the Developer role. The workflow writes it to a mode 600 file
in the runner's temp directory for the packaging step and deletes it afterwards.

`patches/app-builder-lib@26.15.3.patch` carries electron-builder PR #10101:
without it `CSC_LINK` signing fails while creating the temporary keychain. Drop
the patch once an electron-builder release includes that fix.

Windows (required):

| Secret | Value |
| --- | --- |
| `DESKTOP_WIN_CSC_LINK` | Base64 of the Authenticode certificate as `.p12`/`.pfx` |
| `DESKTOP_WIN_CSC_KEY_PASSWORD` | Its password |

All three desktop platforms are required. Missing macOS or Windows signing
credentials fail that platform instead of silently omitting it. The release is
only published after macOS, Linux, and Windows produce their installers and
matching update feeds.

Set a secret from a file without echoing it:

```sh
base64 -i devid.p12 | gh secret set DESKTOP_MAC_CSC_LINK
gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
```

## Cut a release

### Validate macOS without publishing

The [macOS validation workflow](../.github/workflows/validate-desktop-macos.yml)
uses the same Universal packaging, signing, and notarization commands as the
release workflow, with read-only repository permissions. It verifies the app,
DMG, ZIP, update ownership, and notarization ticket, then retains the installers,
update metadata, and checksums as Actions artifacts for seven days. It never
creates a tag or release, pushes container images, or publishes mobile updates.

Pushes to `work/release-ownership` bootstrap this check before the workflow is
on `main`; it also supports manual dispatch once available on the default
branch. Select a trusted branch revision, never a contributor pull request, for
any workflow that uses signing secrets. This macOS-only validation does not
reduce the three-platform requirements for a formal desktop release.

### Publish the complete desktop release

1. Bump `version` in `apps/desktop/package.json` on `main`.
2. Tag that commit `v<version>` and push the tag:

```sh
git tag v0.1.1
git push origin v0.1.1
```

The workflow refuses tags that do not match the desktop version, are not on
`main`, or are not newer than the latest published release.
