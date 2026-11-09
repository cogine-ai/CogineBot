import { SHARED_PAGE_UPDATE_REQUEST_KIND } from "@rakazo/contracts";
import { expect, it } from "vitest";
import { loadDeniedActionTargets, repeatsDeniedAction } from "./run-denied-actions.js";

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
  expect(repeatsDeniedAction({ ...save, pageId: "page-a" }, denied)).toBe(true);
  expect(repeatsDeniedAction({ ...save, pageId: "page-b" }, denied)).toBe(false);
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
