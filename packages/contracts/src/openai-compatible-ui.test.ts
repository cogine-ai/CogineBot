import { describe, expect, it } from "vitest";
import {
  modelConnectionLabel,
  openAiCompatibleConnectReady,
  openAiCompatibleProbeSuccessMessage,
  sameOpenAiCompatibleBaseUrl,
} from "./openai-compatible-ui.js";

describe("openAiCompatibleConnectReady", () => {
  it("does not expose embedded credentials in connection labels", () => {
    expect(
      modelConnectionLabel({
        provider: "openai-compatible",
        label: "Server",
        baseUrl: "https://user:secret@models.example",
      }),
    ).toBe("Server");
  });
  it("reuses a saved key only for valid canonical endpoint aliases", () => {
    expect(
      sameOpenAiCompatibleBaseUrl("https://models.example", "https://models.example/v1/"),
    ).toBe(true);
    expect(
      sameOpenAiCompatibleBaseUrl("https://models.example/a", "https://models.example/b"),
    ).toBe(false);
    expect(sameOpenAiCompatibleBaseUrl("https://models.example", "https://other.example")).toBe(
      false,
    );
    expect(sameOpenAiCompatibleBaseUrl("https://", "https://")).toBe(false);
    expect(
      sameOpenAiCompatibleBaseUrl(
        "https://user:secret@models.example",
        "https://user:secret@models.example",
      ),
    ).toBe(false);
  });
  it("allows a new connection with base URL and explicit model id", () => {
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "qwen",
      }),
    ).toBe(true);
  });

  it("rejects empty base URL or model id", () => {
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "  ",
        modelId: "qwen",
      }),
    ).toBe(false);
    expect(
      openAiCompatibleConnectReady({
        baseUrl: "http://127.0.0.1:8000/v1",
        modelId: "",
      }),
    ).toBe(false);
  });

  it("guides manual entry when a successful probe lists no models", () => {
    expect(openAiCompatibleProbeSuccessMessage(0)).toBe("Server found. Enter a model name.");
  });
});
