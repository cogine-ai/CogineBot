import { isIP } from "node:net";

const MAX_TRACKED_KEYS = 10_000;
const OVERFLOW_KEY = "\0overflow";
type CountedWindow = { start: number; count: number };

/** Expire windows in insertion order, then share a coarse-network bucket if the table is full. */
export function windowCounter(windowMs: number, now: () => number = Date.now) {
  const windows = new Map<string, CountedWindow>();
  const coarse = new Map<string, CountedWindow>();
  const sweep = (table: Map<string, CountedWindow>, at: number) => {
    for (const [oldest, window] of table) {
      if (at - window.start < windowMs) break;
      table.delete(oldest);
    }
  };
  const count = (table: Map<string, CountedWindow>, key: string, at: number) => {
    const current = table.get(key);
    if (current) return ++current.count;
    table.set(key, { start: at, count: 1 });
    return 1;
  };
  return (key: string): number => {
    const at = now();
    sweep(windows, at);
    sweep(coarse, at);
    if (windows.has(key) || windows.size < MAX_TRACKED_KEYS) return count(windows, key, at);
    const shared = coarseKey(key);
    return count(
      coarse,
      coarse.has(shared) || coarse.size < MAX_TRACKED_KEYS ? shared : OVERFLOW_KEY,
      at,
    );
  };
}

function coarseKey(key: string): string {
  const ip = key.slice(3);
  if (ip.endsWith("::/64")) return `ip:${ip.slice(0, -5).split(":").slice(0, 3).join(":")}::/48`;
  const octets = ip.split(".");
  return octets.length === 4 ? `ip:${octets.slice(0, 3).join(".")}` : OVERFLOW_KEY;
}

/** IPv6 hosts may choose addresses throughout one /64, so they share that bucket. */
export function throttleKey(ip: string | undefined): string {
  if (!ip || isIP(ip) !== 6) return `ip:${ip ?? "unknown"}`;
  const [head = "", tail] = ip.replace(/%.*$/, "").split("::");
  const groups = (part: string) => (part ? part.split(":") : []);
  const width = (part: string[]) =>
    part.reduce((sum, group) => sum + (group.includes(".") ? 2 : 1), 0);
  const zeros =
    tail === undefined ? [] : Array(8 - width(groups(head)) - width(groups(tail))).fill("0");
  const prefix = [...groups(head), ...zeros, ...groups(tail ?? "")].slice(0, 4);
  return `ip:${prefix.map((group) => Number.parseInt(group, 16).toString(16)).join(":")}::/64`;
}
