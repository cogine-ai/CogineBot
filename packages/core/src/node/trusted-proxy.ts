import { lookup } from "node:dns/promises";
import { BlockList, isIP, SocketAddress } from "node:net";

const hostTtlMs = 30_000;
const hostname = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i;
const lookupHost = async (host: string) =>
  (await lookup(host, { all: true })).map(({ address }) => address);

export function parseTrustedProxies(value: string | undefined) {
  return value
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseIp(value: string): string | undefined {
  let address = value.trim();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed?.[1]) address = bracketed[1];
  else if (/^[\d.]+:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(":"));
  const family = isIP(address);
  if (family === 4) return address;
  if (family !== 6) return undefined;
  const canonical = new SocketAddress({ address, family: "ipv6" }).address;
  return /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(canonical)?.[1] ?? canonical;
}

/** Resolve the peer first. A forwarded chain is evidence only when the peer is trusted. */
export function createClientIpResolver(
  configured: string[] = [],
  { resolve = lookupHost, now = Date.now } = {},
) {
  const ranges = new BlockList();
  const names: string[] = [];
  for (const entry of configured) {
    if (entry === "none") continue;
    const [address = "", prefix, extra] = entry.split("/");
    const family = isIP(address);
    const bits = Number(prefix);
    if (family && prefix === undefined) {
      const parsed = parseIp(address)!;
      ranges.addAddress(parsed, isIP(parsed) === 6 ? "ipv6" : "ipv4");
    } else if (
      family &&
      extra === undefined &&
      /^\d+$/.test(prefix ?? "") &&
      bits <= (family === 6 ? 128 : 32)
    ) {
      ranges.addSubnet(address, bits, family === 6 ? "ipv6" : "ipv4");
    } else if (!family && prefix === undefined && hostname.test(entry)) {
      names.push(entry);
    } else {
      throw new Error("Trusted proxies must contain IP addresses, CIDRs, or hostnames");
    }
  }

  let known = new Set<string>();
  let unresolvedHosts = false;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let refreshing: Promise<void> | undefined;
  async function refreshHosts() {
    if (!names.length || now() - refreshedAt < hostTtlMs) return;
    refreshing ??= Promise.all(names.map((name) => resolve(name).catch(() => [])))
      .then((addresses) => {
        const resolved = addresses.map((values) => values.flatMap((value) => parseIp(value) ?? []));
        known = new Set(resolved.flat());
        unresolvedHosts = resolved.some((values) => values.length === 0);
        refreshedAt = now();
      })
      .finally(() => {
        refreshing = undefined;
      });
    await refreshing;
  }
  const trusted = (ip: string) =>
    ranges.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4") || known.has(ip);

  return async ({
    peer,
    forwarded,
    requireClientIp = false,
  }: {
    peer?: string;
    forwarded?: string;
    requireClientIp?: boolean;
  }) => {
    const ip = peer ? parseIp(peer) : undefined;
    if (!ip || (!forwarded && !requireClientIp)) return ip;
    await refreshHosts();
    if (requireClientIp && unresolvedHosts) return undefined;
    if (!trusted(ip)) return ip;
    if (!forwarded) return undefined;
    const hops = forwarded.split(",").map(parseIp);
    for (let index = hops.length - 1; index >= 0; index--) {
      const hop = hops[index];
      if (!hop) return requireClientIp ? undefined : ip;
      if (!trusted(hop)) return hop;
    }
    return requireClientIp ? undefined : (hops[0] ?? ip);
  };
}

export type ClientIpResolver = ReturnType<typeof createClientIpResolver>;

/** A source address is optional for audit, even when a configured proxy uses DNS. */
export async function resolveClientIpForAudit(
  resolve: ClientIpResolver,
  source: { peer?: string; forwarded?: string },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resolve({ ...source, requireClientIp: true }),
      new Promise<undefined>((done) => {
        timer = setTimeout(() => done(undefined), 250);
        timer.unref();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
