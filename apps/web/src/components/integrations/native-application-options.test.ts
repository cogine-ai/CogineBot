import { NativeAppIdSchema, NativeConfigInputSchema } from "@rakazo/contracts";
import { expect, it } from "vitest";
import {
  changeNativeCredential,
  draftNativeApplication,
  freshNativeApplication,
  GOOGLE_DEFAULT_SCOPES,
  GOOGLE_SCOPE_PREFIX,
  NATIVE_APPLICATIONS,
  nativeApplicationActors,
  nativeApplicationInput,
  nativeGmailCallbackAudience,
} from "./native-application-options";

it("offers every supported app and defaults to read access or Drive app files", () => {
  expect(NATIVE_APPLICATIONS.map((app) => app.id).sort()).toEqual(
    [...NativeAppIdSchema.options].sort(),
  );
  for (const [app, expected] of Object.entries(GOOGLE_DEFAULT_SCOPES)) {
    const draft = freshNativeApplication(NativeAppIdSchema.parse(app));
    expect(draft.ownership).toBe("byo");
    expect(draft.credentialKind).toBe("oauth");
    expect(draft.scopes).toEqual([
      "openid",
      "email",
      ...expected.map((scope) => GOOGLE_SCOPE_PREFIX + scope),
    ]);
    expect(draft.scopes).not.toContain(`${GOOGLE_SCOPE_PREFIX}drive`);
    expect(draft.scopes).not.toContain(`${GOOGLE_SCOPE_PREFIX}gmail.send`);
    expect(draft.capabilities).toEqual([]);
  }
  expect(freshNativeApplication("google-drive").scopes).toEqual([
    "openid",
    "email",
    `${GOOGLE_SCOPE_PREFIX}drive.file`,
  ]);
});
it("Gmail push configuration round-trips for the owner and uses the instance event audience", () => {
  const googleWatch = {
    projectId: "fixture-project",
    topicName: "projects/fixture-project/topics/gmail",
    subscriptionName: "projects/fixture-project/subscriptions/gmail",
    pushServiceAccountEmail: "push@fixture-project.iam.gserviceaccount.com",
    callbackAudience: nativeGmailCallbackAudience(
      "https://instance.example.test/api/connectors/oauth/callback",
    ),
  };
  expect(googleWatch.callbackAudience).toBe(
    "https://instance.example.test/api/connectors/events/gmail",
  );
  const input = nativeApplicationInput({
    ...freshNativeApplication("gmail"),
    label: "Fixture",
    clientId: "fixture-client",
    googleWatch,
  });
  expect(NativeConfigInputSchema.safeParse(input).success).toBe(true);
  expect(freshNativeApplication("gmail").googleWatch).toBeUndefined();
  const draft = draftNativeApplication({
    ...input,
    id: "fixture-config",
    revision: 1,
    callbackUri: "https://instance.example.test/api/connectors/oauth/callback",
    hasClientSecret: true,
  });
  expect(nativeApplicationInput(draft).googleWatch).toEqual(googleWatch);
  expect(NativeConfigInputSchema.safeParse({ ...input, appId: "google-drive" }).success).toBe(
    false,
  );
});
it("keeps GitHub installation actor and identities across editing without leaking editor metadata", () => {
  const draft = changeNativeCredential(freshNativeApplication("github"), "github_app_installation");
  const input = nativeApplicationInput({
    ...draft,
    label: "Fixture",
    githubAppId: "123",
    githubInstallationId: "456",
  });
  expect(NativeConfigInputSchema.safeParse(input).success).toBe(true);
  const edited = draftNativeApplication({
    ...input,
    id: "fixture-config",
    revision: 3,
    hasClientSecret: true,
    callbackUri: "https://instance.example.test/callback",
  });
  const saved = nativeApplicationInput(edited);
  expect(saved).toMatchObject({
    actor: "installation",
    githubAppId: "123",
    githubInstallationId: "456",
    expectedRevision: 3,
  });
  expect(saved).not.toHaveProperty("hasClientSecret");
  expect(saved).not.toHaveProperty("callbackUri");
  expect(saved).not.toHaveProperty("clientSecret");
});
it("credential changes preserve the actual actor and discard incompatible or secret fields", () => {
  const installation = {
    ...changeNativeCredential(freshNativeApplication("github"), "github_app_installation"),
    githubAppId: "123",
    githubInstallationId: "456",
  };
  expect(changeNativeCredential(installation, "personal_token")).toMatchObject({
    actor: "user",
    githubAppId: undefined,
    githubInstallationId: undefined,
  });
  const slack = {
    ...freshNativeApplication("slack"),
    actor: "user" as const,
    scopes: ["search:read", "channels:read"],
    capabilities: ["slack_user_data_allowed", "slack_legacy_search_allowed"],
  };
  expect(changeNativeCredential(slack, "bot_token")).toMatchObject({
    actor: "bot",
    scopes: ["channels:read"],
    capabilities: [],
  });
  expect(freshNativeApplication("slack").capabilities).toEqual([]);
  expect(freshNativeApplication("linear").scopes).toEqual([]);
  expect(changeNativeCredential(freshNativeApplication("linear"), "oauth").scopes).toEqual([
    "read",
  ]);
});

