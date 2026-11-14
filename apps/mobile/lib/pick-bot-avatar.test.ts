import { BOT_AVATAR_VALUE_MAX_LENGTH } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickBotAvatar } from "./pick-bot-avatar";

const mocks = vi.hoisted(() => ({
  pick: vi.fn(),
  crop: vi.fn(),
  resize: vi.fn(),
  render: vi.fn(),
  save: vi.fn(),
  releaseImage: vi.fn(),
  releaseContext: vi.fn(),
  manipulate: vi.fn(),
  deleteFile: vi.fn(),
}));
vi.mock("expo-image-picker", () => ({ launchImageLibraryAsync: mocks.pick }));
vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: mocks.manipulate },
  SaveFormat: { WEBP: "webp" },
}));
vi.mock("expo-file-system", () => ({
  File: class {
    delete = mocks.deleteFile;
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pick.mockResolvedValue({
    canceled: false,
    assets: [{ uri: "file:///synthetic-photo.jpg", width: 600, height: 400 }],
  });
  mocks.manipulate.mockReturnValue({
    crop: mocks.crop,
    resize: mocks.resize,
    renderAsync: mocks.render,
    release: mocks.releaseContext,
  });
  mocks.render.mockResolvedValue({ saveAsync: mocks.save, release: mocks.releaseImage });
  mocks.save.mockResolvedValue({ uri: "file:///synthetic-cache.webp", base64: "AQ==" });
});

describe("native avatar photo conversion", () => {
  it("center crops and decodes to a bounded 256px webp using the system picker", async () => {
    expect(await pickBotAvatar(() => true)).toBe("data:image/webp;base64,AQ==");
    expect(mocks.pick).toHaveBeenCalledWith({
      mediaTypes: ["images"],
      allowsMultipleSelection: false,
      quality: 1,
    });
    expect(mocks.crop).toHaveBeenCalledWith({ originX: 100, originY: 0, width: 400, height: 400 });
    expect(mocks.resize).toHaveBeenCalledWith({ width: 256, height: 256 });
    expect(mocks.save).toHaveBeenCalledWith({ format: "webp", compress: 0.9, base64: true });
    expect(mocks.deleteFile).toHaveBeenCalledOnce();
    expect(mocks.releaseImage).toHaveBeenCalledOnce();
    expect(mocks.releaseContext).toHaveBeenCalledOnce();
  });
  it("does not decode after cancellation or a stale picker response", async () => {
    mocks.pick.mockResolvedValueOnce({ canceled: true, assets: null });
    expect(await pickBotAvatar(() => true)).toBeNull();
    expect(await pickBotAvatar(() => false)).toBeNull();
    expect(mocks.manipulate).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity])("rejects invalid dimensions: %s", async (width) => {
    mocks.pick.mockResolvedValueOnce({
      canceled: false,
      assets: [{ uri: "file:///bad", width, height: 20 }],
    });
    await expect(pickBotAvatar(() => true)).rejects.toThrow();
    expect(mocks.manipulate).not.toHaveBeenCalled();
  });
  it("rejects an undecodable image and releases the decoder", async () => {
    mocks.render.mockRejectedValueOnce(new Error("decode failure"));
    await expect(pickBotAvatar(() => true)).rejects.toThrow("decode failure");
    expect(mocks.releaseContext).toHaveBeenCalledOnce();
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it.each([undefined, "", "!bad", "A".repeat(BOT_AVATAR_VALUE_MAX_LENGTH)])(
    "rejects invalid or oversized encoded output",
    async (base64) => {
      mocks.save.mockResolvedValueOnce({ uri: "file:///synthetic-cache.webp", base64 });
      await expect(pickBotAvatar(() => true)).rejects.toThrow("Invalid avatar image");
      expect(mocks.deleteFile).toHaveBeenCalledOnce();
      expect(mocks.releaseImage).toHaveBeenCalledOnce();
      expect(mocks.releaseContext).toHaveBeenCalledOnce();
    },
  );
  it("discards a stale conversion and removes its temporary output", async () => {
    let current = true;
    mocks.save.mockImplementationOnce(async () => {
      current = false;
      return { uri: "file:///synthetic-cache.webp", base64: "AQ==" };
    });
    expect(await pickBotAvatar(() => current)).toBeNull();
    expect(mocks.deleteFile).toHaveBeenCalledOnce();
  });
});
