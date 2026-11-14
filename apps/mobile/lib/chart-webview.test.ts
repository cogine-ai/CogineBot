import { describe, expect, it } from "vitest";
import { chartBootScript, chartDocument, parseChartMessage } from "./chart-webview";

describe("chart document isolation", () => {
  it("loads only the configured fixed first-party bundle, without data in HTML", () => {
    const html = chartDocument("https://server.example.test/some/path");
    expect(html).toContain('src="https://server.example.test/api/v1/assets/chart.js"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).not.toContain("unsafe-eval");
    expect(html).not.toContain("script-src 'unsafe-inline'");
  });
  it.each(["file:///test", "javascript:alert(1)", "https://user:password@example.test"])(
    "rejects %s",
    (url) => {
      expect(() => chartDocument(url)).toThrow();
    },
  );
  it("serializes injected content without letting it become script", () => {
    const hostile = '</script><script>alert("test")</script>\u2028';
    const code = chartBootScript({
      requestId: "request",
      spec: { title: hostile },
      data: [{ value: hostile }],
      foreground: "currentColor",
      background: "transparent",
    });
    expect(code).not.toContain("</script>");
    let received: unknown;
    Function(
      "RakazoChart",
      code,
    )({
      draw: (request: unknown) => {
        received = request;
      },
    });
    expect(received).toMatchObject({ spec: { title: hostile }, data: [{ value: hostile }] });
  });
  it("rejects stale, malformed, and unbounded bridge responses", () => {
    for (const raw of [
      "bad",
      "null",
      "{}",
      '{"requestId":"stale","type":"failed"}',
      '{"requestId":"r","type":"drawn","height":10001}',
    ]) {
      expect(parseChartMessage(raw, "r")).toBeNull();
    }
    expect(parseChartMessage('{"requestId":"r","type":"drawn","height":300}', "r")).toEqual({
      type: "drawn",
      height: 300,
    });
  });
});
