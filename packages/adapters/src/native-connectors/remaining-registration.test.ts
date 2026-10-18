import type { AdapterContext, ArtifactStore } from "@rakazo/adapter-kit";
import {
  NATIVE_REMAINING_PROFILES,
  NativeAppIdSchema,
  remainingNativeProfile,
} from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { EncryptedSecretStore } from "../secrets.js";
import { botPlatformApps } from "./bot-platforms/index.js";
import { BOT_PLATFORM_METADATA } from "./bot-platforms/metadata.js";
import { businessFilesApps } from "./business-files/index.js";
import { BUSINESS_FILES_APPS } from "./business-files/metadata.js";
import { enterpriseApps } from "./enterprise/index.js";
import { ENTERPRISE_APP_METADATA } from "./enterprise/metadata.js";
import { microsoftApps } from "./microsoft/index.js";
import { MICROSOFT_APP_METADATA, MICROSOFT_IDENTITY_SCOPES } from "./microsoft/metadata.js";
import { NativeConnectorProvider } from "./provider.js";
import { workManagementApps } from "./work-management/index.js";
import { WORK_MANAGEMENT_METADATA } from "./work-management/metadata.js";

const sorted = (values: readonly string[]) => [...values].sort();
describe("native registration and public configuration stay aligned", () => {
  it("registers exactly the original 13 plus the remaining 24 actual native applications", async () => {
    const provider = new NativeConnectorProvider(
      { connection: { findMany: async () => [] } } as unknown as PrismaClient,
      new EncryptedSecretStore("registration-fixture-key"),
      "https://api.example.test",
      { artifacts: {} as ArtifactStore },
    );
    vi.spyOn(provider.oauth, "expireSessions").mockResolvedValue(undefined);
    vi.spyOn(provider.configurations, "statuses").mockResolvedValue([]);
    const context: AdapterContext = {
      userId: "synthetic-owner",
      spaceId: "synthetic-space",
      operationId: "catalog",
      traceId: "catalog",
      signal: new AbortController().signal,
    };
    try {
      const catalog = await provider.catalog(context);
      expect(catalog).toHaveLength(37);
      expect(new Set(catalog.map((app) => app.slug)).size).toBe(37);
      expect(sorted(catalog.map((app) => app.slug))).toEqual(sorted(NativeAppIdSchema.options));
      expect(provider.configurations.statuses).toHaveBeenCalledWith(context.spaceId);
    } finally {
      await provider.close();
    }
  });
  it("exposes the completed fixed action sets without duplicate action identities", () => {
    const apps = [
      ...microsoftApps,
      ...workManagementApps,
      ...businessFilesApps,
      ...enterpriseApps,
      ...botPlatformApps,
    ];
    expect(apps).toHaveLength(24);
    const actions = apps.flatMap((app) => app.actions);
    expect(actions).toHaveLength(204);
    expect(new Set(actions.map((action) => action.id)).size).toBe(actions.length);
    for (const action of actions) {
      expect(action.inputSchema).toMatchObject({ type: "object" });
      expect(typeof action.execute).toBe("function");
    }
  });
  it("keeps profile scopes, actors and credential types equal to the actual authority contracts", () => {
    expect(Object.keys(NATIVE_REMAINING_PROFILES)).toHaveLength(24);
    const families = [
      ...Object.entries(MICROSOFT_APP_METADATA).map(([app, meta]) => ({
        app,
        scopes: [...MICROSOFT_IDENTITY_SCOPES, ...meta.scopes],
        actors: ["user"],
        kinds: ["oauth"],
      })),
      ...Object.entries(WORK_MANAGEMENT_METADATA).map(([app, meta]) => ({
        app,
        scopes: meta.scopes,
        actors: [meta.actor],
        kinds: meta.authKinds,
      })),
      ...Object.entries(BUSINESS_FILES_APPS).map(([app, meta]) => ({
        app,
        scopes: meta.scopes,
        actors: meta.actors,
        kinds: meta.credentialKinds,
      })),
      ...Object.entries(ENTERPRISE_APP_METADATA).map(([app, meta]) => ({
        app,
        scopes: meta.scopes,
        actors: meta.actors,
        kinds: meta.credentialKinds,
      })),
      ...Object.entries(BOT_PLATFORM_METADATA).map(([app, meta]) => ({
        app,
        scopes: meta.scopes,
        actors: [meta.actor],
        kinds: meta.authKinds,
      })),
    ];
    for (const { app, scopes, actors, kinds } of families) {
      const profile = remainingNativeProfile(app)!;
      expect(sorted(profile.scopes), app).toEqual(sorted(scopes));
      expect(sorted(profile.actors), app).toEqual(sorted(actors));
      expect(sorted(profile.credentialKinds), app).toEqual(sorted(kinds));
      expect(
        profile.defaultScopes.every((scope) => profile.scopes.includes(scope)),
        app,
      ).toBe(true);
    }
  });
});
