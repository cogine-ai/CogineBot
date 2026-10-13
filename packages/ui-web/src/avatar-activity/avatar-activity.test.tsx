// @vitest-environment jsdom
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityFrame } from "./official-source.js";

const runtime = vi.hoisted(() => ({
  created: 0,
  destroyed: 0,
  publishers: [] as Array<(frame: ActivityFrame) => void>,
}));

vi.mock("./official-source.js", () => ({
  async createOfficialSource(_identity: string, publish: (frame: ActivityFrame) => void) {
    runtime.created++;
    runtime.publishers.push(publish);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 100 100");
    svg.innerHTML =
      '<defs><clipPath id="body"><path d="M0 0" /></clipPath></defs><g clip-path="url(#body)"><path d="M1 1" /></g>';
    return {
      getFrame: () => ({ svg, visual: "working", tinyTransform: "rotate(22deg)" }),
      destroy() {
        runtime.destroyed++;
      },
    };
  },
}));

import { AvatarActivity } from "./avatar-activity.js";

describe("working avatar lifecycle", () => {
  let root: Root;
  let host: HTMLDivElement;
  let preference: EventTarget & { matches: boolean };
  const observed = new Map<Element, (entries: Array<{ isIntersecting: boolean }>) => void>();

  beforeEach(() => {
    runtime.created = 0;
    runtime.destroyed = 0;
    runtime.publishers = [];
    observed.clear();
    preference = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => preference),
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private element?: Element;
        constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
        observe(element: Element) {
          this.element = element;
          observed.set(element, this.callback);
          this.callback([{ isIntersecting: true }]);
        }
        disconnect() {
          if (this.element) observed.delete(this.element);
        }
      },
    );
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const avatar = (size = 38) => (
    <AvatarActivity identity="companion-a" color="coral" size={size}>
      <svg data-static="true" />
    </AvatarActivity>
  );

  it("syncs late-mounted views without sharing SVG IDs", async () => {
    await act(async () => root.render(<div>{avatar()}</div>));
    await act(async () =>
      root.render(
        <div>
          {avatar()}
          {avatar(26)}
        </div>,
      ),
    );
    expect(runtime.created).toBe(1);
    const views = host.querySelectorAll(".avatar-activity-motion > svg");
    expect(views).toHaveLength(2);
    const ids = Array.from(views, (view) => view.querySelector("clipPath")?.id);
    expect(new Set(ids).size).toBe(2);
    for (const view of views) {
      expect(view.querySelector("g")?.getAttribute("clip-path")).toBe(
        `url(#${view.querySelector("clipPath")?.id})`,
      );
    }
  });

  it("keeps effect paint tied to identity across phases without changing geometry or eye ink", async () => {
    await act(async () => root.render(avatar()));
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.innerHTML =
      '<defs><linearGradient id="trail"><stop offset="0" stop-color="hsl(247 56% 56%)" stop-opacity="0.4" /><stop offset="1" stop-color="#f9705c" /></linearGradient></defs><path data-trail="" d="M1 2L3 4" fill="url(#trail)" opacity="0.6" /><circle cx="5" cy="6" r="2" fill="#f4c34e" opacity="0.7" /><path class="official-avatar-eye" d="M7 8" style="fill: var(--bg)" />';
    for (const visual of ["working", "thinking", "spawning"] as const) {
      await act(async () => runtime.publishers[0]!({ svg, visual, tinyTransform: "" }));
      const view = host.querySelector(".avatar-activity-motion")!;
      expect(view.getAttribute("data-visual")).toBe(visual);
      for (const stop of view.querySelectorAll("stop")) {
        expect(stop.getAttribute("stop-color")).toBe("var(--avatar-activity-color)");
      }
      expect(view.querySelector("stop")?.getAttribute("stop-opacity")).toBe("0.4");
      expect(view.querySelector("circle")?.getAttribute("fill")).toBe(
        "var(--avatar-activity-color)",
      );
      expect(view.querySelector("circle")?.getAttribute("opacity")).toBe("0.7");
      const trail = view.querySelector("[data-trail]")!;
      expect(trail.getAttribute("d")).toBe("M1 2L3 4");
      expect(trail.getAttribute("opacity")).toBe("0.6");
      expect(trail.getAttribute("fill")).toBe(`url(#${view.querySelector("linearGradient")!.id})`);
      expect(view.querySelector(".official-avatar-eye")?.getAttribute("style")).toBe(
        "fill: var(--bg)",
      );
    }
    await act(async () =>
      root.render(
        <AvatarActivity identity="companion-a" color="#62A8EC" size={38}>
          <svg data-static="true" />
        </AvatarActivity>,
      ),
    );
    expect(runtime.created).toBe(1);
    expect(
      (host.querySelector(".avatar-activity") as HTMLElement).style.getPropertyValue(
        "--avatar-activity-color",
      ),
    ).toBe("#62A8EC");
    // The reusable upstream frame is untouched; each view applies its own identity paint.
    expect(svg.querySelector("stop")?.getAttribute("stop-color")).toBe("hsl(247 56% 56%)");
  });

  it("destroys the last source while hidden or reduced-motion and restarts on return", async () => {
    await act(async () => root.render(avatar()));
    expect(runtime.created).toBe(1);
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(runtime.destroyed).toBe(1);
    expect(host.querySelector(".avatar-activity")?.getAttribute("data-motion")).toBe("static");
    await act(async () => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(runtime.created).toBe(2);
    await act(async () => {
      preference.matches = true;
      preference.dispatchEvent(new Event("change"));
    });
    expect(runtime.destroyed).toBe(2);
  });

  it("leaves tiny group members recognizable and stops their source offscreen", async () => {
    await act(async () => root.render(avatar(17)));
    expect(host.querySelector(".avatar-activity-static")?.getAttribute("style")).toContain(
      "rotate(22deg)",
    );
    expect(host.querySelector(".avatar-activity-motion > svg")).toBeNull();
    await act(async () => {
      for (const callback of observed.values()) callback([{ isIntersecting: false }]);
    });
    expect(runtime.destroyed).toBe(1);
    expect(host.querySelector(".avatar-activity-static")?.getAttribute("style")).not.toContain(
      "rotate",
    );
  });
});
