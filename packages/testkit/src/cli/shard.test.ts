import { describe, expect, it } from "vitest";
import { parseShard, selectIntegrationSuites } from "./shard.js";

describe("harness sharding", () => {
  it("keeps an unsharded invocation intact", () => {
    expect(parseShard(["--integration", "--spec=postgres"])).toBeUndefined();
    expect(selectIntegrationSuites(["one", "two"], undefined, undefined)).toEqual(["one", "two"]);
  });

  it("accepts Playwright's one-based shard syntax", () => {
    expect(parseShard(["--e2e", "--shard=2/3"])).toEqual({ current: 2, total: 3 });
    expect(parseShard(["--integration", "--shard=1/1"])).toEqual({ current: 1, total: 1 });
  });

  it.each([
    "--shard",
    "--shard=",
    "--shard=0/2",
    "--shard=1/0",
    "--shard=3/2",
    "--shard=-1/2",
    "--shard=1.5/2",
    "--shard=1/2/3",
    "--shard=1/9007199254740992",
  ])("rejects an invalid shard option %s", (option) => {
    expect(() => parseShard([option])).toThrow("Pass --shard=current/total");
  });

  it("rejects duplicate options instead of silently choosing one", () => {
    expect(() => parseShard(["--shard=1/2", "--shard=2/2"])).toThrow("only once");
  });

  it("covers an uneven suite list exactly once across all shards", () => {
    const suites = ["a", "b", "c", "d", "e", "f", "g"];
    const shards = [1, 2, 3].map((current) =>
      selectIntegrationSuites(suites, undefined, { current, total: 3 }),
    );
    expect(shards).toEqual([
      ["a", "d", "g"],
      ["b", "e"],
      ["c", "f"],
    ]);
    expect(shards.flat().sort()).toEqual(suites);
  });

  it("applies spec selection before partitioning", () => {
    const suites = ["skip", "first.postgres", "other", "second.postgres", "third.postgres"];
    expect(selectIntegrationSuites(suites, "postgres", { current: 1, total: 2 })).toEqual([
      "first.postgres",
      "third.postgres",
    ]);
    expect(selectIntegrationSuites(suites, "postgres", { current: 2, total: 2 })).toEqual([
      "second.postgres",
    ]);
  });

  it("fails unmatched or invalid spec filters", () => {
    expect(() => selectIntegrationSuites(["one"], "missing", undefined)).toThrow(
      "No integration suites matched --spec",
    );
    expect(() => selectIntegrationSuites(["one"], "[", undefined)).toThrow(SyntaxError);
  });

  it("fails an empty shard instead of reporting untested success", () => {
    expect(() => selectIntegrationSuites(["one", "two"], "one", { current: 2, total: 2 })).toThrow(
      "No integration suites selected for --shard=2/2",
    );
  });
});
