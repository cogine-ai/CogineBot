import { describe, expect, it, vi } from "vitest";
import { verifyBackupModelKey } from "./backup-model-key.js";

describe("backup model key verification", () => {
  it("checks the reviewed OpenRouter model against the key's filtered catalog", async () => {
    const model = { provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" };
    const key = "synthetic-openrouter-key";
    const fetcher = vi.fn<typeof fetch>();
    fetcher
      .mockResolvedValueOnce(Response.json({ data: [{ id: "another/model" }] }))
      .mockResolvedValueOnce(Response.json({ data: [{ id: model.modelId }] }));

    await expect(verifyBackupModelKey(model, key, undefined, fetcher)).rejects.toThrow(
      "The key cannot use the reviewed model",
    );
    await expect(verifyBackupModelKey(model, key, undefined, fetcher)).resolves.toContain(key);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url).toBe("https://openrouter.ai/api/v1/models/user");
      expect(new Headers(options?.headers).get("Authorization")).toBe(`Bearer ${key}`);
      expect(options?.redirect).toBe("error");
    }
  });
});
