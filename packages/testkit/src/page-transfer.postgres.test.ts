import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PageTransferRecord } from "@rakazo/contracts";
import {
  applyRowSecurityPolicies,
  bootstrapUserSpace,
  createDb,
  IsolationError,
  PAGE_SHARE_SECRET_KIND,
  provisionRuntimeRole,
  rlsBypassKey,
  runAsTenant,
  SpaceDeletionInProgressError,
  verifyRuntimeDatabase,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportPageRecords, importPageRecords } from "../../../apps/api/src/page-transfer.js";
import { getPage, removePage } from "../../../apps/api/src/pages.js";

const databaseUrl = process.env.DATABASE_URL;
const postgres =
  process.env.VERIFY_DATABASE === "1" &&
  process.env.VERIFY_ROW_SECURITY_POLICIES === "harness_isolated" &&
  databaseUrl
    ? describe.sequential
    : describe.skip;
const when = "2026-10-20T12:34:56.123Z";
const tsx = (text: string) =>
  `export default function App() { return <Page title="Report"><Text>${text}</Text></Page>; }`;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
type Page = Extract<PageTransferRecord, { type: "page" }>;
type Version = Extract<PageTransferRecord, { type: "page_version" }>;

const portablePage: Page = {
  type: "page",
  id: "old-page",
  botId: null,
  groupId: null,
  title: "Renamed report",
  pinnedAt: when,
  currentVersion: 1,
  createdAt: when,
  updatedAt: when,
};
const portableVersion: Version = {
  type: "page_version",
  id: "old-version",
  pageId: portablePage.id,
  version: 1,
  title: "Initial report",
  source: tsx("Source text"),
  createdAt: when,
};

