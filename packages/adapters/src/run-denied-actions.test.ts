import { SHARED_PAGE_UPDATE_REQUEST_KIND } from "@rakazo/contracts";
import { expect, it } from "vitest";
import {
  loadDeniedActionTargets,
  pageDenialTarget,
  repeatsDeniedAction,
} from "./run-denied-actions.js";

it("holds a shared Page refusal to the same Page", async () => {
  const denied = await loadDeniedActionTargets(
    [
      {
        kind: "save_page",
        result: null,
        request: {
          requestKind: SHARED_PAGE_UPDATE_REQUEST_KIND,
          args: { pageId: "page-a", source: "Updated content" },
          page: {
            id: "page-a",
            version: 1,
            generation: "a".repeat(64),
            candidateDigest: "b".repeat(64),
            title: "Original",
          },
          detail: "Updated content",
        },
      },
    ],
    async () => undefined,
  );
  const save = { toolName: "save_page", aliases: [] };
  expect(repeatsDeniedAction({ ...save, page: pageDenialTarget("write", "page-a") }, denied)).toBe(
    true,
  );
  expect(repeatsDeniedAction({ ...save, page: pageDenialTarget("write", "page-b") }, denied)).toBe(
    false,
  );
  expect(repeatsDeniedAction(save, denied)).toBe(false);
});

it("prevents Shell from replacing a refused file operation without fencing provider code", async () => {
  const denied = await loadDeniedActionTargets(
    [{ kind: "read_file", request: { path: "fixture.txt" }, result: null }],
    async () => undefined,
  );
  expect(repeatsDeniedAction({ toolName: "shell", opaqueCode: "shell", aliases: [] }, denied)).toBe(
    true,
  );
  expect(
    repeatsDeniedAction(
      {
        toolName: "COMPOSIO_REMOTE_WORKBENCH",
        opaqueCode: "connector",
        aliases: [],
      },
      denied,
    ),
  ).toBe(false);
});

it.each([
  { mode: "read", request: { pageId: "page-a" } },
  { mode: "write", request: { pageId: "page-a", source: "Proposed replacement" } },
] as const)(
  "matches an ordinary Page refusal by both $mode mode and Page",
  async ({ mode, request }) => {
    const denied = await loadDeniedActionTargets(
      [{ kind: "save_page", result: null, request }],
      async () => undefined,
    );
    const save = { toolName: "save_page", aliases: [] };
    expect(repeatsDeniedAction({ ...save, page: pageDenialTarget(mode, "page-a") }, denied)).toBe(
      true,
    );
    expect(repeatsDeniedAction({ ...save, page: pageDenialTarget(mode, "page-b") }, denied)).toBe(
      false,
    );
    const otherMode = mode === "write" ? "read" : "write";
    expect(
      repeatsDeniedAction({ ...save, page: pageDenialTarget(otherMode, "page-a") }, denied),
    ).toBe(false);
  },
);

it("ignores a Page ID in help mode because help has no Page target", async () => {
  const denied = await loadDeniedActionTargets(
    [{ kind: "save_page", result: null, request: { help: true } }],
    async () => undefined,
  );
  expect(
    repeatsDeniedAction(
      { toolName: "save_page", aliases: [], page: pageDenialTarget("help", "page-a") },
      denied,
    ),
  ).toBe(true);
});

it("does not borrow a raw legacy denial from a longer MCP namespace", async () => {
  const denied = await loadDeniedActionTargets(
    [{ kind: "mcp__mail__work__GMAIL_SEND_EMAIL", result: null, request: {} }],
    async () => undefined,
  );
  expect(
    repeatsDeniedAction(
      {
        toolName: "mcp__mail__COMPOSIO_MULTI_EXECUTE_TOOL",
        aliases: [],
        legacyBatchPrefix: "mcp__mail__",
        batch: { complete: true, actions: ["work__GMAIL_SEND_EMAIL"] },
      },
      denied,
    ),
  ).toBe(false);
});
