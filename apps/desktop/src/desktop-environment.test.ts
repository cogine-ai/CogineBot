import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  desktopDevelopmentId,
  desktopProfileRoot,
  parseDesktopDevelopment,
  resolveDesktopEnvironment,
} from "./desktop-environment.js";

const development = { workspaceRoot: "/workspace/one", viteUrl: "http://127.0.0.1:5173/" };

describe("desktop environment", () => {
  it("keeps the installed identity and profile despite a development shell setting", () => {
    const installed = resolveDesktopEnvironment({
      packaged: true,
      developmentConfig: JSON.stringify(development),
    });
    expect(installed).toMatchObject({ scheme: "coginebot", development: null });
    expect(installed.appId).toBe("ai.cogine.coginebot.desktop");
    expect(desktopProfileRoot(installed, "/profiles")).toBeNull();
    expect(desktopProfileRoot(installed, "/profiles", "/test-profile")).toBe("/test-profile");
  });

  it.each([true, false])(
    "recognizes explicit development metadata when packaged=%s",
    (packaged) => {
      const env = resolveDesktopEnvironment({ packaged, metadata: development });
      expect(env).toMatchObject({ name: "CogineBot Dev", scheme: "coginebot-dev" });
      expect(env.development?.viteUrl).toBe("http://127.0.0.1:5173");
      expect(desktopProfileRoot(env, "/profiles")).toBe(
        path.join("/profiles", "CogineBot Dev", env.appId),
      );
      expect(desktopProfileRoot(env, "/profiles", "/test-profile")).toBe(
        path.join("/test-profile", "CogineBot Dev", env.appId),
      );
    },
  );

  it("uses the explicitly selected Vite config for an unpackaged development launch", () => {
    const env = resolveDesktopEnvironment({
      packaged: false,
      developmentConfig: JSON.stringify(development),
    });
    expect(env.development).toEqual({ ...development, viteUrl: "http://127.0.0.1:5173" });
  });

  it("gives different workspaces distinct handler ownership, profiles and instance locks", () => {
    const one = resolveDesktopEnvironment({ packaged: true, metadata: development });
    const two = resolveDesktopEnvironment({
      packaged: true,
      metadata: { ...development, workspaceRoot: "/workspace/two" },
    });
    expect(one.appId).not.toBe(two.appId);
    expect(one.appId).toBe(desktopDevelopmentId(development.workspaceRoot));
    expect(desktopProfileRoot(one, "/profiles")).not.toBe(desktopProfileRoot(two, "/profiles"));
  });

  it.each([
    "http://localhost:5173",
    "http://127.0.0.2:5173",
    "http://[::1]:5173",
    "https://localhost:5173",
  ])("accepts the configured local Vite origin %s", (viteUrl) =>
    expect(parseDesktopDevelopment({ ...development, viteUrl }).viteUrl).toBe(viteUrl),
  );

  it.each([
    "https://public.example.test",
    "http://192.168.1.10:5173",
    "file:///workspace/index.html",
    "http://user:password@localhost:5173",
    "http://localhost:5173/other",
    "http://localhost:5173/?server=https://public.example.test",
    "http://localhost:5173/#other",
  ])("rejects an unrelated development target %s", (viteUrl) => {
    expect(() => parseDesktopDevelopment({ ...development, viteUrl })).toThrow();
  });

  it("rejects malformed explicit metadata instead of falling back to installed data", () => {
    expect(() => resolveDesktopEnvironment({ packaged: true, metadata: {} })).toThrow();
    expect(() => resolveDesktopEnvironment({ packaged: true, metadata: null })).toThrow();
    expect(() => parseDesktopDevelopment({ ...development, workspaceRoot: "relative" })).toThrow();
  });
});
