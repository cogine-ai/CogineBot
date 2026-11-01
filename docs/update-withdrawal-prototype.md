# Downloaded update withdrawal prototype

This is an offline protocol and installation-gate prototype. Production desktop
construction does not enable it. There is no production feed, publisher, signing
key, new environment setting, or Web/mobile RPC. Normal desktop updates retain
their existing behavior. Both prototype constructors reject outside `NODE_ENV=test`.

## Signed metadata

The test composition fixes an HTTPS origin, an Ed25519 test public key and a local
serial file. It reads only `/revocations/v1.json` and `/revocations/v1.json.sig`,
without redirects. Requests have size and time limits. The detached 64-byte
signature covers the original UTF-8 manifest bytes, including whitespace.

The version-one manifest contains `schemaVersion`, `serial`, `issuedAt`,
`expiresAt`, `channel` and `revoked`. Each revoked entry contains `version`,
`platform`, `arch`, standard-base64 `sha512` and a bounded plain-text `reason`.
Manifests are limited to 256 KiB and at most 24 hours of validity. Future, expired,
invalid, wrong-channel and rollback metadata cannot authorize installation.
The same serial must retain the same bytes. Higher serials can withdraw or restore
an artifact. A version alone never identifies a package.
Version one uses one `JSON.parse` interpretation and ignores additional signed
fields. A production publisher must also enforce unambiguous property names and
compatible parsing before promotion.

The serial store is scoped to the feed origin, channel and test-key fingerprint.
Use a separate file for each namespace. Accepted serials are atomically written
before returning a result. Corrupt, missing-parent, locked or unwritable stores
fail closed. An interrupted lock is not automatically removed; inspect and recover
the test store explicitly. Fresh-client reopening tests read the same on-disk store,
not power-loss durability or protection against a local attacker replacing state.

## Download and installation boundaries

The prototype receives a trusted test-build platform, architecture and channel.
It hashes a synthetic downloaded file and requires the digest to belong to the
updater's verified download metadata. It does not assume the first metadata entry
is the selected artifact, or that process architecture identifies a Rosetta build.
The file path stays in the main-process prototype and is never sent to a renderer.

The downloaded callback synchronously disables the library's automatic-quit path
before asynchronous verification. Ready downloads are rechecked hourly, on the
prototype foreground hook and through a manual Check. Manual installation checks
the signed feed again, hashes the file again, and serializes the final fresh-state
and download-generation checks with the install effect. Late results cannot
approve a replacement download. Installation errors can retry through the same
gate; an already dispatched native installation cannot be rolled back.
After confirmed withdrawal, manual Check can also request a replacement version.
An empty update feed retains the withdrawn package and its refusal state.

`clear` permits the guarded installation path only while fresh. `revoked` refuses
installation and projects a sanitized reason. `unknown` retains the downloaded
file, refuses installation and allows a later check. A 404, offline response or
ordinary update-not-available event is never evidence of withdrawal.

The library's unguarded automatic-quit path stays disabled throughout this PoC.
Its test-only quit simulation accepts only an already-clear, fresh receipt and a
fresh local digest, without an exit-time network request. Unknown, expired or
in-flight checks decline immediately. The production host does not attach this
simulation, foreground hook or timer. Ordinary exit need not be intercepted.

The prototype's contextual messages are “This update was withdrawn.” followed by
the signed plain-text reason or “Check for a new version.”, and “Could not confirm
this update. Check again before installing.” They distinguish withdrawal from an
unconfirmed download only when the explicit test composition is active.

## Validation and promotion

Run the deterministic protocol, controller and native-effect boundary checks with:

```sh
pnpm exec vitest run apps/desktop/src/auto-update.test.ts apps/desktop/src/auto-update.revocations.test.ts apps/desktop/src/update-revocation-gate.test.ts apps/desktop/src/update-revocations.test.ts apps/desktop/src/update-revocations.updater.test.ts
```

The fixed public test-vector key is confined to test fixtures outside the desktop
build input. Tests use temporary serial files, synthetic packages and local HTTPS;
no real installer, Electron window or production credential is required. Native
effects are replaced in the installed updater's actual methods. These tests
establish call ordering, not installed macOS/Windows acceptance.

Production promotion requires a publisher that signs, publishes and refreshes
metadata before expiry; an embedded production trust root and reviewed rotation
path; reproducible serial recovery and withdrawal/restoration; and real supported
platform tests for manual and quit installation, offline/expired publisher
failures, and updates already handed to the native installer. A static file that
expires after 24 hours is insufficient. Production remains disabled until those
requirements are met. This package adds no publishing or scheduled workflow.
