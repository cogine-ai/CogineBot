import { NativeAppIdSchema, NativeConfigInputSchema } from "@rakazo/contracts";
import { expect, it } from "vitest";
import {
  changeNativeCredential,
  draftNativeApplication,
  freshNativeApplication,
  GOOGLE_DEFAULT_SCOPES,
  GOOGLE_SCOPE_PREFIX,
  NATIVE_APPLICATIONS,
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
