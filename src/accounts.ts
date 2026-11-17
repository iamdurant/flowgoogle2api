import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type CookieRecord = { name: string; value: string; domain: string; path?: string };

export type Account = {
  id: string;
  email?: string;
  cookies: CookieRecord[];
  disabled?: boolean;
};

export type AccountRuntime = {
  cooldownUntil: Partial<Record<string, number>>;
  lastUsed: number;
  authFailed?: boolean;
  success: number;
  failure: number;
  lastError?: string;
  lastSuccessAt?: number;
  lastFailureAt?: number;
};

/** Turn a raw "Cookie: a=1; b=2" header into records; flow needs its own OSID. */
export function parseCookieHeader(text: string): CookieRecord[] {
  const raw = String(text || "").replace(/^\s*cookie\s*:/i, "").trim();
  const out: CookieRecord[] = [];
  for (const part of raw.split(/;\s*/)) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name || !value) continue;
    const domain = name === "OSID" || name === "__Secure-OSID" ? "flow.google.com" : ".google.com";
    out.push({ name, value, domain, path: "/" });
  }
  return out;
}

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

function parseSetCookie(line: string, fallbackDomain: string) {
  const parts = line.split(";");
  const first = parts[0] || "";
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  let domain = fallbackDomain;
  let path = "/";
  let remove = false;
  for (const attr of parts.slice(1)) {
    const i = attr.indexOf("=");
    const key = (i >= 0 ? attr.slice(0, i) : attr).trim().toLowerCase();
    const v = i >= 0 ? attr.slice(i + 1).trim() : "";
    if (key === "domain" && v) domain = v;
    else if (key === "path" && v) path = v;
    else if (key === "max-age" && Number(v) <= 0) remove = true;
  }
  return { name, value, domain, path, remove };
}

export class AccountPool {
  private accounts: Account[] = [];
  private statsTimer?: ReturnType<typeof setTimeout>;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private runtime = new Map<string, AccountRuntime>();
  /** Last counters written to disk, so re-importing cookies keeps the history. */
  private storedStats = new Map<string, { success: number; failure: number; lastError?: string; lastSuccessAt?: number; lastFailureAt?: number }>();
  private inflight = new Map<string, number>();
  private workerCursor = new Map<string, number>();
  private cursor = 0;
  /** Worker tabs that already completed one generation; missing = still cold. */
  private rampDone = new Map<string, Set<number>>();
  private rampChains = new Map<string, Promise<void>>();

  load() {
    const file = path.resolve(config.accountsFile);
    if (!fs.existsSync(file)) {
      this.accounts = [];
      return;
    }
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(raw) ? raw : raw.accounts || [];
    this.accounts = list.map((a: any) => ({ ...a, cookies: normalizeCookies(a.cookies) }));
    this.loadStats();
  }