postgres("Page transfer processing (isolated PostgreSQL)", () => {
  const login = `page_transfer_${randomBytes(8).toString("hex")}`;
  let owner: ReturnType<typeof createDb> | undefined;
  let runtime: ReturnType<typeof createDb> | undefined;
  let grantRole: string | undefined;
  let runtimeUrl: string | undefined;
  let ownRoles = false;
  const admin = () => owner!.prisma;
  const client = () => runtime!.prisma;

  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    const database = url.pathname.slice(1);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      Number(url.port) <= 1024 ||
      !/^integration_(0|[1-9][0-9]*)$/.test(database) ||
      database !== process.env.VERIFY_ISOLATED_DATABASE ||
      database !== process.env.VERIFY_ROW_SECURITY_POLICIES_DATABASE ||
      ["host", "hostaddr", "port", "database", "dbname", "service"].some((key) =>
        url.searchParams.has(key),
      )
    ) {
      throw new Error("Page transfer tests require an explicitly isolated harness database");
    }
    owner = createDb(databaseUrl!);
    const identity = await owner.pool.query<{ name: string; grant: string }>(
      "SELECT datname AS name, 'coginebot_app_' || oid::text AS grant FROM pg_database WHERE datname=current_database()",
    );
    expect(identity.rows[0]?.name).toBe(database);
    grantRole = identity.rows[0]!.grant;
    const roles = await owner.pool.query("SELECT 1 FROM pg_roles WHERE rolname = ANY($1)", [
      [login, grantRole],
    ]);
    expect(roles.rowCount).toBe(0);
    ownRoles = true;
    url.username = login;
    url.password = randomBytes(24).toString("hex");
    url.searchParams.delete("user");
    url.searchParams.delete("password");
    runtimeUrl = url.toString();
    await provisionRuntimeRole(databaseUrl!, runtimeUrl);
    await applyRowSecurityPolicies(databaseUrl!, runtimeUrl);
    runtime = createDb(runtimeUrl, { rowSecurity: true });
    await expect(verifyRuntimeDatabase(client())).resolves.toMatchObject({
      connectionEnforced: true,
    });
  }, 120_000);

  afterAll(async () => {
    const failures: unknown[] = [];
    const clean = async (work: () => Promise<unknown>) => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    if (runtime) {
      await clean(() => client().$disconnect());
      await clean(() => runtime!.pool.end());
    }
    if (owner) {
      if (ownRoles) {
        if (runtimeUrl) {
          await clean(() =>
            owner!.pool.query(
              "DELETE FROM cogine_private.rls_bypass_keys WHERE digest=sha256(convert_to($1,'UTF8'))",
              [rlsBypassKey(runtimeUrl!)],
            ),
          );
        }
        for (const role of [login, grantRole!]) {
          await clean(async () => {
            const exists = await owner!.pool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [
              role,
            ]);
            if (!exists.rowCount) return;
            await owner!.pool.query(`DROP OWNED BY ${quote(role)}`);
            await owner!.pool.query(`DROP ROLE ${quote(role)}`);
          });
        }
      }
      await clean(() => admin().$disconnect());
      await clean(() => owner!.pool.end());
    }
    if (failures.length) throw new AggregateError(failures, "Page transfer fixture cleanup failed");
  });

  async function account() {
    const userId = randomUUID();
    const email = `${userId}@example.test`;
    await admin().user.create({ data: { id: userId, name: "Page transfer fixture", email } });
    const { spaceId } = await bootstrapUserSpace(
      admin(),
      { id: userId },
      { signupsEnabled: undefined, signupAllowlist: undefined },
      { claimDeploymentOwner: false },
    );
    return {
      scope: { userId, spaceId },
      actor: { userId, spaceId, email, isDeploymentOwner: false },
    };
  }

  async function associations(scope: { userId: string; spaceId: string }) {
    const [bot, group] = await Promise.all([
      admin().bot.create({ data: { ...scope, name: "Fixture Bot", color: "#3EC5A8" } }),
      admin().chatGroup.create({ data: { ...scope, name: "Fixture group" } }),
    ]);
    return { botId: bot.id, groupId: group.id };
  }

  it("exports only owned Pages and header-bounded history through both keyset cursors", async () => {
    const { scope } = await account();
    const stranger = (await account()).scope;
    const { botId, groupId } = await associations(scope);
    const pageId = `00-${randomUUID()}`;
    const date = new Date(when);
    const secret = await admin().secret.create({
      data: { ...scope, kind: PAGE_SHARE_SECRET_KIND, ciphertext: "fixture-sealed-share" },
    });
    const hash = createHash("sha256").update(pageId).digest("hex");
    await admin().page.create({
      data: {
        ...scope,
        id: pageId,
        botId,
        groupId,
        title: "Renamed report",
        currentVersion: 34,
        visibility: "link",
        shareSecretId: secret.id,
        shareTokenHash: hash,
        pinnedAt: date,
        createdAt: date,
        updatedAt: date,
        versions: {
          create: Array.from({ length: 34 }, (_, i) => ({
            version: i + 1,
            title: "Archived report",
            source: tsx(`Version ${i + 1}`),
            code: "fixture-precompiled-code",
            createdAt: date,
          })),
        },
      },
    });
    const extras = Array.from({ length: 32 }, (_, index) => ({
      ...scope,
      id: `extra-${pageId}-${index}`,
      title: "Other Page",
    }));
    await admin().page.createMany({
      data: [
        ...extras,
        { ...scope, userId: stranger.userId, title: "Other owner" },
        { ...scope, spaceId: stranger.spaceId, title: "Other Space" },
      ],
    });
    await admin().pageVersion.createMany({
      data: extras.map(({ id }) => ({
        pageId: id,
        title: "Other Page",
        source: tsx("Other Page"),
        code: "fixture-precompiled-code",
        version: 1,
      })),
    });

    const stream = exportPageRecords(client(), scope);
    const first = await stream.next();
    expect(first.value).toEqual({
      type: "page",
      id: pageId,
      botId,
      groupId,
      title: "Renamed report",
      currentVersion: 34,
      pinnedAt: when,
      createdAt: when,
      updatedAt: when,
    });
    await admin().page.update({
      where: { id: pageId },
      data: {
        title: "Late update",
        currentVersion: 35,
        versions: {
          create: { version: 35, title: "Late update", source: tsx("Late update"), code: "late" },
        },
      },
    });
    const remaining = await Array.fromAsync(stream);
    const versions = remaining.filter(
      (row) => row.type === "page_version" && row.pageId === pageId,
    );
    expect(versions.map((row) => row.version)).toEqual(Array.from({ length: 34 }, (_, i) => i + 1));
    expect(
      remaining
        .filter((row) => row.type === "page")
        .map((row) => row.id)
        .sort(),
    ).toEqual(extras.map(({ id }) => id).sort());
    expect(JSON.stringify([first.value, ...remaining])).not.toMatch(
      /fixture-precompiled-code|fixture-sealed-share|shareTokenHash|shareSecretId|visibility|userId|spaceId|Late update/,
    );
    await expect(
      exportPageRecords(client(), { ...scope, userId: stranger.userId }).next(),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it.each(["page deletion", "membership loss"] as const)(
    "rejects a streamed export when %s hides the observed current version",
    async (change) => {
      const { actor, scope } = await account();
      const page = await admin().page.create({
        data: {
          ...scope,
          title: "Export interrupted",
          currentVersion: 33,
          versions: {
            create: Array.from({ length: 33 }, (_, index) => ({
              version: index + 1,
              title: "Export interrupted",
              source: portableVersion.source,
              code: "fixture",
            })),
          },
        },
      });
      const stream = exportPageRecords(client(), scope);
      await expect(stream.next()).resolves.toMatchObject({
        value: { type: "page", id: page.id, currentVersion: 33 },
        done: false,
      });
      if (change === "page deletion") {
        await runAsTenant(scope, () => removePage(client(), actor, page.id));
      } else {
        for (let version = 1; version <= 32; version++) {
          await expect(stream.next()).resolves.toMatchObject({
            value: { type: "page_version", pageId: page.id, version },
            done: false,
          });
        }
        await admin().spaceMember.delete({ where: { spaceId_userId: scope } });
      }
      await expect(stream.next()).rejects.toThrow("Page history changed during export");
    },
  );

  it("round-trips private Pages, fresh IDs, authorized mappings and safe history", async () => {
    const source = (await account()).scope;
    const { actor, scope } = await account();
    const from = await associations(source);
    const to = await associations(scope);
    const oldSource = `export const legacy = 1; ${tsx("Kept for history")}`;
    const secret = await admin().secret.create({
      data: { ...source, kind: PAGE_SHARE_SECRET_KIND, ciphertext: "fixture-existing-grant" },
    });
    const shareTokenHash = createHash("sha256").update(secret.id).digest("hex");
    const oldPage = await admin().page.create({
      data: {
        ...source,
        ...from,
        title: portablePage.title,
        currentVersion: 3,
        visibility: "link",
        shareSecretId: secret.id,
        shareTokenHash,
        shareRevision: 1,
        pinnedAt: when,
        createdAt: when,
        updatedAt: when,
        versions: {
          create: [
            {
              version: 1,
              title: "Historical",
              source: oldSource,
              code: "wrong-history-code",
              createdAt: when,
            },
            {
              version: 3,
              title: "Latest",
              source: tsx("Current text"),
              code: "wrong-latest-code",
              createdAt: when,
            },
          ],
        },
      },
      include: { versions: true },
    });
    const detached = await admin().page.create({
      data: {
        ...source,
        title: "Missing target association",
        botId: (await associations(source)).botId,
        versions: {
          create: {
            version: 1,
            title: "Missing target association",
            source: tsx("Detached"),
            code: "fixture",
          },
        },
      },
    });
    // A destination opens the greatest retained version, even with gaps or a stale header.
    const records = (await Array.fromAsync(exportPageRecords(client(), source))).map((record) =>
      record.type === "page" && record.id === oldPage.id
        ? { ...record, currentVersion: 9 }
        : record,
    );
    const result = await importPageRecords(
      client(),
      {
        ...scope,
        botIds: new Map([[from.botId, to.botId]]),
        groupIds: new Map([[from.groupId, to.groupId]]),
      },
      records,
    );
    const pageId = result.pageIds.get(oldPage.id)!;
    expect(pageId).not.toBe(oldPage.id);
    const imported = await admin().page.findUniqueOrThrow({
      where: { id: pageId },
      include: { versions: { orderBy: { version: "asc" } } },
    });
    expect(imported).toMatchObject({
      ...scope,
      ...to,
      title: oldPage.title,
      currentVersion: 3,
      shareTokenHash: null,
      shareSecretId: null,
      shareRevision: 0,
      visibility: "private",
      createdAt: new Date(when),
      updatedAt: new Date(when),
      pinnedAt: new Date(when),
    });
    expect(imported.versions).toMatchObject([
      { version: 1, title: "Historical", source: oldSource, createdAt: new Date(when) },
      { version: 3, title: "Latest", source: tsx("Current text"), createdAt: new Date(when) },
    ]);
    for (const original of oldPage.versions) {
      const newId = result.versionIds.get(original.id);
      expect(newId).not.toBe(original.id);
      expect(imported.versions.find(({ version }) => version === original.version)?.id).toBe(newId);
    }
    const detail = (version?: number) =>
      runAsTenant(scope, () => getPage(client(), actor, { pageId, version }));
    await expect(detail(1)).resolves.toMatchObject({
      currentVersion: 3,
      version: 1,
      code: expect.stringMatching(/^throw new Error\(.*only.*export default/),
    });
    await expect(detail()).resolves.toMatchObject({
      version: 3,
      code: expect.stringContaining("Current text"),
    });
    await expect(
      admin().page.findUnique({ where: { id: result.pageIds.get(detached.id)! } }),
    ).resolves.toMatchObject({ botId: null, groupId: null });
    await expect(
      runAsTenant(source, () => client().page.findUnique({ where: { id: pageId } })),
    ).resolves.toBeNull();
    await expect(admin().page.findUnique({ where: { id: oldPage.id } })).resolves.toMatchObject({
      shareTokenHash,
      shareSecretId: secret.id,
      shareRevision: 1,
      visibility: "link",
    });
    await expect(admin().secret.count({ where: scope })).resolves.toBe(0);
    await expect(admin().routine.count({ where: scope })).resolves.toBe(0);
  });

  it("honors an existing destination Space deletion claim", async () => {
    const { scope } = await account();
    await admin().space.update({
      where: { id: scope.spaceId },
      data: { deletingAt: new Date(), deletionClaimId: randomUUID() },
    });
    await expect(
      importPageRecords(client(), scope, [portablePage, portableVersion]),
    ).rejects.toBeInstanceOf(SpaceDeletionInProgressError);
    await expect(admin().page.count({ where: scope })).resolves.toBe(0);
  });

  it("rejects incomplete or duplicate archives and unauthorized destination mappings", async () => {
    const { scope } = await account();
    const stranger = await account();
    const foreign = await associations(stranger.scope);
    const importInto = (records: unknown[]) => importPageRecords(client(), scope, records);
    await expect(importInto([portablePage])).rejects.toThrow("Page has no versions");
    await expect(importInto([portableVersion])).rejects.toThrow("Page version is missing its Page");
    await expect(importInto([portablePage, portablePage, portableVersion])).rejects.toThrow(
      "Duplicate Page transfer record ID",
    );
    await expect(
      importInto([portablePage, portableVersion, { ...portableVersion, id: "duplicate-version" }]),
    ).rejects.toThrow("Duplicate Page version");
    await expect(
      importInto([{ ...portablePage, shareSecretId: "forged" }, portableVersion]),
    ).rejects.toThrow("Invalid Page transfer record");
    const mappedPage = { ...portablePage, botId: "source-bot", groupId: "source-group" };
    for (const mapping of [
      { botIds: new Map([["source-bot", foreign.botId]]) },
      { groupIds: new Map([["source-group", foreign.groupId]]) },
    ]) {
      await expect(
        importPageRecords(client(), { ...scope, ...mapping }, [mappedPage, portableVersion]),
      ).rejects.toBeInstanceOf(IsolationError);
    }
    await expect(
      importPageRecords(client(), { ...scope, userId: stranger.scope.userId }, [
        portablePage,
        portableVersion,
      ]),
    ).rejects.toBeInstanceOf(IsolationError);
    await expect(admin().page.count({ where: scope })).resolves.toBe(0);
  });

  it("rolls back already written Pages and versions if a later database batch fails", async () => {
    const { scope } = await account();
    const rejected = `fixture-write-failure-${randomUUID()}`;
    await owner!.pool.query(
      `ALTER TABLE cogine_pages.page_versions ADD CONSTRAINT transfer_fixture_reject
       CHECK (source <> '${rejected}') NOT VALID`,
    );
    try {
      const history = Array.from({ length: 33 }, (_, index) => ({
        ...portableVersion,
        id: `source-version-${index + 1}`,
        version: index + 1,
        source: index === 32 ? rejected : portableVersion.source,
      }));
      const before = await admin().pageVersion.count();
      await expect(importPageRecords(client(), scope, [portablePage, ...history])).rejects.toThrow(
        /transfer_fixture_reject/,
      );
      await expect(admin().page.count({ where: scope })).resolves.toBe(0);
      await expect(admin().pageVersion.count()).resolves.toBe(before);
    } finally {
      await owner!.pool.query(
        "ALTER TABLE cogine_pages.page_versions DROP CONSTRAINT transfer_fixture_reject",
      );
    }
  });
});
