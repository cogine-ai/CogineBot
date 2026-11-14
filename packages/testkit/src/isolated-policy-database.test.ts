import { expect, it } from "vitest";
import {
  assertPolicyDatabaseIdentity,
  isolatedPolicyDatabase,
} from "./isolated-policy-database.js";

const env = {
  VERIFY_DATABASE: "1",
  VERIFY_ROW_SECURITY_POLICIES: "harness_isolated",
  VERIFY_ROW_SECURITY_POLICIES_DATABASE: "integration_3",
  VERIFY_ISOLATED_DATABASE: "integration_3",
};
const url = "postgresql://fixture:synthetic@localhost:55468/integration_3";
it.each(["localhost", "127.0.0.1", "[::1]"])(
  "accepts explicit isolated %s runner targets",
  (host) => {
    const target = isolatedPolicyDatabase(url.replace("localhost", host), env);
    expect(target.database).toBe("integration_3");
    expect(target.url.searchParams.get("host")).toBe(host === "[::1]" ? "::1" : null);
  },
);
it.each([
  url.replace("postgresql:", "https:"),
  url.replace("localhost", "remote.example.test"),
  url.replace(":55468", ":1024"),
  url.replace(":55468", ":0"),
  url.replace(":55468", ":"),
  url.replace(":55468", ":65536"),
  url.replace("integration_3", "postgres"),
  url.replace("integration_3", "integration_03"),
  url.replace("integration_3", "integration_-1"),
  `${url}?host=remote.example.test`,
  `${url}?dbname=postgres`,
  `${url}#fragment`,
  "invalid-url",
])("refuses an unsafe target without disclosing its connection string", (target) => {
  expect(() => isolatedPolicyDatabase(target, env)).toThrow(
    "Requires isolated policy harness database",
  );
});
it.each([
  "VERIFY_DATABASE",
  "VERIFY_ROW_SECURITY_POLICIES",
  "VERIFY_ROW_SECURITY_POLICIES_DATABASE",
  "VERIFY_ISOLATED_DATABASE",
])("requires matching %s", (key) => {
  expect(() => isolatedPolicyDatabase(url, { ...env, [key]: undefined })).toThrow();
  expect(() => isolatedPolicyDatabase(url, { ...env, [key]: "wrong" })).toThrow();
});
it("checks actual connection identity before fixture mutations", () => {
  expect(() =>
    assertPolicyDatabaseIdentity("integration_3", [{ database: "integration_3" }]),
  ).not.toThrow();
  for (const rows of [
    [],
    [{ database: "postgres" }],
    [{ database: "integration_3" }, { database: "integration_4" }],
  ])
    expect(() => assertPolicyDatabaseIdentity("integration_3", rows)).toThrow(
      "Connected database does not match",
    );
});
