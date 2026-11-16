import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type CookieRecord = { name: string; value: string; domain: string; path?: string };

export type Account = {
  id: string;
  email?: string;
  cookies: CookieRecord[];
  /** Chrome profile directory; keeps Google's device-bound session cookies alive. */
  profileDir?: string;
  disabled?: boolean;
};

export type AccountRuntime = {
  cooldownUntil: Partial<Record<string, number>>;
  lastUsed: number;
  authFailed?: boolean;
};

function normalizeCookies(raw: unknown): CookieRecord[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((c: any) => c && typeof c.name === "string" && typeof c.value === "string")
      .map((c: any) => ({ name: c.name, value: c.value, domain: String(c.domain || ".google.com"), path: c.path || "/" }));
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, string>)
      .filter(([k, v]) => k && typeof v === "string")
      .map(([name, value]) => ({ name, value, domain: ".google.com", path: "/" }));
  }
  return [];
}

function domainMatches(domain: string, host: string): boolean {
  const d = domain.replace(/^\./, "");
  return host === d || host.endsWith("." + d);
}

/** Build a Cookie header for a specific host; flow.google.com needs its own OSID cookies. */
export function cookieHeader(cookies: CookieRecord[], host: string): string {
  return cookies
    .filter((c) => c.name && c.value && domainMatches(c.domain, host))
    .sort((a, b) => (b.path || "/").length - (a.path || "/").length)
    .map((c) => c.name + "=" + c.value)
    .join("; ");
}

export class AccountPool {
  private accounts: Account[] = [];
  private runtime = new Map<string, AccountRuntime>();
  private inflight = new Map<string, number>();
  private workerCursor = new Map<string, number>();
  private cursor = 0;

  load() {
    const file = path.resolve(config.accountsFile);
    if (!fs.existsSync(file)) {
      this.accounts = [];
      return;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(raw) ? raw : raw.accounts || [];
    this.accounts = list.map((a: any) => ({ ...a, cookies: normalizeCookies(a.cookies) }));
  }

  all() {
    return this.accounts;
  }

  count() {
    return this.accounts.filter((a) => !a.disabled).length;
  }

  rt(id: string): AccountRuntime {
    let r = this.runtime.get(id);
    if (!r) {
      r = { cooldownUntil: {}, lastUsed: 0 };
      this.runtime.set(id, r);
    }
    return r;
  }

  /** Least-loaded account plus a worker index (tab) for concurrent requests. */
  acquire(modelRpc: string): { account: Account; workerIndex: number } | null {
    const now = Date.now();
    const workers = Math.max(1, config.workersPerAccount);
    const list = this.accounts.filter(
      (a) => !a.disabled && !this.rt(a.id).authFailed && (this.rt(a.id).cooldownUntil[modelRpc] || 0) <= now
    );
    if (!list.length) return null;
    list.sort((a, b) => (this.inflight.get(a.id) || 0) - (this.inflight.get(b.id) || 0));
    const acc = list[0];
    this.inflight.set(acc.id, (this.inflight.get(acc.id) || 0) + 1);
    const next = this.workerCursor.get(acc.id) || 0;
    this.workerCursor.set(acc.id, next + 1);
    return { account: acc, workerIndex: next % workers };
  }

  release(id: string) {
    this.inflight.set(id, Math.max(0, (this.inflight.get(id) || 1) - 1));
  }

  inflightOf(id: string) {
    return this.inflight.get(id) || 0;
  }

  pick(modelRpc: string): Account | null {
    const now = Date.now();
    const list = this.accounts.filter((a) => !a.disabled && !this.rt(a.id).authFailed);
    if (!list.length) return null;
    for (let i = 0; i < list.length; i++) {
      const acc = list[(this.cursor + i) % list.length];
      const cool = this.rt(acc.id).cooldownUntil[modelRpc] || 0;
      if (cool > now) continue;
      this.cursor = (this.cursor + i + 1) % list.length;
      this.rt(acc.id).lastUsed = now;
      return acc;
    }
    return null;
  }

  coolDown(id: string, modelRpc: string, ms: number) {
    const r = this.rt(id);
    r.cooldownUntil[modelRpc] = Math.max(r.cooldownUntil[modelRpc] || 0, Date.now() + ms);
  }

  markAuthFailed(id: string, failed = true) {
    this.rt(id).authFailed = failed;
  }

  save() {
    const file = path.resolve(config.accountsFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ accounts: this.accounts.map((a) => ({ id: a.id, email: a.email, disabled: a.disabled, cookies: a.cookies })) }, null, 2));
  }

  replaceCookies(id: string, cookies: CookieRecord[]) {
    const acc = this.accounts.find((a) => a.id === id);
    if (acc) acc.cookies = cookies;
  }

  snapshot() {
    return this.accounts.map((a) => {
      const r = this.rt(a.id);
      return {
        id: a.id,
        email: a.email,
        disabled: !!a.disabled,
        authFailed: !!r.authFailed,
        inflight: this.inflight.get(a.id) || 0,
        cooldownUntil: { ...r.cooldownUntil },
      };
    });
  }
}

export const accountPool = new AccountPool();