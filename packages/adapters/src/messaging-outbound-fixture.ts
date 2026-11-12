import { vi } from "vitest";

type Row = Record<string, unknown>;
type Filter = Record<string, unknown>;

function compare(value: unknown, boundary: string | number | Date): number {
  if (value instanceof Date && boundary instanceof Date)
    return value.getTime() - boundary.getTime();
  if (typeof value === "number" && typeof boundary === "number") return value - boundary;
  if (typeof value === "string" && typeof boundary === "string")
    return value.localeCompare(boundary);
  return Infinity;
}

function matches(row: Row, where: Filter): boolean {
  for (const [field, value] of Object.entries(where)) {
    if (value === undefined) continue;
    if (field === "AND" || field === "OR") {
      const clauses = value as Filter[];
      if (
        !(field === "AND"
          ? clauses.every((part) => matches(row, part))
          : clauses.some((part) => matches(row, part)))
      )
        return false;
      continue;
    }
    const actual = row[field] ?? null;
    if (value && typeof value === "object" && !(value instanceof Date)) {
      const predicate = value as {
        in?: unknown[];
        not?: unknown;
        lt?: string | number | Date;
        lte?: string | number | Date;
      };
      if (predicate.in && !predicate.in.includes(actual)) return false;
      if ("not" in predicate && predicate.not === actual) return false;
      if (predicate.lt !== undefined && compare(actual, predicate.lt) >= 0) return false;
      if (predicate.lte !== undefined && compare(actual, predicate.lte) > 0) return false;
      continue;
    }
    if (value instanceof Date) {
      if (!(actual instanceof Date) || actual.getTime() !== value.getTime()) return false;
    } else if (value !== actual) {
      return false;
    }
  }
  return true;
}

export function messagingOutboxFixture<T extends Row>(rows: T[], existing?: unknown) {
  let id = rows.length;
  const normalize = (data: Row) =>
    ({
      id: `fixture-outbound-${++id}`,
      status: "pending",
      attempts: 0,
      partIndex: 0,
      provider: null,
      providerHandle: null,
      sourceMessageId: null,
      createdAt: new Date(0),
      ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
    }) as unknown as T;
  for (const row of rows) Object.assign(row, normalize(row));
  const find = (where: Filter = {}) => rows.filter((row) => matches(row, where));
  const modify = (where: Filter, data: Row) => find(where).map((row) => Object.assign(row, data));
  return {
    findFirst: vi.fn(
      async ({ where }: { where?: Filter } = {}) =>
        find(where).map((row) => ({ ...row }))[0] ?? null,
    ),
    findUnique: vi.fn(
      async ({ where }: { where?: Filter } = {}) =>
        find(where).map((row) => ({ ...row }))[0] ?? null,
    ),
    findMany: vi.fn(async ({ where }: { where?: Filter } = {}) =>
      find(where).map((row) => ({ ...row })),
    ),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      let count = 0;
      for (const item of data) {
        if (
          rows.some((row) => row.idempotencyKey === item.idempotencyKey) ||
          (existing as Row | undefined)?.idempotencyKey === item.idempotencyKey
        )
          continue;
        rows.push(normalize(item));
        count++;
      }
      return { count };
    }),
    updateMany: vi.fn(async ({ where, data }: { where: Filter; data: Row }) => ({
      count: modify(where, data).length,
    })),
    updateManyAndReturn: vi.fn(async ({ where, data }: { where: Filter; data: Row }) =>
      modify(where, data),
    ),
    deleteMany: vi.fn(async ({ where }: { where: Filter }) => {
      const victims = new Set(find(where));
      for (let i = rows.length - 1; i >= 0; i--) {
        if (victims.has(rows[i]!)) rows.splice(i, 1);
      }
      return { count: victims.size };
    }),
    upsert: vi.fn(
      async ({ where, create, update }: { where: Filter; create: Row; update: Row }) => {
        const found = modify(where, update)[0];
        if (found) return found;
        const row = normalize(create);
        rows.push(row);
        return row;
      },
    ),
  };
}
