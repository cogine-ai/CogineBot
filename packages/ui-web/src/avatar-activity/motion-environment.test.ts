import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { motionEnvironmentEnabled, subscribeMotionEnvironment } from "./motion-environment.js";

describe("avatar motion environment", () => {
  let browser: EventTarget & { matchMedia: ReturnType<typeof vi.fn> };
  let page: EventTarget & { visibilityState: string };
  let preference: EventTarget & { matches: boolean };

  beforeEach(() => {
    preference = Object.assign(new EventTarget(), { matches: false });
    browser = Object.assign(new EventTarget(), { matchMedia: vi.fn(() => preference) });
    page = Object.assign(new EventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("window", browser);
    vi.stubGlobal("document", page);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("suspends hidden pages and reduced-motion without conflating them with bot state", () => {
    const listener = vi.fn();
    const detach = subscribeMotionEnvironment(listener);
    expect(motionEnvironmentEnabled()).toBe(true);
    page.visibilityState = "hidden";
    page.dispatchEvent(new Event("visibilitychange"));
    expect(motionEnvironmentEnabled()).toBe(false);
    page.visibilityState = "visible";
    preference.matches = true;
    preference.dispatchEvent(new Event("change"));
    expect(motionEnvironmentEnabled()).toBe(false);
    preference.matches = false;
    preference.dispatchEvent(new Event("change"));
    expect(motionEnvironmentEnabled()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(3);
    detach();
  });

  it("stops on pagehide and resumes on pageshow for restored pages", () => {
    const listener = vi.fn();
    const detach = subscribeMotionEnvironment(listener);
    browser.dispatchEvent(new Event("pagehide"));
    expect(motionEnvironmentEnabled()).toBe(false);
    browser.dispatchEvent(new Event("pageshow"));
    expect(motionEnvironmentEnabled()).toBe(true);
    detach();
  });

  it("shares listeners and removes all page/media subscriptions after the final avatar", () => {
    const first = vi.fn();
    const second = vi.fn();
    const removeFirst = subscribeMotionEnvironment(first);
    const removeSecond = subscribeMotionEnvironment(second);
    expect(browser.matchMedia).toHaveBeenCalledTimes(1);
    removeFirst();
    page.dispatchEvent(new Event("visibilitychange"));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
    removeSecond();
    page.dispatchEvent(new Event("visibilitychange"));
    preference.dispatchEvent(new Event("change"));
    browser.dispatchEvent(new Event("pagehide"));
    expect(second).toHaveBeenCalledTimes(1);
  });
});
