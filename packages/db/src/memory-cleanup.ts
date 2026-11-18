import type { Prisma } from "./client.js";

export interface MemoryCleanupIntent {
  token: string;
  kind: "clear" | "save";
  generations: number[];
}

export function memoryCleanupIntents(value: Prisma.JsonValue): MemoryCleanupIntent[] {
  return value as unknown as MemoryCleanupIntent[];
}

export function hasPendingMemoryCleanup(value: Prisma.JsonValue, generation: number): boolean {
  return memoryCleanupIntents(value).some(
    (intent) => intent.kind === "clear" || intent.generations.some((item) => item < generation),
  );
}
