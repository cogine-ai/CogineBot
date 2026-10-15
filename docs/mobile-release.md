# Mobile builds and store releases

CogineBot's public repository does not contain production App Store Connect,
Google Play, Apple team, or private EAS submission identifiers. Those values
belong in the release operator's private configuration.

Self-hosters normally do not need to publish their own mobile app: the CogineBot
client can select a compatible server from the sign-in screen. If you distribute
your own branded build, use your own Expo and store accounts.

## Configure a build

1. Create an Expo project owned by your account. Set `EXPO_OWNER` to that account
   or organization and `EAS_PROJECT_ID` to the project UUID. They are public
   configuration, not signing credentials. Set them in the release operator's
   shell and EAS environments; GitHub release workflows read the same names from
   repository variables. Set `EXPO_PUBLIC_API_URL` as a public repository variable
   too, so production config can resolve before EAS fetches remote environment
   values. `EXPO_TOKEN` remains a repository secret. Never reuse the upstream Expo project or update URL.
2. Verify the iOS and Android application identifiers belong to your release.
3. Configure `EXPO_PUBLIC_API_URL` in the EAS build environment. Production
   builds require a valid HTTPS URL.
4. Keep store application IDs, team IDs, signing credentials, API keys, and
   review-account credentials out of Git.
5. Before a native iOS or Android build, run
   `pnpm --filter @rakazo/mobile exec expo install --check`. Attachment pickers
   and other Expo native modules must match the SDK (SDK 57 needs
   `expo-image-picker@~57.0.11`, not 17.x). Use `pnpm exec expo install --fix`
   from `apps/mobile` if that check fails.

From `apps/mobile`:

```sh
export EXPO_OWNER="<your-expo-owner>"
export EAS_PROJECT_ID="<your-expo-project-uuid>"
export EXPO_PUBLIC_API_URL="https://app.example.com"
eas env:create --environment production --name EXPO_OWNER --value "$EXPO_OWNER" --visibility plaintext
eas env:create --environment production --name EAS_PROJECT_ID --value "$EAS_PROJECT_ID" --visibility plaintext
eas env:create --environment production --name EXPO_PUBLIC_API_URL --value "$EXPO_PUBLIC_API_URL" --visibility plaintext
eas build --platform ios --profile production
eas submit --platform ios --profile production --latest
```

EAS can prompt for store identity interactively. For automated submission, add
the required identifiers through a private CI configuration or a short-lived
local change that is never committed.

The dynamic Expo configuration derives the build, push-token, and OTA project
from `EAS_PROJECT_ID`. `production`, `android-apk`, and `preview` distributions
fail before building if the Expo owner or project is missing; ordinary source
development does not require a release account and never falls back to the
upstream project. Production builds still require an HTTPS API. Local
development without an Expo project cannot receive that project's push or OTA
updates; this does not remove either capability from configured builds.

Before submission, verify the production API, account deletion, sign-in,
notifications, store privacy answers, age rating, screenshots, support page,
and review account on a physical device.

The default privacy link points to CogineBot's repository-hosted
[`PRIVACY.md`](../PRIVACY.md), which describes the product's data handling.
Before public distribution, verify that the disclosure matches your deployment;
use the backend's existing `PRIVACY_POLICY_URL` to link to your own published
policy when needed. Do not invent a policy URL merely to complete the release
configuration.

## Android APK

The APK publishing path is available before a Google Play listing. Once a signed
CogineBot APK has actually been published, Android users can install it. Run the
`release-android-apk` workflow from `main` in GitHub Actions when native code
changes. It builds the `android-apk` EAS profile, signed with the project's
managed keystore, and replaces the rolling `android` GitHub release, so the
download link stays the same:

```text
https://github.com/cogine-ai/CogineBot/releases/download/android/coginebot.apk
```

Only the current `main` commit may publish this rolling release. If `main` advances
during the build, dispatch a new run from `main` instead of rerunning the old build.

The APK uses the production update channel, so JavaScript changes reach it
through the over-the-air updates below without a new APK. A Google Play install
is signed with Play's key, so switching from the APK to Play means uninstalling
the APK first.

## Over-the-air updates

Production and preview builds include `expo-updates` and use the corresponding
EAS Update channel. Expo's built-in `fingerprint` runtime policy derives native
compatibility from the project rather than relying on a manual app-version
bump. JavaScript and shared styles can update compatible builds; changes to
native code, configuration, plugins, or dependencies that change the fingerprint
require new iOS and Android builds. Switching from the former `appVersion`
policy also requires new native builds once. Use the same Expo project identity
for builds and updates.

After all Repository CI source-check lanes pass on a `main` push, CI publishes
the latest complete bundle to the production channel for both platforms. It
serializes publication and skips stale revisions rather than filtering only
the latest push's paths. The repository needs `EXPO_OWNER`, `EAS_PROJECT_ID`,
and HTTPS `EXPO_PUBLIC_API_URL` variables plus an `EXPO_TOKEN` Actions secret
with access to that project. If all four are absent, CI explicitly reports
that mobile publishing is not configured and publishes nothing. Partial
configuration fails; configured publishing and native release builds retain
the production configuration checks.

To publish a compatible update manually from `apps/mobile`:

```sh
export EXPO_OWNER="<your-expo-owner>"
export EAS_PROJECT_ID="<your-expo-project-uuid>"
export EXPO_PUBLIC_API_URL="https://app.example.com"
EAS_BUILD_PROFILE=production eas update --platform all --channel production --environment production --message "Short description"
```

Installed release builds download a compatible update in the background on
launch and apply it after the next restart. Builds created before
`expo-updates` was configured cannot receive OTA updates and must be replaced
with a new iOS and Android build once.
