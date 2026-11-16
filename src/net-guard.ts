import { lookup } from "node:dns/promises";

function isPrivateV4(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === "::1" || s === "::") return true;
  if (s.startsWith("fe80") || s.startsWith("fc") || s.startsWith("fd")) return true;
  if (s.startsWith("::ffff:")) return isPrivateV4(s.slice(7));
  return false;
}

/**
 * Reject image_url values that point at loopback / private networks so a
 * downstream caller cannot use this service to reach internal endpoints.
 */
export async function assertPublicUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid image_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("image_url must be http(s)");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("image_url host is not allowed");
  }
  const isIpLiteral = /^[0-9.]+$/.test(host) || host.includes(":");
  const addresses = isIpLiteral
    ? [{ address: host, family: host.includes(":") ? 6 : 4 }]
    : await lookup(host, { all: true }).catch(() => {
        throw new Error("image_url host cannot be resolved");
      });
  for (const addr of addresses) {
    const ip = String(addr.address);
    const bad = ip.includes(":") ? isPrivateV6(ip) : isPrivateV4(ip);
    if (bad) throw new Error("image_url resolves to a private address");
  }
}
