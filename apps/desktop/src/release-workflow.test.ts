import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/release-desktop.yml"),
  "utf8",
);
const macosValidation = readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/validate-desktop-macos.yml"),
  "utf8",
);

const expression = (inner: string) => `\${{ ${inner} }}`;

describe("desktop release workflow", () => {
  it("cannot execute contributor pull-request code with release credentials", () => {
    expect(workflow).not.toMatch(/^\s*pull_request:/m);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(3);
  });

  it("pins every third-party action to an immutable commit", () => {
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map((match) => match[1]);
    expect(actionReferences.length).toBeGreaterThan(0);
    for (const reference of actionReferences) {
      expect(reference, reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("requires signed platform builds before a single publication job", () => {
    expect(workflow).toContain("-c.forceCodeSigning=true");
    expect(workflow).toContain("codesign --verify --deep --strict");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain("needs: [validate, build]");
    expect(workflow).toContain("attestations: write");
    expect(workflow).toContain("actions/attest-build-provenance@");
    expect(workflow).not.toContain("--publish always");
    expect(workflow).toContain("DESKTOP_MAC_CSC_LINK");
    expect(workflow).toContain("DESKTOP_WIN_CSC_LINK");
    expect(workflow).not.toMatch(/secrets\.DESKTOP_CSC_(?:LINK|KEY_PASSWORD)/);
    expect(workflow).not.toContain("cache: pnpm");
    expect(workflow).toContain("apps/desktop/out/latest*.yml");
    expect(workflow).not.toContain("apps/desktop/out/*.yml");
  });

  it("notarizes macOS with a short-lived App Store Connect API key file", () => {
    for (const secret of ["APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_API_KEY_P8"]) {
      expect(workflow).toContain(`secrets.${secret}`);
    }
    expect(workflow).not.toMatch(/secrets\.(?:APPLE_ID|APPLE_APP_SPECIFIC_PASSWORD)\b/);
    // The same temp path is declared by the setup, packaging, and cleanup steps.
    const keyFile = `APPLE_API_KEY: ${expression("runner.temp")}/apple-api-key.p8`;
    expect(workflow.split(keyFile)).toHaveLength(4);
    expect(workflow).toContain(`printf '%s\\n' "$APPLE_API_KEY_P8" > "$APPLE_API_KEY"`);
    expect(workflow).toContain('chmod 600 "$APPLE_API_KEY"');
    expect(workflow).toMatch(
      /if: always\(\) && runner\.os == 'macOS'\n(?:.*\n){3}\s+run: rm -f "\$APPLE_API_KEY"/,
    );
  });

  it("keeps all desktop platforms and blocks incomplete signed releases", () => {
    expect(workflow).toContain(
      `include: ${expression("fromJSON(needs.validate.outputs.platforms)")}`,
    );
    expect(workflow).toContain(
      `include='[{"os":"macos-26","artifact":"macos"},{"os":"ubuntu-24.04","artifact":"linux"},{"os":"windows-2022","artifact":"windows"}]'`,
    );
    expect(workflow).not.toContain("WINDOWS_SIGNING:");
    expect(workflow).not.toContain("WINDOWS_BUILT:");
    expect(workflow).toContain("Require Windows signing credentials");
    expect(workflow).toContain('test -n "$WIN_CSC_LINK"');
    expect(workflow).toContain('test -n "$WIN_CSC_KEY_PASSWORD"');
    expect(workflow).toContain("test -f release-artifacts/latest.yml");
    expect(workflow).toContain("compgen -G 'release-artifacts/*.exe' >/dev/null");
  });

  it("pins every platform update feed to the official GitHub owner and repo", () => {
    expect(workflow).toContain('grep -Fqx "provider: github"');
    expect(workflow).toContain('grep -Fqx "owner: cogine-ai"');
    expect(workflow).toContain('grep -Fqx "repo: CogineBot"');
    expect(workflow).toContain("Verify Linux update feed is pinned to the official GitHub channel");
    expect(workflow).toContain("Windows update config missing");
    expect(workflow).toContain("RELEASE_VERSION:");
    expect(workflow).toContain('grep -Fqx "version: $RELEASE_VERSION"');
  });

  it("publishes only a complete stable, upgrade-only feed", () => {
    expect(workflow).toContain("^v([0-9]+)\\.([0-9]+)\\.([0-9]+)$");
    expect(workflow).toContain("must be newer than published release");
    expect(workflow).toContain("group: release-desktop-stable");
    expect(workflow).toContain("latest.yml");
    expect(workflow).toContain("latest-mac.yml");
    expect(workflow).toContain("latest-linux.yml");
    expect(workflow).toContain("--draft --generate-notes");
    expect(workflow).toContain("--draft=false --latest");
  });
});

describe("macOS distribution validation", () => {
  it("cannot publish or execute pull-request code with signing credentials", () => {
    expect(macosValidation).toContain("branches: [work/release-ownership]");
    expect(macosValidation).toContain("workflow_dispatch:");
    expect(macosValidation).not.toMatch(/^\s*(?:pull_request(?:_target)?|workflow_run):/m);
    expect(macosValidation).toContain("permissions:\n  contents: read");
    expect(macosValidation).not.toMatch(/\b(?:contents|packages|id-token): write/);
    expect(macosValidation).not.toMatch(/gh release|git push|eas (?:update|submit)|docker push/);
    expect(macosValidation).toContain("persist-credentials: false");
    expect(macosValidation).toContain("github.ref_type == 'branch'");
    for (const match of macosValidation.matchAll(/uses:\s+([^\s#]+)/g)) {
      expect(match[1]).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("uses the formal signing command and removes the API key even on failure", () => {
    const command = "--mac --universal --publish never -c.forceCodeSigning=true";
    expect(workflow).toContain(command);
    expect(macosValidation).toContain(command);
    for (const secret of [
      "DESKTOP_MAC_CSC_LINK",
      "DESKTOP_MAC_CSC_KEY_PASSWORD",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
      "APPLE_API_KEY_P8",
    ]) {
      expect(macosValidation).toContain(`secrets.${secret}`);
    }
    expect(macosValidation).toContain('chmod 600 "$APPLE_API_KEY"');
    expect(macosValidation).toMatch(/if: always\(\)\n(?:.*\n){2}\s+run: rm -f "\$APPLE_API_KEY"/);
    expect(macosValidation).not.toContain("-c.mac.notarize=false");
  });

  it("requires signed notarized distributables before retaining only release assets", () => {
    for (const check of [
      "codesign --verify --deep --strict",
      'xcrun stapler validate "$app"',
      'spctl --assess --type execute "$app"',
      'lipo "$app/Contents/MacOS/CogineBot" -verify_arch x86_64 arm64',
      'hdiutil verify "$dmg"',
      'unzip -tq "$zip"',
      'xcrun stapler validate "$mountpoint/CogineBot.app"',
    ]) {
      expect(macosValidation).toContain(check);
    }
    expect(macosValidation).toContain("trap cleanup EXIT");
    expect(macosValidation).toContain("retention-days: 7");
    const upload = macosValidation.slice(macosValidation.indexOf("- name: Retain validated"));
    expect(upload).not.toContain("if: always()");
    expect(upload).not.toMatch(/\.p8|\.p12|\.log|test-report|test-results|\.env/);
    expect(upload).toContain("apps/desktop/out/SHA256SUMS");
  });
});
