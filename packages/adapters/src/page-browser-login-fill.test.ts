import { describe, expect, it } from "vitest";
import { installExactPage } from "./page-browser.test-support.js";

describe("live page helper saved-login fill", () => {
  const origin = "https://login.example.test";

  it.each([
    ["text", "username"],
    ["email", "username"],
    ["tel", "username"],
    ["password", "password"],
  ])("fills %s only as the matching %s login field", (type, field) => {
    const { win, exact, bind, close } = installExactPage(`<input id="field" type="${type}">`);
    try {
      const ref = bind("#field");
      const input = win.document.querySelector<HTMLInputElement>("#field")!;
      let events = 0;
      input.addEventListener("input", () => events++);
      input.addEventListener("change", () => events++);
      expect(exact.fill(ref, "synthetic-login", origin, field)).toBe(true);
      expect(input.value).toBe("synthetic-login");
      expect(events).toBe(2);
      expect(exact.holdsLogin(input)).toBe(true);
      expect(exact.describe(ref)).not.toHaveProperty("value");
    } finally {
      close();
    }
  });

  it.each([
    ["password", "username"],
    ["text", "password"],
    ["email", "password"],
    ["search", "username"],
    ["url", "username"],
    ["number", "username"],
  ])("refuses %s for a %s secret without changing the page", (type, field) => {
    const { win, exact, bind, close } = installExactPage(`<input id="field" type="${type}">`);
    try {
      const ref = bind("#field");
      let events = 0;
      win.document.body.addEventListener("input", () => events++);
      expect(() => exact.fill(ref, "must-stay-private", origin, field)).toThrow(/field type/);
      expect(win.document.querySelector<HTMLInputElement>("#field")!.value).toBe("");
      expect(events).toBe(0);
    } finally {
      close();
    }
  });

  it.each(["textarea", "select", 'div contenteditable="true"'])(
    "refuses saved credentials in %s",
    (tag) => {
      const { exact, bind, close } = installExactPage(`<${tag} id="field"></${tag.split(" ")[0]}>`);
      try {
        expect(() => exact.fill(bind("#field"), "private", origin, "username")).toThrow(
          /field type/,
        );
      } finally {
        close();
      }
    },
  );

  it.each(["disabled", "readonly", 'aria-disabled="true"'])(
    "refuses a %s login field",
    (attribute) => {
      const { exact, bind, close } = installExactPage(`<input id="field" ${attribute}>`);
      try {
        expect(() => exact.fill(bind("#field"), "private", origin, "username")).toThrow(/writable/);
      } finally {
        close();
      }
    },
  );

  it.each(["", "card", "pay", "pin", "unknown"])("refuses the unsupported field %s", (field) => {
    const { exact, bind, close } = installExactPage('<input id="field">');
    try {
      expect(() => exact.fill(bind("#field"), "private", origin, field)).toThrow(/Unsupported/);
    } finally {
      close();
    }
  });

  it.each(["http://192.168.2.10:8080", "http://login.example.test"])(
    "refuses a matching insecure origin %s",
    (insecure) => {
      const { win, exact, bind, close } = installExactPage(
        '<input id="field">',
        `${insecure}/signin`,
      );
      try {
        expect(() => exact.fill(bind("#field"), "private", insecure, "username")).toThrow(/secure/);
        expect(win.document.querySelector<HTMLInputElement>("#field")!.value).toBe("");
      } finally {
        close();
      }
    },
  );

  it.each([
    "https://phish.example.test",
    "https://login.example.test:444",
    "https://login.example.test.evil.test",
  ])("refuses another saved origin %s", (saved) => {
    const { exact, bind, close } = installExactPage('<input id="field">');
    try {
      expect(() => exact.fill(bind("#field"), "private", saved, "username")).toThrow(
        /saved login site/,
      );
    } finally {
      close();
    }
  });

  it("hides a short username and a password after the page reveals its input type", () => {
    const { win, exact, bind, close } = installExactPage(
      '<input id="user"><input id="password" type="password">',
    );
    try {
      exact.fill(bind("#user"), "a", origin, "username");
      exact.fill(bind("#password"), "synthetic-password", origin, "password");
      win.document.querySelector<HTMLInputElement>("#password")!.type = "text";
      expect(exact.describe("#user")).not.toHaveProperty("value");
      expect(exact.describe("#password")).not.toHaveProperty("value");
    } finally {
      close();
    }
  });
});
