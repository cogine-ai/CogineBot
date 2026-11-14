// @vitest-environment jsdom

import { lightTokens } from "@rakazo/ui-tokens";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { draw } from "./browser.js";
import type { PlotSpec } from "./plot-spec.js";
import { buildInteractivePlotParts, CHART_CATALOG, parsePlotData } from "./plot-spec.js";

const postMessage = vi.fn();
beforeEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.innerHTML = '<div id="chart"></div>';
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    value: 320,
  });
  window.ReactNativeWebView = { postMessage };
  postMessage.mockClear();
});

function render(spec: PlotSpec, data?: unknown[]) {
  draw({
    requestId: "test",
    spec,
    data: data ?? spec.data ?? [],
    foreground: lightTokens.foreground,
    background: lightTokens.background,
  });
  return JSON.parse(postMessage.mock.calls.at(-1)![0]);
}

describe("shared live chart renderer", () => {
  it.each(CHART_CATALOG)(
    "renders catalog: $name with the same title and legend as Web",
    ({ spec }) => {
      const web = buildInteractivePlotParts(spec, spec.data, document, { width: 320 });
      expect(render(spec).type).toBe("drawn");
      expect(document.querySelectorAll("#chart svg")).toHaveLength(1);
      expect(document.querySelector(".title")?.textContent ?? undefined).toBe(web.title);
      expect(
        [...document.querySelectorAll(".legend span")].map((item) => item.textContent),
      ).toEqual(web.swatches.map((item) => item.label));
      expect(document.querySelector("#chart svg")?.getAttribute("width")).toBe("320");
    },
  );

  it.each([
    {
      name: "numeric strings",
      data: [
        { x: "1", y: "2" },
        { x: "2", y: "3" },
      ],
    },
    { name: "CSV lines", data: ["x,y", "1,2", "2,3"] },
  ])("supports $name", ({ data }) => {
    expect(render({ marks: [{ type: "line", options: { x: "x", y: "y" } }] }, data).type).toBe(
      "drawn",
    );
  });

  it("uses per-mark data and supports dataless marks", () => {
    expect(render({ marks: [{ type: "frame" }, { type: "dot", data: [1, 2, 3] }] }).type).toBe(
      "drawn",
    );
  });

  it("accepts nested data when the shared renderer receives no top-level data", () => {
    expect(
      buildInteractivePlotParts({ data: [1, 2], marks: [{ type: "dot" }] }, undefined, document)
        .svg,
    ).toBeTruthy();
  });

  it.each([
    { marks: [] },
    { marks: [{ type: "not-supported" }] },
    { marks: [{ type: "dot", transform: { name: "not-supported" } }], data: [1] },
    { marks: [{ type: "barY", options: { x: "missing", y: "y" } }], data: [{ y: 1 }] },
    { marks: [{ type: "dot" }], data: [] },
    { marks: [null] },
  ])("reports invalid/empty specifications locally: %j", (spec) => {
    expect(render(spec as PlotSpec).type).toBe("failed");
    expect(document.querySelector("#chart")?.childElementCount).toBe(0);
  });

  it("treats message markup as text and strips script links", () => {
    const title = '<img src=x onerror="window.pwned=true">';
    expect(
      render({ title, marks: [{ type: "dot", options: { href: "javascript:alert(1)" } }] }, [1, 2])
        .type,
    ).toBe("drawn");
    expect(document.querySelector(".title")?.textContent).toBe(title);
    expect(document.querySelector("img,script,a[href^='javascript:']")).toBeNull();
  });

  it("keeps one plot across repeated boot and orientation changes", () => {
    const spec = { marks: [{ type: "dot" }] };
    render(spec, [1, 2]);
    render(spec, [1, 2]);
    expect(postMessage).toHaveBeenCalledTimes(1);
    Object.defineProperty(document.documentElement, "clientWidth", {
      configurable: true,
      value: 640,
    });
    window.dispatchEvent(new Event("resize"));
    expect(document.querySelectorAll("#chart svg")).toHaveLength(1);
    expect(document.querySelector("#chart svg")?.getAttribute("width")).toBe("640");
    expect(postMessage).toHaveBeenCalledTimes(2);
  });
});

it("parses quoted CSV and TSV with typing without dynamic code generation", () => {
  const blocked = vi.spyOn(globalThis, "Function").mockImplementation(() => {
    throw new Error("unsafe-eval blocked");
  });
  try {
    const csv = parsePlotData(
      "data.csv",
      'label,value,date\n"a,b",2,2024-01-05\n"two\nlines",3,2024-02-05',
    );
    expect(csv).toEqual([
      { label: "a,b", value: 2, date: new Date("2024-01-05") },
      { label: "two\nlines", value: 3, date: new Date("2024-02-05") },
    ]);
    expect(parsePlotData("data.tsv", "x\ty\n1\t2")).toEqual([{ x: 1, y: 2 }]);
    expect(blocked).not.toHaveBeenCalled();
  } finally {
    blocked.mockRestore();
  }
});
