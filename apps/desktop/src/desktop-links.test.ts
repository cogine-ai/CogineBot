import { describe, expect, it, vi } from "vitest";
import { consoleLinkArgument, createDesktopLinkHandler, isConsoleLink } from "./desktop-links.js";

describe("desktop Console links", () => {
  it.each(["coginebot", "coginebot-dev"] as const)(
    "accepts only the %s Console entry",
    (scheme) => {
      expect(isConsoleLink(`${scheme}://bot/`, scheme)).toBe(true);
      expect(isConsoleLink(`${scheme.toUpperCase()}://BOT/`, scheme)).toBe(true);
    },
  );

  it.each([
    "coginebot-dev://bot/",
    "cogine://bot/",
    "coginebot://bot",
    "coginebot://bot/other",
    "coginebot://bot/?url=https://outside.example.test",
    "coginebot://bot/#execute",
    "coginebot://user@bot/",
    "coginebot://bot:3000/",
    "coginebot://%62ot/",
    "coginebot://bot/../",
    " coginebot://bot/",
    "coginebot://bot/\n",
  ])("does not turn %s into navigation or an execution request", (link) => {
    const open = vi.fn();
    const invalid = vi.fn();
    const handler = createDesktopLinkHandler({ scheme: "coginebot", open, invalid });
    handler.ready();
    handler.receive(link);
    expect(open).not.toHaveBeenCalled();
    expect(invalid).toHaveBeenCalledOnce();
  });

  it("finds the protocol argument without interpreting other launch arguments", () => {
    expect(consoleLinkArgument(["/app/executable", "--other", "coginebot://bot/"])).toBe(
      "coginebot://bot/",
    );
    expect(
      consoleLinkArgument(["/app/executable", "https://outside.example.test"]),
    ).toBeUndefined();
  });

  it("coalesces links before startup and opens only after the existing startup completes", () => {
    const open = vi.fn();
    const handler = createDesktopLinkHandler({ scheme: "coginebot", open, invalid: vi.fn() });
    handler.receive("coginebot://bot/");
    handler.receive("coginebot://bot/");
    handler.open();
    expect(open).not.toHaveBeenCalled();
    handler.ready();
    expect(open).toHaveBeenCalledOnce();
    handler.ready();
    expect(open).toHaveBeenCalledOnce();
    handler.receive("coginebot://bot/");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("retains an early invalid-link error without opening an unrelated destination", () => {
    const open = vi.fn();
    const invalid = vi.fn();
    const handler = createDesktopLinkHandler({ scheme: "coginebot-dev", open, invalid });
    handler.receive("coginebot-dev://bot/?server=other");
    handler.receive("coginebot://bot/");
    expect(invalid).not.toHaveBeenCalled();
    handler.ready();
    expect(invalid).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });
});
