import assert from "node:assert/strict";
import { it as test } from "vitest";
import { NativeHttpClient } from "../http.js";

for (const status of [410, 403, 404])
  test(`real NativeHttpClient distinguishes ${status} without leaking remote body`, async () => {
    let calls = 0;
    const client = new NativeHttpClient(
      "https://www.googleapis.com/calendar/v3",
      async () => ({ kind: "bearer", value: "synthetic-access" }),
      {
        readOnly: true,
        signal: new AbortController().signal,
        network: {
          resolveHostname: async () => [{ address: "203.0.113.10", family: 4 }],
          fetch: async () => {
            calls++;
            return new Response(
              JSON.stringify({
                error: { message: "PRIVATE-UPSTREAM-CONTENT", access_token: "synthetic-private" },
              }),
              { status },
            );
          },
        },
      },
    );
    try {
      await assert.rejects(
        client.request({
          method: "GET",
          path: "/calendars/primary/events",
          query: { syncToken: "synthetic-cursor" },
        }),
        (error: unknown) => {
          assert.ok(error && typeof error === "object" && "kind" in error && "options" in error);
          assert.equal(error.kind, "resource_unavailable");
          const options = error.options as { recovery?: { status?: number } };
          assert.equal(options.recovery?.status === 410, status === 410);
          assert.equal(JSON.stringify(error).includes("PRIVATE-UPSTREAM-CONTENT"), false);
          assert.equal(JSON.stringify(error).includes("synthetic-private"), false);
          return true;
        },
      );
      assert.equal(calls, 1);
    } finally {
      await client.close();
    }
  });
