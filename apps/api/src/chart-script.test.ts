import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { CHART_SCRIPT_PATH, mountDiagramScript } from "./diagram-script.js";

const app = new Hono();
mountDiagramScript(app);

describe("first-party chart asset", () => {
  it("bundles the shared renderer as an executable anonymous asset with revalidation", async () => {
    const response = await app.request(CHART_SCRIPT_PATH, { headers: { origin: "null" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-type")).toContain("text/javascript");
    const body = await response.text();
    expect(body).toContain("RakazoChart");
    const runtime = Function(`${body};return RakazoChart;`)();
    expect(typeof runtime.draw).toBe("function");
    const cached = await app.request(CHART_SCRIPT_PATH, {
      headers: { "if-none-match": response.headers.get("etag")! },
    });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe("");
  });
});