  /** Success/failure counters survive restarts; they live in their own file. */
  private loadStats() {
    const file = path.resolve(config.statsFile);
    if (!fs.existsSync(file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const stored = raw.accounts || {};
      for (const acc of this.accounts) {
        const s = stored[acc.id];
        if (!s) continue;
        this.storedStats.set(acc.id, {
          success: Number(s.success) || 0,
          failure: Number(s.failure) || 0,
          lastError: typeof s.lastError === "string" ? s.lastError : undefined,
          lastSuccessAt: Number(s.lastSuccessAt) || undefined,
          lastFailureAt: Number(s.lastFailureAt) || undefined,
        });
        const r = this.rt(acc.id);
        r.success = Number(s.success) || 0;
        r.failure = Number(s.failure) || 0;
        r.lastError = typeof s.lastError === "string" ? s.lastError : undefined;
        r.lastSuccessAt = Number(s.lastSuccessAt) || undefined;
        r.lastFailureAt = Number(s.lastFailureAt) || undefined;
      }
    } catch {
      /* a broken stats file must not stop the service */
    }
  }

  saveStats() {
    if (this.statsTimer) {
      clearTimeout(this.statsTimer);
      this.statsTimer = undefined;
    }
    const file = path.resolve(config.statsFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const accounts: Record<string, unknown> = {};
    for (const acc of this.accounts) {
      const r = this.rt(acc.id);
      accounts[acc.id] = {
        success: r.success,
        failure: r.failure,
        lastError: r.lastError,
        lastSuccessAt: r.lastSuccessAt,
        lastFailureAt: r.lastFailureAt,
      };
    }
    fs.writeFileSync(file, JSON.stringify({ accounts }, null, 2) + "\n");
  }

  private scheduleStatsSave() {
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = undefined;
      this.saveStats();
    }, 1000);
    this.statsTimer.unref?.();
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
      r = { cooldownUntil: {}, lastUsed: 0, success: 0, failure: 0 };
      this.runtime.set(id, r);
    }
    return r;
  }

  markResult(id: string, ok: boolean, error?: string) {
    const r = this.rt(id);
    if (ok) {
      r.success += 1;
      r.lastSuccessAt = Date.now();
      this.scheduleStatsSave();
      return;
    }
    r.failure += 1;
    r.lastFailureAt = Date.now();
    r.lastError = String(error || "").slice(0, 300) || "unknown error";
    this.scheduleStatsSave();
  }

  remove(id: string) {
    this.accounts = this.accounts.filter((a) => a.id !== id);
    this.runtime.delete(id);
    this.storedStats.delete(id);
    this.inflight.delete(id);
    this.workerCursor.delete(id);
    this.resetRamp(id);
    this.saveStats();
  }

  addOrUpdate(acc: Account) {
    const idx = this.accounts.findIndex((a) => a.id === acc.id);
    const prev = this.runtime.get(acc.id) ?? this.storedStats.get(acc.id);
    if (idx >= 0) this.accounts[idx] = acc;
    else this.accounts.push(acc);
    // New cookies clear cooldowns and auth failures, but keep the counters.
    this.runtime.set(acc.id, {
      cooldownUntil: {},
      lastUsed: 0,
      authFailed: false,
      success: prev?.success ?? 0,
      failure: prev?.failure ?? 0,
      lastError: prev?.lastError,
      lastSuccessAt: prev?.lastSuccessAt,
      lastFailureAt: prev?.lastFailureAt,
    });
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

  /**
   * The cold start is the dangerous moment: several freshly opened tabs firing
   * ogiZ0b within the same second look like automation and get the account
   * flagged. Requests are serialised per account until every worker tab has
   * completed one generation, which is what a human-paced warmup does.
   */
  rampActive(id: string) {
    return (this.rampDone.get(id)?.size ?? 0) < Math.max(1, config.workersPerAccount);
  }

  markRampWarm(id: string, workerIndex: number) {
    const warm = this.rampDone.get(id) ?? new Set<number>();
    if (warm.has(workerIndex)) return;
    warm.add(workerIndex);
    this.rampDone.set(id, warm);
    const workers = Math.max(1, config.workersPerAccount);
    if (warm.size >= workers) console.log("warmup ramp complete for " + id + " (" + workers + " tabs); concurrency enabled");
  }

  /** A freshly created tab is cold again and has to warm up on its own. */
  markRampCold(id: string, workerIndex: number) {
    this.rampDone.get(id)?.delete(workerIndex);
  }

  resetRamp(id: string) {
    this.rampDone.delete(id);
  }

  resetRamps() {
    this.rampDone.clear();
    this.rampChains.clear();
  }

  /** FIFO slot per account while ramping; a no-op once the ramp is complete. */
  async rampWait(id: string): Promise<() => void> {
    if (!this.rampActive(id)) return () => {};
    const prev = this.rampChains.get(id) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    this.rampChains.set(id, prev.then(() => held));
    await prev;
    return release;
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
    const data = this.accounts.map((a) => ({
      id: a.id,
      email: a.email,
      disabled: a.disabled,
      cookies: a.cookies,
    }));
    fs.writeFileSync(file, JSON.stringify({ accounts: data }, null, 2) + "\n");
  }

  reload() {
    this.load();
  }

  /**
   * Google rotates __Secure-1PSIDTS / __Secure-3PSIDTS through Set-Cookie on
   * every response. A static jar is rejected once that rotation is missed, so
   * fold the new values back into the account and persist them.
   */
  applySetCookies(id: string, lines: string[] | string | undefined, fallbackDomain = ".google.com") {
    if (!lines) return;
    const list = Array.isArray(lines) ? lines : [lines];
    const acc = this.accounts.find((a) => a.id === id);
    if (!acc) return;
    let changed = false;
    for (const line of list) {
      const c = parseSetCookie(line, fallbackDomain);
      if (!c) continue;
      const idx = acc.cookies.findIndex((x) => x.name === c.name && x.domain === c.domain);
      if (c.remove) {
        if (idx >= 0) {
          acc.cookies.splice(idx, 1);
          changed = true;
        }
        continue;
      }
      if (idx >= 0) {
        if (acc.cookies[idx].value !== c.value) {
          acc.cookies[idx].value = c.value;
          changed = true;
        }
        acc.cookies[idx].path = c.path;
      } else {
        acc.cookies.push({ name: c.name, value: c.value, domain: c.domain, path: c.path });
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 2000);
    this.saveTimer.unref?.();
  }

  replaceCookies(id: string, cookies: CookieRecord[]) {
    const acc = this.accounts.find((a) => a.id === id);
    if (acc) acc.cookies = cookies;
  }

  snapshot() {
    const now = Date.now();
    return this.accounts.map((a) => {
      const r = this.rt(a.id);
      const cooling = Object.entries(r.cooldownUntil).filter(([, t]) => (t || 0) > now);
      return {
        id: a.id,
        email: a.email,
        disabled: !!a.disabled,
        authFailed: !!r.authFailed,
        inflight: this.inflight.get(a.id) || 0,
        cookies: a.cookies.length,
        success: r.success,
        failure: r.failure,
        lastError: r.lastError ?? null,
        lastSuccessAt: r.lastSuccessAt ?? null,
        lastFailureAt: r.lastFailureAt ?? null,
        cooldownUntil: Object.fromEntries(cooling),
      };
    });
  }
}

export const accountPool = new AccountPool();