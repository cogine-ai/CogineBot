import { describe, expect, it } from "vitest";
import { formatDatabasePreparationFailure } from "./migrate-database-error.js";

const fallback =
  "Database preparation failed. Check the administrator connection, runtime role grants, and credential configuration.\n";
const hidden = "postgresql://fixture-user:private-canary@private-host.invalid/private-db";

describe("database preparation diagnostics", () => {
  it("preserves an actionable known configuration error", () => {
    expect(formatDatabasePreparationFailure(new Error("DATABASE_URL is required"))).toBe(
      fallback.replace("failed.", "failed. DATABASE_URL is required."),
    );
  });

  it("falls back safely when reading an error property throws", () => {
    const error = new Error("DATABASE_URL is required");
    Object.defineProperty(error, "code", {
      get() {
        throw new Error(hidden);
      },
    });
    expect(formatDatabasePreparationFailure(error)).toBe(fallback);
  });

  it("preserves the exact database grant-role creation remediation", () => {
    const message =
      "Could not create coginebot_app_42; precreate a restricted runtime grant role or use a migration role with CREATEROLE";
    expect(formatDatabasePreparationFailure(new Error(message))).toBe(
      fallback.replace("failed.", `failed. ${message}.`),
    );
  });

  it.each([
    {
      message: "Database preparation requires the migration URL to select the public schema",
      hint: "Database preparation requires the migration URL to select the public schema",
    },
    { message: "is a superuser", hint: "The runtime role is a superuser" },
    { message: "the system key is not registered", hint: "The system key is not registered" },
  ])("renders the known diagnostic as a complete sentence: $message", ({ message, hint }) => {
    expect(formatDatabasePreparationFailure(new Error(message, { cause: new Error(hidden) }))).toBe(
      fallback.replace("failed.", `failed. ${hint}.`),
    );
  });

  it.each(["1", "4294967295"])("accepts both exact remediation templates for OID %s", (oid) => {
    const creation = `Could not create coginebot_app_${oid}; precreate a restricted runtime grant role or use a migration role with CREATEROLE`;
    const managed = `The migration role cannot create or change the runtime login. Precreate a LOGIN NOBYPASSRLS role and grant coginebot_app_${oid}, then retry.`;
    expect(formatDatabasePreparationFailure(new Error(creation))).toBe(
      fallback.replace("failed.", `failed. ${creation}.`),
    );
    expect(formatDatabasePreparationFailure(new Error(managed))).toBe(
      fallback.replace("failed.", `failed. ${managed}`),
    );
  });

  it.each(["0", "01", "4294967296", "99999999999", "-1"])(
    "rejects invalid derived role OID %s",
    (oid) => {
      const creation = `Could not create coginebot_app_${oid}; precreate a restricted runtime grant role or use a migration role with CREATEROLE`;
      const managed = `The migration role cannot create or change the runtime login. Precreate a LOGIN NOBYPASSRLS role and grant coginebot_app_${oid}, then retry.`;
      expect(formatDatabasePreparationFailure(new Error(creation))).toBe(fallback);
      expect(formatDatabasePreparationFailure(new Error(managed))).toBe(fallback);
    },
  );

  it.each([
    hidden,
    `DATABASE_URL is required: ${hidden}`,
    "DATABASE_URL is required\n",
    "Could not create other_app_42; precreate a restricted runtime grant role or use a migration role with CREATEROLE",
    "Could not create coginebot_app_42; precreate a restricted runtime grant role or use a migration role with CREATEROLE\n",
    `Could not create coginebot_app_42; precreate a restricted runtime grant role or use a migration role with CREATEROLE ${hidden}`,
    "The migration role cannot create or change the runtime login. Precreate a LOGIN NOBYPASSRLS role and grant coginebot_app_42, then retry.\n",
    `The migration role cannot create or change the runtime login. Precreate a LOGIN NOBYPASSRLS role and grant coginebot_app_42, then retry. ${hidden}`,
  ])("hides an unrecognized message: %s", (message) => {
    expect(formatDatabasePreparationFailure(new Error(message))).toBe(fallback);
  });

  it.each(["28P01", "42501"])("reports only validated SQLSTATE %s from a driver error", (code) => {
    const error = Object.assign(new Error(hidden), { code });
    for (const property of ["message", "cause", "detail", "where", "stack"]) {
      Object.defineProperty(error, property, {
        get() {
          throw new Error(hidden);
        },
      });
    }
    expect(formatDatabasePreparationFailure(error)).toBe(
      fallback.replace("failed.", `failed (${code}).`),
    );
  });

  it("does not expose an allowlisted message from a coded driver-style error", () => {
    const error = Object.assign(new Error("DATABASE_URL is required"), { code: "28P01" });
    expect(formatDatabasePreparationFailure(error)).toBe(
      fallback.replace("failed.", "failed (28P01)."),
    );
  });

  it.each([hidden, "40001\n", `40001\n${hidden}`, "ECONNREFUSED", "bad", 40001, null, undefined])(
    "hides invalid codes and coded messages: %s",
    (code) => {
      const error = Object.assign(new Error("DATABASE_URL is required"), { code });
      expect(formatDatabasePreparationFailure(error)).toBe(fallback);
    },
  );

  it.each([undefined, null, hidden, { message: "DATABASE_URL is required" }, { message: hidden }])(
    "hides unknown thrown values: %s",
    (error) => {
      expect(formatDatabasePreparationFailure(error)).toBe(fallback);
    },
  );

  it("reads the code only once", () => {
    let reads = 0;
    const error = new Error(hidden);
    Object.defineProperty(error, "code", {
      get() {
        return ++reads === 1 ? "28P01" : hidden;
      },
    });
    expect(formatDatabasePreparationFailure(error)).toBe(
      fallback.replace("failed.", "failed (28P01)."),
    );
    expect(reads).toBe(1);
  });

  it("reads the message only once", () => {
    let reads = 0;
    const error = new Error("fixture");
    Object.defineProperty(error, "message", {
      get() {
        return ++reads === 1 ? "DATABASE_URL is required" : hidden;
      },
    });
    expect(formatDatabasePreparationFailure(error)).toBe(
      fallback.replace("failed.", "failed. DATABASE_URL is required."),
    );
    expect(reads).toBe(1);
  });

  it("falls back safely when reading a message throws", () => {
    const error = new Error("fixture");
    Object.defineProperty(error, "message", {
      get() {
        throw new Error(hidden);
      },
    });
    expect(formatDatabasePreparationFailure(error)).toBe(fallback);
  });

  it("falls back safely when checking a property throws", () => {
    const error = new Proxy(new Error(hidden), {
      has() {
        throw new Error(hidden);
      },
    });
    expect(formatDatabasePreparationFailure(error)).toBe(fallback);
  });
});