it("uses public provider profiles for remaining app credentials, actor and scope defaults", async () => {
  const { NATIVE_REMAINING_PROFILES } = await import("@rakazo/contracts");
  for (const [appId, profile] of Object.entries(NATIVE_REMAINING_PROFILES)) {
    const draft = freshNativeApplication(NativeAppIdSchema.parse(appId));
    expect(draft.credentialKind).toBe(profile.credentialKinds[0]);
    expect(draft.actor).toBe(profile.actors[0]);
    expect(draft.scopes).toEqual(profile.defaultScopes);
  }
  expect(freshNativeApplication("hubspot").actor).toBe("app");
});
it("HubSpot private credentials switch back to account actor and discard the client secret", () => {
  const draft = changeNativeCredential(
    { ...freshNativeApplication("hubspot"), actor: "user", clientSecret: "fixture-secret" },
    "personal_token",
  );
  expect(draft.actor).toBe("app");
  expect(draft.clientSecret).toBeUndefined();
});
it("target IDs and platform configuration round-trip without exposing saved credentials", () => {
  const input = nativeApplicationInput({
    ...freshNativeApplication("discord"),
    credentialKind: "bot_token",
    actor: "bot",
    label: "Bot",
    ownership: "official",
    tenantId: "123456",
    targetIdsText: "12345, 23456\n12345",
    clientSecret: "fixture-token",
  });
  expect(input.targetIds).toEqual(["12345", "23456"]);
  expect(input).not.toHaveProperty("targetIdsText");
  const edited = draftNativeApplication({
    ...input,
    id: "fixture",
    revision: 2,
    hasClientSecret: true,
    callbackUri: "https://instance.example.test/callback",
  });
  const saved = nativeApplicationInput(edited);
  expect(saved.targetIds).toEqual(["12345", "23456"]);
  expect(saved).not.toHaveProperty("clientSecret");
  expect(saved.expectedRevision).toBe(2);
  expect(NativeConfigInputSchema.safeParse(input).success).toBe(true);
});
it("Feishu/Lark region and WeCom agent stay scoped to their real application", () => {
  const lark = nativeApplicationInput({
    ...freshNativeApplication("feishu-lark"),
    label: "Lark",
    region: "lark",
    clientId: "fixture",
    clientSecret: "fixture-secret",
  });
  expect(lark.region).toBe("lark");
  const wecom = nativeApplicationInput({
    ...freshNativeApplication("wecom"),
    label: "WeCom",
    credentialKind: "machine_key",
    actor: "app",
    clientId: "corp",
    agentId: "1000001",
    clientSecret: "fixture-secret",
  });
  expect(wecom.agentId).toBe("1000001");
  expect(wecom).not.toHaveProperty("region");
  const ordinary = nativeApplicationInput({
    ...freshNativeApplication("airtable"),
    label: "Fixture",
    agentId: "forbidden",
    region: "lark",
    targetIdsText: "12345",
  });
  expect(ordinary).not.toHaveProperty("region");
  expect(ordinary).not.toHaveProperty("agentId");
  expect(ordinary).not.toHaveProperty("targetIds");
});

it("enterprise actors follow the actual authorization protocol rather than the profile union", () => {
  for (const appId of ["feishu-lark", "dingtalk", "wecom"] as const) {
    const machine = freshNativeApplication(appId);
    expect(nativeApplicationActors(machine)).toEqual(["app"]);
    const oauth = changeNativeCredential(machine, "oauth");
    const expected = appId === "wecom" ? "app" : "user";
    expect(oauth.actor).toBe(expected);
    expect(nativeApplicationActors(oauth)).toEqual([expected]);
    expect(changeNativeCredential(oauth, "machine_key").actor).toBe("app");
  }
});
it("enterprise callback secrets are write-only, omitted when unchanged, and scoped to supported OAuth", () => {
  const original = nativeApplicationInput({
    ...changeNativeCredential(freshNativeApplication("feishu-lark"), "oauth"),
    label: "Lark OAuth",
    clientId: "fixture-app",
    verificationToken: "fixture-verification",
    encryptionKey: "fixture-encryption",
  });
  expect(original).toMatchObject({
    verificationToken: "fixture-verification",
    encryptionKey: "fixture-encryption",
  });
  const edited = draftNativeApplication({
    ...original,
    id: "fixture",
    revision: 2,
    hasClientSecret: true,
    hasVerificationToken: true,
    hasEncryptionKey: true,
    callbackUri: "https://instance.example.test/callback",
  });
  expect(edited.hasVerificationToken).toBe(true);
  expect(edited.hasEncryptionKey).toBe(true);
  const unchanged = nativeApplicationInput(edited);
  expect(unchanged).not.toHaveProperty("verificationToken");
  expect(unchanged).not.toHaveProperty("encryptionKey");
  expect(unchanged).not.toHaveProperty("hasVerificationToken");
  expect(unchanged).not.toHaveProperty("hasEncryptionKey");
  expect(
    nativeApplicationInput({
      ...freshNativeApplication("dingtalk"),
      label: "DingTalk",
      verificationToken: "fixture",
      encryptionKey: "fixture",
    }),
  ).not.toHaveProperty("verificationToken");
  const machine = changeNativeCredential(
    { ...edited, verificationToken: "unsaved", encryptionKey: "unsaved" },
    "machine_key",
  );
  expect(machine.verificationToken).toBeUndefined();
  expect(machine.encryptionKey).toBeUndefined();
});
