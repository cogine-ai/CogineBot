import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
) as {
  name?: string;
  productName?: string;
  build?: {
    productName?: string;
    appId?: string;
    extraMetadata?: { name?: string };
    mac?: { icon?: string };
    linux?: { executableName?: string };
    publish?: { provider: string; owner: string; repo: string }[];
  };
};

describe("desktop package metadata", () => {
  it("shares the customer-facing name between Electron and electron-builder", () => {
    expect(packageJson.productName).toBe("CogineBot");
    expect(packageJson.build?.productName).toBeUndefined();
  });

  it("uses CogineBot packaging and update ownership", () => {
    expect(packageJson.name).toBe("@rakazo/desktop");
    expect(packageJson.build?.extraMetadata?.name).toBe("coginebot-desktop");
    expect(packageJson.build?.appId).toBe("ai.cogine.coginebot.desktop");
    expect(packageJson.build?.mac?.icon).toBe("../../packages/ui-tokens/assets/CogineBot.icon");
    expect(packageJson.build?.linux?.executableName).toBe("coginebot");
    expect(packageJson.build?.publish).toEqual([
      { provider: "github", owner: "cogine-ai", repo: "CogineBot" },
    ]);
  });
});
