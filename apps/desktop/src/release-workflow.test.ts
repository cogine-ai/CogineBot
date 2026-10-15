import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

function workflowStep(name: string) {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  if (start === -1) throw new Error(`Workflow step not found: ${name}`);
  const end = workflow.indexOf("\n      - ", start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

function runWorkflowScript(name: string, env: Record<string, string>) {
  const script = workflowStep(name).match(/ {8}run: \|\n([\s\S]*)$/)?.[1];
  if (!script) throw new Error(`Workflow script not found: ${name}`);
  const directory = mkdtempSync(path.join(tmpdir(), "coginebot-release-contract-"));
  const output = path.join(directory, "output");
  const notes = path.join(directory, "notes.md");
  try {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script.replace(/^ {10}/gm, "")], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_OUTPUT: output,
        RELEASE_NOTES_FILE: notes,
        ...env,
      },
    });
    return {
      status: result.status,
      stderr: result.stderr,
      output: existsSync(output) ? readFileSync(output, "utf8") : "",
      notes: existsSync(notes) ? readFileSync(notes, "utf8") : "",
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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

  it("verifies platform signing modes before a single publication job", () => {
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

  it("keeps all desktop platforms regardless of Windows signing mode", () => {
    expect(workflow).toContain(
      `include: ${expression("fromJSON(needs.validate.outputs.platforms)")}`,
    );
    expect(workflow).toContain(
      `include='[{"os":"macos-26","artifact":"macos"},{"os":"ubuntu-24.04","artifact":"linux"},{"os":"windows-2022","artifact":"windows"}]'`,
    );
    expect(workflow).not.toContain("WINDOWS_BUILT:");
    expect(workflow).toContain(
      `windows_signing: ${expression("steps.windows_signing.outputs.enabled")}`,
    );
    expect(workflow).toContain("test -f release-artifacts/latest.yml");
    expect(workflow).toContain("compgen -G 'release-artifacts/*.exe' >/dev/null");
  });

  it.each([
    { certificate: "true", password: "true", enabled: "true" },
    { certificate: "false", password: "false", enabled: "false" },
    { certificate: "true", password: "false", enabled: null },
    { certificate: "false", password: "true", enabled: null },
  ])("fails closed for partial Windows credentials: $certificate/$password", (credentials) => {
    const result = runWorkflowScript("Resolve Windows signing mode", {
      HAS_WINDOWS_CERTIFICATE: credentials.certificate,
      HAS_WINDOWS_CERTIFICATE_PASSWORD: credentials.password,
    });
    if (credentials.enabled === null) {
      expect(result.status).toBe(1);
      expect(result.output).toBe("");
      expect(result.stderr).toContain("Configure both Windows signing secrets");
    } else {
      expect(result.status).toBe(0);
      expect(result.output).toBe(`enabled=${credentials.enabled}\n`);
    }
  });

  it("exposes only credential-presence booleans to preflight and enforces the resulting signature state", () => {
    const preflight = workflowStep("Resolve Windows signing mode");
    expect(preflight).toContain(expression("secrets.DESKTOP_WIN_CSC_LINK != ''"));
    expect(preflight).toContain(expression("secrets.DESKTOP_WIN_CSC_KEY_PASSWORD != ''"));
    for (const secret of ["DESKTOP_WIN_CSC_LINK", "DESKTOP_WIN_CSC_KEY_PASSWORD"]) {
      expect(workflow.split(expression(`secrets.${secret}`))).toHaveLength(2);
      expect(workflowStep("Package x64 Windows app with the configured signing mode")).toContain(
        expression(`secrets.${secret}`),
      );
    }
    expect(workflow).toContain('"-c.forceCodeSigning=$WINDOWS_SIGNING"');
    const verification = workflowStep("Verify Windows signing mode and official update feed");
    expect(verification).toContain(
      '$expectedStatus = if ($signingEnabled) { "Valid" } else { "NotSigned" }',
    );
    expect(verification).toContain("$signature.Status.ToString() -ne $expectedStatus");
    expect(verification).toContain("if ($signingEnabled -and -not (Select-String");
    expect(verification).toContain("$installers.Count -lt 1 -or $applications.Count -lt 1");
    expect(workflow).not.toContain("verifyUpdateCodeSignature=false");
  });

  it.each(["true", "false"])(
    "discloses the actual Windows signing mode in release notes: %s",
    (mode) => {
      const result = runWorkflowScript("Write public platform signing disclosure", {
        WINDOWS_SIGNING: mode,
      });
      expect(result.status).toBe(0);
      expect(result.notes).toContain(
        "macOS Universal: DMG and update ZIP contain a Developer ID signed, Apple notarized application",
      );
      expect(result.notes).toContain("Linux x64: AppImage");
      expect(result.notes).toContain("All three desktop platforms are included");
      if (mode === "true") {
        expect(result.notes).toContain("Windows x64: Authenticode signed");
        expect(result.notes).not.toContain("**Unsigned**");
      } else {
        expect(result.notes).toContain("Windows x64: **Unsigned**");
        expect(result.notes).toContain("publisher verification is unavailable");
      }
      expect(workflowStep("Create draft and upload every platform")).toContain(
        '--notes-file "$RELEASE_NOTES_FILE"',
      );
    },
  );

  it("does not publish when the signing disclosure mode is missing", () => {
    expect(
      runWorkflowScript("Write public platform signing disclosure", { WINDOWS_SIGNING: "" }).status,
    ).toBe(1);
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
    expect(workflow).toContain("queue: max\n  cancel-in-progress: false");
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
