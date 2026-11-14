import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-localization", () => ({
  getLocales: vi.fn(() => [{ languageTag: "en-US" }]),
}));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

vi.mock("./ui-direction", () => ({
  applyMobileUiDirection: vi.fn(),
}));

/** Recursively collect source files used to validate mobile translation coverage. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

/** Parse source syntax rather than depending on the quote style chosen by authors. */
function literalTranslationIds(source: string): string[] {
  const ids: string[] = [];
  const tree = ts.createSourceFile(
    "source.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const translates =
        (ts.isIdentifier(callee) && callee.text === "t") ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === "t");
      const message = node.arguments[0];
      if (translates && message && ts.isStringLiteralLike(message)) ids.push(message.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return ids;
}

it("extracts every literal syntax without treating comments or dynamic messages as IDs", () => {
  const source = [
    `t('Delete "{name}"?')`,
    't("Double quoted")',
    "t(`Template literal`)",
    String.raw`t('Escaped \'quote\'')`,
    'i18n.t("Property call")',
    '// t("Comment")',
    "t(dynamicMessage)",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Parse dynamic source without evaluating it.
    "t(`Dynamic ${name}`)",
  ].join("\n");
  expect(literalTranslationIds(source)).toEqual([
    'Delete "{name}"?',
    "Double quoted",
    "Template literal",
    "Escaped 'quote'",
    "Property call",
  ]);
});

it.each(["ko", "tr", "hi", "pt-BR", "es", "fr"] as const)(
  "translates the artifact deletion confirmation in %s, including the quoted name",
  async (locale) => {
    const { resetI18nForTests, t } = await import("./i18n");
    resetI18nForTests(locale);
    const title = t('Delete "{name}"?', { name: "Synthetic" });
    expect(title).not.toBe('Delete "Synthetic"?');
    expect(title).toContain("Synthetic");
    expect(title).not.toContain("{name}");
  },
);

describe("mobile i18n", () => {
  beforeEach(async () => {
    vi.resetModules();
    const { getItemAsync, setItemAsync } = await import("expo-secure-store");
    vi.mocked(getItemAsync).mockReset();
    vi.mocked(setItemAsync).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to the English source message when a translation is missing", async () => {
    const { resetI18nForTests, t } = await import("./i18n");
    resetI18nForTests("zh-CN");
    expect(t("Not a real string")).toBe("Not a real string");
  });

  it("translates seeded Chinese chrome and keeps interpolations", async () => {
    const { resetI18nForTests, t } = await import("./i18n");
    resetI18nForTests("zh-CN");
    expect(t("Account")).toBe("账户");
    expect(t("Sign in to CogineBot")).toBe("登录 CogineBot");
    expect(t("New bot")).toBe("新建 Bot");
    expect(t("{runs} runs · {tokens} tokens", { runs: 3, tokens: 12 })).toBe(
      "3 次运行 · 12 个 token",
    );
    expect(t("Delete {name}?", { name: "Scout" })).toBe("要删除 Scout 吗？");

    resetI18nForTests("ru");
    expect(t("Account")).toBe("Аккаунт");
    expect(t("Sign in to CogineBot")).toBe("Войти в CogineBot");
    expect(t("New bot")).toBe("Новый бот");
    expect(t("{runs} runs · {tokens} tokens", { runs: 3, tokens: 12 })).toBe(
      "Запусков: 3 · токенов: 12",
    );
    expect(t("Delete {name}?", { name: "Scout" })).toBe("Удалить Scout?");

    resetI18nForTests("de");
    expect(t("Account")).toBe("Konto");
    expect(t("Sign in to CogineBot")).toBe("Bei CogineBot anmelden");
    expect(t("New bot")).toBe("Neuer Bot");
    expect(t("{runs} runs · {tokens} tokens", { runs: 3, tokens: 12 })).toBe(
      "3 Ausführungen · 12 Token",
    );
    expect(t("Delete {name}?", { name: "Scout" })).toBe("Scout löschen?");
  });

  it("preserves interpolations in every non-English catalog", async () => {
    for (const messages of Object.values((await import("./i18n")).catalogs).filter(
      (catalog) => Object.keys(catalog).length > 0,
    )) {
      const empty = Object.entries(messages).filter(([, value]) => !value.trim());
      const interpolationMismatches = Object.entries(messages).filter(([id, value]) => {
        const tokens = (message: string) =>
          [...message.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort();
        return JSON.stringify(tokens(id)) !== JSON.stringify(tokens(value));
      });
      expect(empty).toEqual([]);
      expect(interpolationMismatches).toEqual([]);
    }
  });

  it.each(["zh-CN", "ru", "de", "ko", "tr", "hi", "pt-BR", "es", "fr"] as const)(
    "localizes model policy recovery in %s",
    async (locale) => {
      const { normalizeRunError } = await import("@rakazo/core");
      const { resetI18nForTests, t } = await import("./i18n");
      resetI18nForTests(locale);
      const result = normalizeRunError("platform_model_forbidden", t, locale);
      expect(result.action).toBe("add_key");
      expect(result.summary).not.toBe("Add your own API key to continue.");
      expect(result.details).toBe("platform_model_forbidden");
      expect(t("Add API key")).not.toBe("Add API key");
    },
  );

  it.each(["zh-CN", "ru", "de", "ko", "tr", "hi", "pt-BR", "es", "fr"] as const)(
    "localizes capacity failures in %s without adding a recovery action",
    async (locale) => {
      const {
        MODEL_CONTEXT_TOO_SMALL_ERROR,
        VERBATIM_TOOL_RESULT_TOO_LARGE_ERROR,
        normalizeRunError,
      } = await import("@rakazo/core");
      const { resetI18nForTests, t } = await import("./i18n");
      resetI18nForTests(locale);
      for (const details of [MODEL_CONTEXT_TOO_SMALL_ERROR, VERBATIM_TOOL_RESULT_TOO_LARGE_ERROR]) {
        const failure = normalizeRunError(details, t, locale);
        expect(failure.summary).not.toBe(details);
        expect(failure.details).toBe(details);
        expect(failure).not.toHaveProperty("action");
      }
    },
  );

  it("localizes shared provider recovery advice without exposing its diagnostics", async () => {
    const { normalizeRunError, RUN_ERROR_LIMIT_MESSAGES } = await import("@rakazo/core");
    const { resetI18nForTests, t } = await import("./i18n");
    for (const messages of Object.values((await import("./i18n")).catalogs).filter(
      (catalog) => Object.keys(catalog).length > 0,
    )) {
      for (const periods of Object.values(RUN_ERROR_LIMIT_MESSAGES)) {
        for (const message of Object.values(periods))
          expect(messages[message]?.trim()).toBeTruthy();
      }
    }
    for (const locale of ["zh-CN", "ru", "de", "ko", "tr", "hi", "pt-BR", "es", "fr"] as const) {
      resetI18nForTests(locale);
      const raw =
        '429: {"error":{"message":"OpenAI key reached its daily limit; resets at 2026-01-02T00:00:00Z","metadata":{"token":"synthetic-private-token"}}}';
      const localized = normalizeRunError(raw, t, locale);
      expect(localized.summary).not.toBe(normalizeRunError(raw).summary);
      expect(localized.summary).not.toMatch(/\{(?:provider|summary|date)\}/);
      expect(localized.details).not.toContain("synthetic-private-token");
      expect(localized.summary).toContain("OpenAI");
    }
  });

  it("covers MCP fields and dynamic recovery messages in all nine translated catalogs", async () => {
    const { catalogs } = await import("./i18n");
    const ids = [
      "Cancel creation",
      "Created server is no longer available. Review the draft.",
      "Disconnect OAuth before authorizing from another app.",
      "Access token (optional)",
      "Add server",
      "Arguments",
      "Authorization cancelled.",
      "Authorization expired. Try again.",
      "Authorization failed. Try again.",
      "Check status before retrying this server.",
      "Check the server fields.",
      "Command",
      "Connect OAuth",
      "Could not update MCP server. Check status and retry.",
      "Reconnect OAuth",
      "Remove MCP server?",
      "Runs on the connected instance.",
      "Server name",
      "This server did not request browser authorization.",
      "This server is already connected. Disconnect it first to authorize again.",
      "Transport",
    ];
    const translated = Object.values(catalogs).filter((catalog) => Object.keys(catalog).length > 0);
    expect(translated).toHaveLength(9);
    for (const messages of translated)
      for (const id of ids) expect(messages[id]?.trim(), id).toBeTruthy();
  });

  it("translates every mobile chrome t() id in every non-English catalog", async () => {
    const { EMPTY_PLUGIN_CATALOG_MESSAGE, SLASH_ACTIONS } = await import("@rakazo/core");
    const { AI_DATA_DISCLOSURES, OPENAI_COMPATIBLE_BASE_URL_HINT } = await import(
      "@rakazo/contracts"
    );
    const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const ids = new Set<string>([
      ...Object.values(AI_DATA_DISCLOSURES),
      EMPTY_PLUGIN_CATALOG_MESSAGE,
      OPENAI_COMPATIBLE_BASE_URL_HINT,
      ...SLASH_ACTIONS.map((action) => action.label),
      "Sign-in did not return a session",
      "Sign-up did not return a session",
      "{count} model",
      "{count} models",
      // Labels the t() literal scan cannot see: built from maps or ternaries.
      "System",
      "Light",
      "Dark",
      "Allow once",
      "Always allow",
      "Deny",
    ]);
    for (const file of collectSourceFiles(mobileRoot)) {
      const source = readFileSync(file, "utf8");
      for (const id of literalTranslationIds(source)) ids.add(id);
    }
    for (const messages of Object.values((await import("./i18n")).catalogs).filter(
      (catalog) => Object.keys(catalog).length > 0,
    )) {
      const missing = [...ids].filter((id) => !messages[id]?.trim()).sort();
      expect(missing).toEqual([]);
    }
  });

  it("prefers the stored locale, then activates and persists a new choice", async () => {
    const { getItemAsync, setItemAsync } = await import("expo-secure-store");
    vi.mocked(getItemAsync).mockResolvedValue("zh-CN");
    const { applyMobileUiDirection } = await import("./ui-direction");
    const { bootstrapI18n, getActiveUiLocale, setUiLocale, t } = await import("./i18n");

    await expect(bootstrapI18n()).resolves.toBe("zh-CN");
    expect(getActiveUiLocale()).toBe("zh-CN");
    expect(t("Language")).toBe("语言");
    expect(applyMobileUiDirection).toHaveBeenCalledWith("zh-CN");

    await setUiLocale("en");
    expect(getActiveUiLocale()).toBe("en");
    expect(t("Language")).toBe("Language");
    expect(setItemAsync).toHaveBeenCalledWith("rakazo.uiLocale", "en");
    expect(applyMobileUiDirection).toHaveBeenCalledWith("en");
  });

  it("normalizes a regional Russian stored locale before activation", async () => {
    const { getItemAsync } = await import("expo-secure-store");
    vi.mocked(getItemAsync).mockResolvedValue("ru-RU");
    const { bootstrapI18n, dateLocaleForUi, getActiveUiLocale, t } = await import("./i18n");

    await expect(bootstrapI18n()).resolves.toBe("ru");
    expect(getActiveUiLocale()).toBe("ru");
    expect(t("Language")).toBe("Язык");
    expect(dateLocaleForUi()).toBe("ru");
  });

  it("normalizes a regional German stored locale before activation", async () => {
    const { getItemAsync } = await import("expo-secure-store");
    vi.mocked(getItemAsync).mockResolvedValue("de-CH");
    const { bootstrapI18n, dateLocaleForUi, getActiveUiLocale, t } = await import("./i18n");

    await expect(bootstrapI18n()).resolves.toBe("de");
    expect(getActiveUiLocale()).toBe("de");
    expect(t("Language")).toBe("Sprache");
    expect(dateLocaleForUi()).toBe("de");
  });

  it("keeps the last locale when rapid setUiLocale calls finish out of order", async () => {
    const { setItemAsync } = await import("expo-secure-store");
    const { applyMobileUiDirection } = await import("./ui-direction");
    const { getActiveUiLocale, resetI18nForTests, setUiLocale } = await import("./i18n");
    resetI18nForTests("en");

    const gates = new Map<string, { release: () => void; wait: Promise<void> }>();
    for (const locale of ["en", "zh-CN", "ru", "de"] as const) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      gates.set(locale, { release, wait });
    }
    vi.mocked(setItemAsync).mockImplementation(async (_key, value) => {
      await gates.get(String(value))?.wait;
    });

    const first = setUiLocale("en");
    const second = setUiLocale("zh-CN");
    // First write is slower to settle; second must still win after the queue drains.
    queueMicrotask(() => gates.get("zh-CN")?.release());
    queueMicrotask(() => gates.get("en")?.release());
    await Promise.all([first, second]);

    expect(getActiveUiLocale()).toBe("zh-CN");
    expect(setItemAsync).toHaveBeenLastCalledWith("rakazo.uiLocale", "zh-CN");
    expect(applyMobileUiDirection).toHaveBeenLastCalledWith("zh-CN");
  });
});

describe("ten-language mobile parity", () => {
  const locales = ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru", "fr"] as const;

  it.each(locales)(
    "switches to %s, notifies subscribers, and restores after a fresh bootstrap",
    async (locale) => {
      vi.resetModules();
      vi.stubEnv("EXPO_PUBLIC_DEFAULT_UI_LOCALE", "en");
      const store = new Map<string, string>();
      const secureStore = await import("expo-secure-store");
      vi.mocked(secureStore.getItemAsync).mockImplementation(async (key) => store.get(key) ?? null);
      vi.mocked(secureStore.setItemAsync).mockImplementation(async (key, value) => {
        store.set(key, value);
      });
      const device = await import("expo-localization");
      vi.mocked(device.getLocales).mockReturnValue([
        { languageTag: "zh-Hant-TW" },
      ] as unknown as ReturnType<typeof device.getLocales>);
      const runtime = await import("./i18n");
      const changed = vi.fn();
      const unsubscribe = runtime.subscribeI18n(changed);
      await runtime.setUiLocale(locale);
      expect(changed).toHaveBeenCalled();
      expect(runtime.getActiveUiLocale()).toBe(locale);
      expect(store.get("rakazo.uiLocale")).toBe(locale);
      const messages = [
        "No messages yet",
        "New bot",
        "Create routine",
        "No files",
        "Language",
        "Delete your account?",
        "Could not change language",
        "Could not load routines",
      ];
      const labels = messages.map((message) => runtime.t(message));
      if (locale !== "en")
        for (const [index, label] of labels.entries()) expect(label).not.toBe(messages[index]);
      expect(runtime.t("Delete {name}?", { name: "Synthetic Bot" })).toContain("Synthetic Bot");
      expect(runtime.t("Uncatalogued error {code}", { code: 503 })).toBe("Uncatalogued error 503");
      unsubscribe();

      // Discard module state as a process restart would; retain only the native-storage substitute.
      vi.resetModules();
      const restarted = await import("./i18n");
      await expect(restarted.bootstrapI18n()).resolves.toBe(locale);
      expect(restarted.getUiLocalePreference()).toBe(locale);
      expect(messages.map((message) => restarted.t(message))).toEqual(labels);
      const { formatThreadTime } = await import("./inbox");
      const date = new Date(2026, 10, 3, 12);
      const now = new Date(2026, 10, 14, 12);
      const expectedLocale = locale === "en" ? "en-US" : locale;
      expect(restarted.dateLocaleForUi()).toBe(expectedLocale);
      expect(formatThreadTime(date.toISOString(), now)).toBe(
        date.toLocaleDateString(expectedLocale, { month: "short", day: "numeric" }),
      );
      vi.unstubAllEnvs();
      vi.mocked(device.getLocales).mockReturnValue([
        { languageTag: "en-US" },
      ] as unknown as ReturnType<typeof device.getLocales>);
    },
  );

  it("enumerates every intentionally unchanged message, with no hidden English catalog entries", async () => {
    const { catalogs } = await import("./i18n");
    const unchanged = JSON.parse(
      readFileSync(new URL("./locales/unchanged-messages.json", import.meta.url), "utf8"),
    ) as Record<string, string[]>;
    expect(Object.keys(catalogs).sort()).toEqual([...locales].sort());
    for (const locale of locales.filter((value) => value !== "en")) {
      expect(
        Object.entries(catalogs[locale])
          .filter(([key, value]) => key === value)
          .map(([key]) => key)
          .sort(),
      ).toEqual(unchanged[locale]);
    }
  });

  it.each(["zh-TW", "zh-HK", "zh-Hant-TW", "ja-JP", "unknown"])(
    "boots device %s in English without inventing a language preference",
    async (tag) => {
      vi.resetModules();
      vi.stubEnv("EXPO_PUBLIC_DEFAULT_UI_LOCALE", "");
      const secureStore = await import("expo-secure-store");
      vi.mocked(secureStore.getItemAsync).mockResolvedValue(null);
      const device = await import("expo-localization");
      vi.mocked(device.getLocales).mockReturnValue([{ languageTag: tag }] as unknown as ReturnType<
        typeof device.getLocales
      >);
      const runtime = await import("./i18n");
      await expect(runtime.bootstrapI18n()).resolves.toBe("en");
      expect(runtime.getUiLocalePreference()).toBeUndefined();
      expect(runtime.getDeviceSpeechLocale()).toBe(tag);
      vi.unstubAllEnvs();
      vi.mocked(device.getLocales).mockReturnValue([
        { languageTag: "en-US" },
      ] as unknown as ReturnType<typeof device.getLocales>);
    },
  );
});
