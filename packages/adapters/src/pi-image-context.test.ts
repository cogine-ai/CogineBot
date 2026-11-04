import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ContextBudgetError, estimateContextTokens, selectContext } from "./context-selection.js";
import { createPiImageTokenEstimator, estimatePiImageTokens } from "./pi-image-context.js";

describe("target image context planning", () => {
  it("uses the high-resolution tier for native Opus 5.5", async () => {
    const part = await pngPart(4096, 4096);
    const target = { ...sonnetTarget, id: "claude-opus-5-5" };
    expect(createPiImageTokenEstimator(target)(part)).toBe(4761);
    expect(
      createPiImageTokenEstimator({ ...target, baseUrl: "https://models.example" })(part),
    ).toBe(262_144);
    expect(createPiImageTokenEstimator({ ...target, provider: "anthropic-compatible" })(part)).toBe(
      262_144,
    );
  });

  it("uses Sonnet 5.5's automatic high-resolution patches without an opt-in", async () => {
    const image = await sharp({
      create: { width: 2000, height: 1500, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const estimate = createPiImageTokenEstimator({
      provider: "anthropic",
      id: "claude-sonnet-5-5",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    });
    expect(estimate({ type: "image", data: image.toString("base64"), mimeType: "image/png" })).toBe(
      3888,
    );
  });

  it("uses GPT-6 Astra's original-resolution auto policy for a native Responses target", async () => {
    const image = await sharp({
      create: { width: 4096, height: 4096, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const estimate = createPiImageTokenEstimator({
      provider: "openai",
      id: "gpt-6-astra",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(estimate({ type: "image", data: image.toString("base64"), mimeType: "image/png" })).toBe(
      19_661,
    );
  });
});

const astraTarget = {
  provider: "openai",
  id: "gpt-6-astra",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
} as const;
const sonnetTarget = {
  provider: "anthropic",
  id: "claude-sonnet-5-5",
  api: "anthropic-messages",
  baseUrl: "https://api.anthropic.com",
} as const;
const unknownTarget = { ...astraTarget, id: "gpt-6.1-sol" };

async function pngPart(width: number, height: number) {
  const bytes = await sharp({ create: { width, height, channels: 3, background: "white" } })
    .png()
    .toBuffer();
  return { type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" };
}

describe("target image policy boundaries", () => {
  it.each([
    ["claude-sonnet-5-5", 4761],
    ["claude-haiku-5-5", 4761],
    ["claude-fable-5", 4761],
    ["claude-fable-5-1", 4761],
    ["claude-opus-5", 4761],
    ["claude-sonnet-5", 4761],
    ["claude-opus-4-8", 4761],
    ["claude-opus-4-7", 4761],
    ["claude-opus-4-7-20261015", 4761],
    ["claude-opus-4-6", 262_144],
    ["claude-sonnet-4-20250514", 262_144],
    ["claude-haiku-4-5-20251001", 262_144],
    ["claude-opus-latest", 262_144],
    ["claude-unknown-5-5", 262_144],
    ["claude-opus-5-5-preview", 262_144],
    ["claude-opus-4-7-20261015-extra", 262_144],
    ["claude-opus-9007199254740992", 262_144],
  ])("resolves the documented native Claude resolution tier for %s", async (id, expected) => {
    const part = await pngPart(4096, 4096);
    expect(createPiImageTokenEstimator({ ...sonnetTarget, id })(part)).toBe(expected);
  });

  it.each([
    ["native Responses", astraTarget, 19_661],
    ["native ChatGPT plan Responses", { ...astraTarget, provider: "chatgpt-plan" }, 19_661],
    ["native Chat Completions default auto", { ...astraTarget, api: "openai-completions" }, 19_661],
    [
      "native Codex Responses",
      {
        ...astraTarget,
        provider: "openai-codex",
        api: "openai-codex-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      },
      19_661,
    ],
    [
      "same ID on a custom endpoint",
      { ...astraTarget, baseUrl: "https://models.example/v1" },
      262_144,
    ],
    ["same ID on a custom provider", { ...astraTarget, provider: "openai-compatible" }, 262_144],
    ["same ID through an unrelated API", { ...astraTarget, api: "anthropic-messages" }, 262_144],
    ["unpublished Sol policy", unknownTarget, 262_144],
    ["unrecognized future family", { ...astraTarget, id: "gpt-6-future" }, 262_144],
  ] as const)("keeps target identity isolated: %s", async (_name, target, expected) => {
    const part = await pngPart(4096, 4096);
    expect(createPiImageTokenEstimator(target)(part)).toBe(expected);
  });

  it.each([
    [200, 200, 1024],
    [1000, 1000, 1296],
    [1920, 1080, 2691],
    [2000, 1500, 3888],
    [3840, 2160, 4784],
    [2160, 3840, 4784],
  ])("applies default Sonnet 5.5 patches to %ix%i", async (width, height, expected) => {
    const part = await pngPart(width, height);
    expect(createPiImageTokenEstimator(sonnetTarget)(part)).toBe(expected);
  });

  it("does not assign native Sonnet policy to an identical custom model ID", async () => {
    const part = await pngPart(2000, 1500);
    expect(
      createPiImageTokenEstimator({ ...sonnetTarget, baseUrl: "https://models.example" })(part),
    ).toBe(47_376);
  });

  it("preserves original image bytes through target-aware context admission", async () => {
    const part = Object.freeze(await pngPart(4096, 4096));
    const selected = selectContext([{ role: "user", content: [part] }], {
      budget: {
        contextWindow: 32768,
        outputReserve: 4096,
        systemPrompt: "Inspect the image",
        tools: [],
        imageTokens: createPiImageTokenEstimator(astraTarget),
      },
      strategy: "retrieval",
    });
    expect(selected.messages[0]!.content).toEqual([part]);
    expect(selected.estimatedInputTokens).toBeGreaterThan(19_661);
    expect(selected.estimatedInputTokens).toBeLessThan(32768 - 4096);
  });

  it.each([
    ["standard", estimatePiImageTokens],
    ["native Astra", createPiImageTokenEstimator(astraTarget)],
    ["native Sonnet", createPiImageTokenEstimator(sonnetTarget)],
    ["unknown", createPiImageTokenEstimator(unknownTarget)],
  ] as const)(
    "saturates unsafe APNG dimensions with multiple frames: %s",
    async (_name, estimate) => {
      const png = Buffer.from((await pngPart(1, 1)).data, "base64");
      png.writeUInt32BE(0xffffffff, 16);
      png.writeUInt32BE(0xffffffff, 20);
      const control = Buffer.alloc(20);
      control.writeUInt32BE(8, 0);
      control.write("acTL", 4, "ascii");
      control.writeUInt32BE(2, 8);
      const animated = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]);
      expect(
        estimate({ type: "image", data: animated.toString("base64"), mimeType: "image/png" }),
      ).toBe(Number.MAX_SAFE_INTEGER);
    },
  );

  it("retains the legacy aggregate floor and validates animation after the selected frame", async () => {
    const gif = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } })
      .gif()
      .toBuffer();
    const paletteEnd = 13 + 3 * 2 ** ((gif[10]! & 7) + 1);
    const animated = Buffer.concat([
      gif.subarray(0, -1),
      gif.subarray(paletteEnd, -1),
      gif.subarray(-1),
    ]);
    const part = { type: "image", data: animated.toString("base64"), mimeType: "image/gif" };
    expect(estimatePiImageTokens(part)).toBe(2048);
    expect(createPiImageTokenEstimator(unknownTarget)(part)).toBe(1024);
    expect(createPiImageTokenEstimator(sonnetTarget)(part)).toBe(1024);
    expect(createPiImageTokenEstimator(astraTarget)(part)).toBe(2048);
    const malformed = { ...part, data: animated.subarray(0, -1).toString("base64") };
    expect(createPiImageTokenEstimator(sonnetTarget)(malformed)).toBeUndefined();
    expect(createPiImageTokenEstimator(unknownTarget)(malformed)).toBeUndefined();
  });

  it("saturates unsafe original area even when legacy tile multiplication remains safe", async () => {
    const part = await pngPart(1, 1);
    const bytes = Buffer.from(part.data, "base64");
    bytes.writeUInt32BE(0xffffffff, 16);
    bytes.writeUInt32BE(3_000_000, 20);
    expect(
      createPiImageTokenEstimator(unknownTarget)({ ...part, data: bytes.toString("base64") }),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("retains the default APNG image and all declared animation frames for native Sonnet", async () => {
    const part = await pngPart(640, 480);
    const png = Buffer.from(part.data, "base64");
    const control = Buffer.alloc(20);
    control.writeUInt32BE(8, 0);
    control.write("acTL", 4, "ascii");
    control.writeUInt32BE(2, 8);
    const animated = Buffer.concat([png.subarray(0, 33), control, png.subarray(33)]);
    expect(
      createPiImageTokenEstimator(sonnetTarget)({ ...part, data: animated.toString("base64") }),
    ).toBe(3072);
  });

  it("saturates legacy animated WebP totals and still validates the final chunk", () => {
    const vp8x = Buffer.alloc(18);
    vp8x.write("VP8X");
    vp8x.writeUInt32LE(10, 4);
    vp8x[8] = 2;
    vp8x.writeUIntLE(0xffffff, 12, 3);
    vp8x.writeUIntLE(0xffffff, 15, 3);
    const animation = Buffer.alloc(14);
    animation.write("ANIM");
    animation.writeUInt32LE(6, 4);
    const frame = Buffer.alloc(34);
    frame.write("ANMF");
    frame.writeUInt32LE(26, 4);
    frame.write("VP8 ", 24);
    frame.writeUInt32LE(1, 28);
    const webp = (frames: number) => {
      const body = Buffer.concat([vp8x, animation, ...Array.from({ length: frames }, () => frame)]);
      const header = Buffer.alloc(12);
      header.write("RIFF");
      header.writeUInt32LE(body.length + 4, 4);
      header.write("WEBP", 8);
      return Buffer.concat([header, body]);
    };
    const estimate = (bytes: Buffer) =>
      createPiImageTokenEstimator(unknownTarget)({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: "image/webp",
      });
    expect(estimate(webp(2047))).toBe(2 ** 42 * 2047);
    const overflow = webp(2048);
    expect(overflow.length).toBeLessThan(10 * 1024 * 1024);
    expect(estimate(overflow)).toBe(Number.MAX_SAFE_INTEGER);
    const malformed = Buffer.from(overflow);
    malformed.writeUInt32LE(28, malformed.length - frame.length + 4);
    expect(estimate(malformed)).toBeUndefined();
  });
});

describe("Pi image context planning", () => {
  it.each([
    ["image/png", "png"],
    ["image/jpeg", "jpeg"],
    ["image/webp", "webp"],
  ] as const)("uses dimensions from valid %s image headers", async (mimeType, format) => {
    const pipeline = sharp({
      create: { width: 640, height: 480, channels: 3, background: "white" },
    });
    const image = await pipeline[format]().toBuffer();
    expect(estimatePiImageTokens({ type: "image", data: image.toString("base64"), mimeType })).toBe(
      1024,
    );
  });

  it.each([
    [1, 1, 1024],
    [32, 32, 1024],
    [512, 512, 1024],
    [1024, 1024, 1399],
    [2048, 2048, 5593],
    [2048, 513, 1445],
    [513, 2048, 1445],
    [4000, 3000, 4195],
    [3000, 4000, 4195],
    [8000, 6000, 4195],
    [8000, 1000, 1024],
  ])("bounds a %ix%i JPEG at %i tokens", async (width, height, expected) => {
    const image = await sharp({
      create: { width, height, channels: 3, background: "white" },
    })
      .jpeg()
      .toBuffer();
    const part = { type: "image", data: image.toString("base64"), mimeType: "image/jpeg" };
    expect(estimatePiImageTokens(part)).toBe(expected);
    const selected = selectContext([{ role: "user", content: [part] }], {
      budget: {
        contextWindow: 16_384,
        outputReserve: 4096,
        systemPrompt: "Describe the image",
        tools: [],
        imageTokens: estimatePiImageTokens,
      },
      strategy: "retrieval",
    });
    expect(selected.messages[0]!.content).toEqual([part]);
    expect(selected.estimatedInputTokens).toBeLessThan(16_384 - 4096);
  });

  it("counts GIF frames over the full logical-screen canvas", async () => {
    const gif = await sharp({
      create: { width: 640, height: 480, channels: 3, background: "white" },
    })
      .gif()
      .toBuffer();
    expect(
      estimatePiImageTokens({ type: "image", data: gif.toString("base64"), mimeType: "image/gif" }),
    ).toBe(1024);
    const globalPaletteEnd = 13 + 3 * 2 ** ((gif[10]! & 7) + 1);
    const frame = gif.subarray(globalPaletteEnd, -1);
    const animated = Buffer.concat([gif.subarray(0, -1), frame, gif.subarray(-1)]);
    expect((await sharp(animated, { animated: true }).metadata()).pages).toBe(2);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: animated.toString("base64"),
        mimeType: "image/gif",
      }),
    ).toBe(2048);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: animated.subarray(0, -1).toString("base64"),
        mimeType: "image/gif",
      }),
    ).toBeUndefined();
    const smallFrame = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" },
    })
      .gif()
      .toBuffer();
    smallFrame.writeUInt16LE(640, 6);
    smallFrame.writeUInt16LE(480, 8);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: smallFrame.toString("base64"),
        mimeType: "image/gif",
      }),
    ).toBe(1024);
  });

  it("keeps malformed GIF headers and incomplete frame blocks byte-counted", async () => {
    const gif = await sharp({
      create: { width: 640, height: 480, channels: 3, background: "white" },
    })
      .gif()
      .toBuffer();
    const globalPaletteEnd = 13 + 3 * 2 ** ((gif[10]! & 7) + 1);
    const descriptor = gif.indexOf(0x2c, globalPaletteEnd);
    expect(descriptor).toBeGreaterThan(globalPaletteEnd);
    const estimate = (bytes: Buffer) =>
      estimatePiImageTokens({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: "image/gif",
      });

    const zeroCanvas = Buffer.from(gif);
    zeroCanvas.writeUInt16LE(0, 6);
    expect(estimate(zeroCanvas)).toBeUndefined();

    const invalidCodeSize = Buffer.from(gif);
    invalidCodeSize[descriptor + 10] = 9;
    expect(estimate(invalidCodeSize)).toBeUndefined();

    const incompleteLocalPalette = Buffer.from(gif.subarray(0, descriptor + 10));
    incompleteLocalPalette[descriptor + 9] = 0x80;
    expect(estimate(incompleteLocalPalette)).toBeUndefined();

    const truncatedSubBlock = Buffer.from(gif.subarray(0, descriptor + 12));
    truncatedSubBlock[descriptor + 11] = 255;
    expect(estimate(truncatedSubBlock)).toBeUndefined();
  });

  it("counts declared APNG frames and static PNG dimensions", async () => {
    const png = await sharp({
      create: { width: 640, height: 480, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    const acTL = Buffer.alloc(20);
    acTL.writeUInt32BE(8, 0);
    acTL.write("acTL", 4, "ascii");
    acTL.writeUInt32BE(2, 8);
    const animated = Buffer.concat([png.subarray(0, 33), acTL, png.subarray(33)]);
    expect(
      estimatePiImageTokens({ type: "image", data: png.toString("base64"), mimeType: "image/png" }),
    ).toBe(1024);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: animated.toString("base64"),
        mimeType: "image/png",
      }),
    ).toBe(3072);
    const fcTL = Buffer.alloc(38);
    fcTL.writeUInt32BE(26, 0);
    fcTL.write("fcTL", 4, "ascii");
    const firstFrameAnimated = Buffer.concat([png.subarray(0, 33), acTL, fcTL, png.subarray(33)]);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: firstFrameAnimated.toString("base64"),
        mimeType: "image/png",
      }),
    ).toBe(2048);
    const malformed = Buffer.from(animated);
    malformed.writeUInt32BE(0, 41);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: malformed.toString("base64"),
        mimeType: "image/png",
      }),
    ).toBeUndefined();
  });

  it("counts animated WebP frames from complete RIFF chunks", async () => {
    const pixels = Buffer.alloc(640 * 480 * 2);
    pixels.fill(255, 0, 640 * 480);
    const gif = await sharp(pixels, {
      raw: { width: 640, height: 960, channels: 1, pageHeight: 480 },
    })
      .gif({ loop: 0 })
      .toBuffer();
    const webp = await sharp(gif, { animated: true }).webp({ loop: 0 }).toBuffer();
    expect((await sharp(webp, { animated: true }).metadata()).pages).toBe(2);
    const estimate = (bytes: Buffer) =>
      estimatePiImageTokens({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: "image/webp",
      });
    expect(estimate(webp)).toBe(2048);
    expect(estimate(webp.subarray(0, -1))).toBeUndefined();
    const frameOffset = webp.indexOf(Buffer.from("ANMF"));
    expect(frameOffset).toBeGreaterThan(0);
    const emptyFrame = Buffer.from(webp.subarray(0, frameOffset + 8 + 16));
    emptyFrame.writeUInt32LE(16, frameOffset + 4);
    emptyFrame.writeUInt32LE(emptyFrame.length - 8, 4);
    expect(estimate(emptyFrame)).toBeUndefined();
  });

  it("keeps malformed images byte-counted and never substitutes image-shaped tool arguments", () => {
    const malformed = { type: "image", data: "a".repeat(300_000), mimeType: "image/png" };
    expect(estimatePiImageTokens(malformed)).toBeUndefined();
    expect(
      estimateContextTokens([{ role: "user", content: [malformed] }], estimatePiImageTokens),
    ).toBeGreaterThan(300_000);
    const call = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call", name: "upload", arguments: malformed }],
    };
    const argumentTokens = estimateContextTokens(call, estimatePiImageTokens);
    expect(argumentTokens).toBe(estimateContextTokens(call));
    expect(argumentTokens).toBeGreaterThan(80_000);
    expect(argumentTokens).toBeLessThan(110_000);
  });

  it("makes implausibly large declared dimensions exceed any configured context window", async () => {
    const image = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    image.writeUInt32BE(0xffffffff, 16);
    image.writeUInt32BE(0xffffffff, 20);
    expect(
      estimatePiImageTokens({
        type: "image",
        data: image.toString("base64"),
        mimeType: "image/png",
      }),
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("budgets a valid screenshot from dimensions while preserving its actual tool result", async () => {
    const pixels = Buffer.alloc(1024 * 1024);
    let seed = 1;
    for (let index = 0; index < pixels.length; index++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[index] = seed & 255;
    }
    const image = await sharp(pixels, { raw: { width: 1024, height: 1024, channels: 1 } })
      .png()
      .toBuffer();
    const part = { type: "image", data: image.toString("base64"), mimeType: "image/png" };
    const messages = [
      { role: "user", content: "Inspect the screen" },
      { role: "assistant", content: [{ type: "toolCall", id: "shot", name: "observe" }] },
      { role: "toolResult", toolCallId: "shot", content: [part] },
    ];
    const budget = { contextWindow: 128_000, outputReserve: 4096, systemPrompt: "", tools: [] };
    expect(() => selectContext(messages, { budget, strategy: "retrieval" })).toThrow(
      ContextBudgetError,
    );
    const selected = selectContext(messages, {
      budget: { ...budget, imageTokens: estimatePiImageTokens },
      strategy: "retrieval",
    });
    expect(estimatePiImageTokens(part)).toBe(1399);
    expect(selected.messages.at(-1)!.content).toEqual([part]);
    expect(selected.estimatedInputTokens).toBeLessThan(128_000 - 4096);
  });
});
