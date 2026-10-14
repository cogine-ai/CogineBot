import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("active views share geometry after late mounting and history remains static", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/e2e/fixtures/avatar-motion.html");
  await expect(page.getByTestId("sidebar-avatar").locator(".avatar-activity")).toHaveAttribute(
    "data-motion",
    "active",
  );
  await page.getByRole("button", { name: "Toggle late view" }).click();
  await expect(page.getByTestId("late-avatar").locator(".avatar-activity")).toHaveAttribute(
    "data-motion",
    "active",
  );
  const frames = await page
    .locator('[data-avatar-identity="motion-a"] .avatar-activity-motion')
    .evaluateAll((elements) =>
      elements
        .filter((element) => getComputedStyle(element).display !== "none")
        .map((element) => ({
          visual: (element as HTMLElement).dataset.visual,
          paths: [...element.querySelectorAll("path")].map((path) => path.getAttribute("d")),
          transforms: [...element.querySelectorAll("g")].map((group) =>
            group.getAttribute("transform"),
          ),
        })),
    );
  expect(frames.length).toBeGreaterThanOrEqual(3);
  for (const frame of frames) expect(frame).toEqual(frames[0]);
  await expect(page.getByTestId("history-avatar").locator(".avatar-activity")).toHaveCount(0);
  await expect(page.getByTestId("tiny-group").locator(".avatar-activity-motion svg")).toHaveCount(
    0,
  );
  await expect(page.getByTestId("tiny-group").locator(".rakazo-gaze-avatar")).toHaveCount(3);
  const ids = await page
    .locator('[id^="_r_"]')
    .evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(ids).size).toBe(ids.length);
  await page.getByRole("button", { name: "Change color" }).click();
  const colors = await page
    .locator('[data-avatar-identity="motion-a"] .avatar-activity')
    .evaluateAll((elements) =>
      elements.map((element) =>
        getComputedStyle(element).getPropertyValue("--avatar-activity-color").trim(),
      ),
    );
  expect(colors.length).toBeGreaterThanOrEqual(4);
  expect(new Set(colors)).toEqual(new Set(["#F5A15D"]));
  await captureScreenshot(page, testInfo, "companion-activity");
  await page.getByRole("button", { name: "Toggle activity" }).click();
  await expect(page.locator(".avatar-activity")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("reduced motion renders static identity without loading the motion runtime", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const runtimeRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("vendor/official-avatar-runtime"))
      runtimeRequests.push(request.url());
  });
  await page.goto("/e2e/fixtures/avatar-motion.html");
  await expect(page.getByTestId("sidebar-avatar").locator(".avatar-activity")).toHaveAttribute(
    "data-motion",
    "static",
  );
  const snapshot = () =>
    page
      .getByTestId("sidebar-avatar")
      .locator(".rakazo-gaze-avatar")
      .evaluate((element) => element.outerHTML);
  const first = await snapshot();
  await page.waitForTimeout(200);
  expect(await snapshot()).toBe(first);
  expect(runtimeRequests).toEqual([]);
});

test("generated activity trails preserve companion color when it changes", async ({ page }) => {
  await page.goto("/e2e/fixtures/avatar-motion.html");
  const effects = page.getByTestId("large-avatar").locator(".avatar-activity-motion");
  // The unchanged official scheduler introduces trails during a working phase.
  await expect.poll(() => effects.locator("stop").count(), { timeout: 25_000 }).toBeGreaterThan(0);
  const effectPaint = () =>
    effects.evaluate((element) => ({
      stops: [...element.querySelectorAll("stop")].map((stop) => getComputedStyle(stop).stopColor),
      particles: [...element.querySelectorAll("circle[fill], rect[fill]")]
        .filter((particle) => particle.getAttribute("fill") !== "none")
        .map((particle) => getComputedStyle(particle).fill),
      eyes: [...element.querySelectorAll(".official-avatar-eye")].map(
        (eye) => getComputedStyle(eye).fill,
      ),
    }));
  const first = await effectPaint();
  expect(new Set(first.stops)).toEqual(new Set(["rgb(98, 168, 236)"]));
  for (const color of first.particles) expect(color).toBe("rgb(98, 168, 236)");
  expect(new Set(first.eyes)).toEqual(new Set(["rgb(24, 37, 45)"]));
  await page.getByRole("button", { name: "Change color" }).click();
  await expect
    .poll(async () => {
      const { stops } = await effectPaint();
      return stops.length > 0 && stops.every((color) => color === "rgb(245, 161, 93)");
    })
    .toBe(true);
  expect(new Set((await effectPaint()).eyes)).toEqual(new Set(["rgb(24, 37, 45)"]));
});

test("motion destroys RAF on idle, hidden, and reduced-motion transitions", async ({ page }) => {
  await page.addInitScript(() => {
    const pending = new Set<number>();
    const request = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      const id = request((time) => {
        pending.delete(id);
        callback(time);
      });
      pending.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      pending.delete(id);
      cancel(id);
    };
    Object.defineProperty(window, "avatarPendingFrames", { get: () => pending.size });
  });
  await page.goto("/e2e/fixtures/avatar-motion.html");
  const active = page.getByTestId("sidebar-avatar").locator(".avatar-activity");
  await expect(active).toHaveAttribute("data-motion", "active");
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "avatarPendingFrames")))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(active).toHaveAttribute("data-motion", "static");
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "avatarPendingFrames"))).toBe(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(active).toHaveAttribute("data-motion", "active");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(active).toHaveAttribute("data-motion", "static");
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "avatarPendingFrames"))).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(active).toHaveAttribute("data-motion", "active");
  await page.getByRole("button", { name: "Toggle activity" }).click();
  await expect(page.locator(".avatar-activity")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Reflect.get(window, "avatarPendingFrames"))).toBe(0);
});

test("uploaded portraits remain still and ring-free while another companion is active", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/e2e/fixtures/avatar-motion.html");
  await expect(page.getByTestId("sidebar-avatar").locator(".avatar-activity")).toHaveAttribute(
    "data-motion",
    "active",
  );
  const working = page.getByTestId("working-photo").locator(".rakazo-bot-avatar");
  const idle = page.getByTestId("idle-photo").locator(".rakazo-bot-avatar");
  await expect(working).toHaveAttribute("data-working", "true");
  await expect(idle).toHaveAttribute("data-working", "false");
  for (const photo of [working, idle]) {
    const image = photo.locator("img");
    await expect(image).toBeVisible();
    await expect(photo.locator(".avatar-activity, .rakazo-bot-avatar-ring")).toHaveCount(0);
    await expect(image).toHaveCSS("animation-name", "none");
    await expect(image).toHaveCSS("transform", "none");
    await expect(photo).toHaveCSS("box-shadow", "none");
    await expect(image).toHaveCSS("width", "38px");
    await expect(image).toHaveCSS("height", "38px");
    expect(
      await image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    ).toBeGreaterThan(0);
  }
  await page.waitForTimeout(300);
  await expect(working.locator("img")).toHaveCSS("transform", "none");
  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(working.locator("img")).toHaveCSS("animation-name", "none");
  await captureScreenshot(page, testInfo, "companion-activity-static-portraits");
  await page.getByRole("button", { name: "Toggle activity" }).click();
  await expect(working).toHaveAttribute("data-working", "false");
  await expect(working.locator(".avatar-activity, .rakazo-bot-avatar-ring")).toHaveCount(0);
});
