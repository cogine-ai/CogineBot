import type { NativeAppConfig } from "@rakazo/db";
import { expect, it } from "vitest";
import { NativeOAuthAuthorities } from "./native-connectors/authorities.js";
import { ThirdPartyConnectorEmulator } from "./third-party-connector-emulator.js";

function config(appId: string): NativeAppConfig {
  return {
    id: "emulated-source",
    appId,
    label: "Synthetic native source",
    ownership: "byo",
    credentialKind: appId === "slack" ? "bot_token" : "oauth",
    enabled: true,
    revision: 1,
    callbackUri: "http://127.0.0.1:3110/api/connectors/oauth/callback",
    config: {
      clientId: `e2e-native-${appId}`,
      actor: appId === "slack" ? "bot" : "user",
      scopes: appId === "google-drive" ? ["https://www.googleapis.com/auth/drive.file"] : [],
      capabilities: [],
      knowledgeBaseIds: [],
    },
    ciphertext: null,
    secretRecordId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}
it.each(["gmail", "google-drive", "google-docs", "google-sheets", "google-slides", "google-tasks"])(
  "native %s fixture passes actual OAuth authority and fixed userinfo reads",
  async (appId) => {
    const emulator = new ThirdPartyConnectorEmulator();
    const authority = new NativeOAuthAuthorities({
      fetch: emulator.fetch,
      resolveHostname: emulator.resolveHostname,
    });
    try {
      const result = await authority.exchange(
        config(appId),
        "synthetic-secret",
        "e2e-native-read-only",
        "verifier",
        new AbortController().signal,
      );
      expect(result.identity.subject).toBe("e2e-native-google-user");
      expect(result.scopes).toHaveLength(3);
    } finally {
      await authority.close();
    }
  },
);
it("native Drive Picker fixture verifies Drive identity and exact selected file over HTTP", async () => {
  const emulator = new ThirdPartyConnectorEmulator();
  const authority = new NativeOAuthAuthorities({
    fetch: emulator.fetch,
    resolveHostname: emulator.resolveHostname,
  });
  try {
    const result = await authority.exchangeDrivePicker(
      config("google-drive"),
      "synthetic-secret",
      "e2e-drive-picker",
      "verifier",
      "e2e-drive-file",
      new AbortController().signal,
    );
    expect(result.scopes).toEqual(["https://www.googleapis.com/auth/drive.file"]);
    expect(result.identity.subject).toBe("drive-permission:e2e-drive-permission");
    await expect(
      authority.exchangeDrivePicker(
        config("google-drive"),
        "synthetic-secret",
        "e2e-drive-picker",
        "verifier",
        "other_file",
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  } finally {
    await authority.close();
  }
});
it("native Slack fixture resolves actual bot identity and rejects business writes", async () => {
  const emulator = new ThirdPartyConnectorEmulator();
  const authority = new NativeOAuthAuthorities({
    fetch: emulator.fetch,
    resolveHostname: emulator.resolveHostname,
  });
  try {
    const result = await authority.collaboration.verifyStatic(
      config("slack"),
      "xoxb-e2e-native-batch2",
      new AbortController().signal,
    );
    expect(result.identity.context.tokenType).toBe("bot");
    expect(result.identity.tenant).toBe("TE2ENATIVE");
    const written = await emulator.fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: "Bearer xoxb-e2e-native-batch2" },
      body: JSON.stringify({ channel: "CE2ENATIVE", text: "Must not write" }),
    });
    expect(await written.json()).toEqual({ ok: false, error: "read_only_fixture" });
  } finally {
    await authority.close();
  }
});
