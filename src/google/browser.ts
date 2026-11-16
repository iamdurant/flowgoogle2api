import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { config } from "../config.js";
import type { Account, CookieRecord } from "../accounts.js";

export type BootInfo = { at: string; sid: string; bl: string; fetchedAt: number };

type Worker = {
  page: Page;
  queue: Promise<unknown>;
  boot?: BootInfo;
  workerProject?: string;
  lastUsed: number;
};

type AccountSlot = {
  context: BrowserContext;
  workers: Worker[];
};

/**
 * All flow.google.com traffic runs inside the account's browser session: one
 * context per account, several tabs ("workers") so concurrent requests do not
 * serialise behind each other.
 */
export class BrowserHub {
  private browser?: Browser;
  private slots = new Map<string, AccountSlot>();
  private opening = new Map<string, Promise<AccountSlot>>();
  private openingWorkers = new Map<string, Promise<Worker>>();
  private maxAccounts = Math.max(1, Number(process.env.MAX_BROWSER_SLOTS || 3));

  private async launch() {
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (config.chromeCdpUrl) {
      try {
        this.browser = await chromium.connectOverCDP(config.chromeCdpUrl);
        this.watchDisconnect(this.browser);
        return this.browser;
      } catch {
        /* fall through to a locally launched browser */
      }
    }
    const args = ["--disable-blink-features=AutomationControlled", "--lang=zh-CN"];
    if (process.env.CHROME_NO_SANDBOX !== "false") args.push("--no-sandbox");
    this.browser = await chromium.launch({
      channel: "chrome",
      headless: config.chromeHeadless,
      args,
    });
    this.watchDisconnect(this.browser);
    return this.browser;
  }

  /** A crashed Chrome must not leave the service permanently broken. */
  private watchDisconnect(browser: Browser) {
    browser.on("disconnected", () => {
      if (this.browser === browser) {
        this.browser = undefined;
        this.slots.clear();
        this.opening.clear();
        this.openingWorkers.clear();
      }
    });
  }

  private async open(account: Account): Promise<AccountSlot> {
    // Single-flight: concurrent first requests must not create two contexts.
    const pending = this.opening.get(account.id);
    if (pending) return pending;
    const creating = this.createSlot(account).finally(() => this.opening.delete(account.id));
    this.opening.set(account.id, creating);
    return creating;
  }

  private async createSlot(account: Account): Promise<AccountSlot> {
    // One Chrome process for every account: each account gets its own isolated
    // browser context (cookies included), which is what keeps memory low.
    const browser = await this.launch();
    // Attached Chrome (CHROME_CDP_URL) is a real logged-in profile: its default
    // context already owns the live session cookies, and copying the cookie jar
    // into a fresh incognito context loses Google's device-bound session.
    const context = config.chromeCdpUrl
      ? browser.contexts()[0] ?? (await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 900 } }))
      : await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 900 } });
    if (!config.chromeCdpUrl) {
      const cookies = account.cookies
        .filter((c) => c.name && c.value)
        .map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain || ".google.com",
          path: c.path || "/",
          secure: true,
          sameSite: "None" as const,
        }));
      for (const c of cookies) await context.addCookies([c as any]).catch(() => {});
    }
    const slot: AccountSlot = { context, workers: [] };
    this.slots.set(account.id, slot);
    await this.evictIfNeeded(account.id);
    return slot;
  }

  private async evictIfNeeded(keep: string) {
    if (this.slots.size <= this.maxAccounts) return;
    const entries = [...this.slots.entries()].filter(([id]) => id !== keep);
    while (this.slots.size > this.maxAccounts && entries.length) {
      const [id, slot] = entries.shift()!;
      this.slots.delete(id);
      await slot.context.close().catch(() => {});
    }
  }

  private async workersFor(account: Account): Promise<Worker[]> {
    let slot = this.slots.get(account.id);
    if (!slot) slot = await this.open(account);
    return slot.workers;
  }

  /** Create (or reuse) the worker tab with the given index. */
  private async worker(account: Account, index: number): Promise<Worker> {
    const existing = this.slots.get(account.id)?.workers[index];
    if (existing && !existing.page.isClosed()) {
      existing.lastUsed = Date.now();
      return existing;
    }
    // Single-flight per (account, worker): two concurrent first calls must not
    // create two tabs for the same slot.
    const key = account.id + ":" + index;
    const pending = this.openingWorkers.get(key);
    if (pending) return pending;
    const creating = this.createWorker(account, index).finally(() => this.openingWorkers.delete(key));
    this.openingWorkers.set(key, creating);
    return creating;
  }

  private async createWorker(account: Account, index: number): Promise<Worker> {
    const slot = this.slots.get(account.id) || (await this.open(account));
    const existing = slot.workers[index];
    if (existing && !existing.page.isClosed()) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const page = await slot.context.newPage();
    await page.goto("https://flow.google.com/", { waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => {});
    await page.evaluate("(() => { sessionStorage.setItem('flowbot', '1'); })()").catch(() => {});
    const worker: Worker = { page, queue: Promise.resolve(), lastUsed: Date.now() };
    slot.workers[index] = worker;
    return worker;
  }

  private async run<T>(account: Account, index: number, fn: (w: Worker) => Promise<T>): Promise<T> {
    const worker = await this.worker(account, index);
    const p = worker.queue.then(() => fn(worker));
    worker.queue = p.catch(() => {});
    worker.lastUsed = Date.now();
    return p;
  }

  /** Close the tabs this service opened (marked with the flowbot session flag). */
  async closeBotTabs() {
    if (!config.chromeCdpUrl) return;
    try {
      const browser = await chromium.connectOverCDP(config.chromeCdpUrl);
      for (const ctx of browser.contexts()) {
        for (const page of ctx.pages()) {
          if (!page.url().startsWith("https://flow.google.com")) continue;
          const ours = await page.evaluate("(() => sessionStorage.getItem('flowbot') === '1')()").catch(() => false);
          if (ours) await page.close().catch(() => {});
        }
      }
    } catch {
      /* chrome gone */
    }
  }
  async boot(account: Account, index: number, force = false): Promise<BootInfo> {
    return this.run(account, index, async (w) => {
      if (!force && w.boot && Date.now() - w.boot.fetchedAt < 30 * 60_000) return w.boot;
      await w.page.goto("https://flow.google.com/", { waitUntil: "domcontentloaded", timeout: 90_000 });
      const html: string = await w.page.evaluate("(async () => await (await fetch('/', { credentials: 'include' })).text())()");
      const at = html.match(/SNlM0e["']?\s*:\s*\\?"([^"\\]+)/)?.[1];
      const sid = html.match(/FdrFJe["']?\s*:\s*\\?"(-?\d+)/)?.[1];
      const bl = html.match(/cfb2h["']?\s*:\s*\\?"([^"\\]+)/)?.[1];
      if (!at || !sid || !bl) {
        throw new Error("AUTH_REQUIRED: account " + account.id + " is logged out (no SNlM0e); re-run the login script for this account");
      }
      w.boot = { at, sid, bl, fetchedAt: Date.now() };
      return w.boot;
    });
  }

  async rpc(account: Account, index: number, rpcid: string, inner: unknown, sourcePath = "/"): Promise<string> {
    const boot = await this.boot(account, index);
    const freq = JSON.stringify([[[rpcid, JSON.stringify(inner), null, "generic"]]]);
    const url =
      "/_/AiSandboxAngularFrontend/data/batchexecute" +
      "?rpcids=" + rpcid +
      "&source-path=" + encodeURIComponent(sourcePath) +
      "&bl=" + encodeURIComponent(boot.bl) +
      "&f.sid=" + boot.sid +
      "&hl=zh-CN&_reqid=" + (100000 + Math.floor(Math.random() * 800000)) +
      "&rt=c";
    const body = "f.req=" + encodeURIComponent(freq) + "&at=" + encodeURIComponent(boot.at);
    return this.run(account, index, async (w) => {
      const script =
        "(async () => { const res = await fetch(" + JSON.stringify(url) + ", { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body: " + JSON.stringify(body) + " }); return await res.text(); })()";
      return String(await w.page.evaluate(script));
    });
  }

  /** Keep a project page open so reCAPTCHA Enterprise is loaded and ready. */
  async ensureRecaptcha(account: Account, index: number, createProject: () => Promise<string>): Promise<string | undefined> {
    const ready = await this.run(account, index, async (w) => {
      const ok = await w.page
        .evaluate("(() => { const g = window.grecaptcha; return !!(g && g.enterprise && typeof g.enterprise.execute === 'function'); })()")
        .catch(() => false);
      return Boolean(ok);
    });
    if (ready) {
      const slot = this.slots.get(account.id);
      return slot?.workers[index]?.workerProject;
    }
    const worker = await this.worker(account, index);
    let pid = worker.workerProject;
    if (!pid) {
      pid = await createProject();
      worker.workerProject = pid;
    }
    await this.run(account, index, async (w) => {
      await w.page.goto("https://flow.google.com/project/" + pid, { waitUntil: "domcontentloaded", timeout: 90_000 });
      for (let i = 0; i < 90; i++) {
        const ok = await w.page
          .evaluate("(() => { const g = window.grecaptcha; return !!(g && g.enterprise && typeof g.enterprise.execute === 'function'); })()")
          .catch(() => false);
        if (ok) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error("reCAPTCHA did not load on the project page");
    });
    return pid;
  }

  async mint(account: Account, index: number, siteKey: string, action: string): Promise<string> {
    return this.run(account, index, async (w) => {
      const script =
        "(async () => await window.grecaptcha.enterprise.execute(" + JSON.stringify(siteKey) + ", { action: " + JSON.stringify(action) + " }))()";
      const token = await w.page.evaluate(script);
      if (!token) throw new Error("empty recaptcha token");
      return String(token);
    });
  }

  /**
   * Send a message through the Flow agent and wait for the produced image id.
   * The whole exchange runs inside one worker slot: the per-worker queue stays
   * locked until the image id arrives, so two concurrent requests can never read
   * each other's stream (window.__flowStream is per tab).
   */
  async agentRun(
    account: Account,
    index: number,
    projectId: string,
    parts: unknown,
    token: string,
    exclude: string[],
    timeoutMs: number
  ): Promise<string | null> {
    const html: string = await this.run(account, index, async (w) =>
      String(await w.page.evaluate("(async () => await (await fetch('/', { credentials: 'include' })).text())()"))
    );
    const idx = html.lastIndexOf("y83d5b");
    let serverToken = "";
    if (idx >= 0) {
      const seg = html.slice(idx, idx + 200);
      const m = seg.match(/:\s*\\?"([^"\\]{8,})/);
      serverToken = m ? m[1].split("\\u003d").join("=") : "";
    }

    const args = JSON.stringify({ pid: projectId, parts, tok: token, st: serverToken, exclude, timeoutMs });
    const page = [
      "(async () => {",
      "  const A = " + args + ";",
      "  window.__flowStream = '';",
      "  const cv = (n) => { const m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')); return m ? m[1] : ''; };",
      "  const sha1 = async (s) => { const b = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)); return Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join(''); };",
      "  const ts = Math.floor(Date.now() / 1000);",
      "  const sap = cv('SAPISID');",
      "  const h = await sha1(ts + ' ' + sap + ' https://flow.google.com');",
      "  const auth = 'SAPISIDHASH ' + ts + '_' + h + ' SAPISID1PHASH ' + ts + '_' + h + ' SAPISID3PHASH ' + ts + '_' + h;",
      "  const nl = String.fromCharCode(10);",
      "  const hdr = (sap ? 'Authorization:' + auth + nl : '') + 'X-Goog-Api-Key:AIzaSyDSjGxWlo68HcGt6mbaIq9YbkKhFQnt3sk' + nl + 'X-Goog-AuthUser:0' + nl + 'X-Server-Token:' + A.st + nl + 'X-WebChannel-Content-Type:application/json+protobuf';",
      "  const base = 'https://aisandbox-pa-webchannel.clients6.google.com/v1/flowCreationAgent/streamCreationAgentChat/channel';",
      "  const rid = 10000 + Math.floor(Math.random() * 80000);",
      "  const pickId = () => {",
      "    const clean = window.__flowStream.split(String.fromCharCode(92) + '\"').join('\"');",
      "    let from = 0;",
      "    while (true) {",
      "      const at = clean.indexOf('[\"image\"', from);",
      "      if (at < 0) return null;",
      "      const m = clean.slice(at, at + 240).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);",
      "      if (m && A.exclude.indexOf(m[0]) < 0) return m[0];",
      "      from = at + 8;",
      "    }",
      "  };",
      "  try {",
      "    const r1 = await fetch(base + '?VER=8&RID=' + rid + '&CVER=22&X-HTTP-Session-Id=gsessionid&$httpHeaders=' + encodeURIComponent(hdr), { method: 'POST', credentials: 'include', body: 'count=0', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });",
      "    const t1 = await r1.text();",
      "    const gs = r1.headers.get('x-http-session-id') || 'gsessionid';",
      "    const sid = (t1.match('\"c\",\"([^\"]+)\"') || [])[1];",
      "    if (!sid) return { ok: false, step: 'handshake', body: t1.slice(0, 200) };",
      "    const uuid = crypto.randomUUID();",
      "    const payload = [[uuid, [[A.parts]]], null, null, null, null, ['projects/' + A.pid, null, [A.tok, 1], null, null, 1]];",
      "    const r2 = await fetch(base + '?VER=8&gsessionid=' + gs + '&SID=' + encodeURIComponent(sid) + '&RID=' + (rid + 1) + '&AID=0&zx=' + Math.random().toString(36).slice(2) + '&t=1', {",
      "      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },",
      "      body: 'count=1&ofs=0&req0___data__=' + encodeURIComponent(JSON.stringify(payload)),",
      "    });",
      "    await r2.text();",
      "    const deadline = Date.now() + A.timeoutMs;",
      "    const ctrl = new AbortController();",
      "    setTimeout(() => ctrl.abort(), A.timeoutMs + 5000);",
      "    const streamPromise = (async () => {",
      "      try {",
      "        const r3 = await fetch(base + '?gsessionid=' + gs + '&VER=8&RID=rpc&SID=' + encodeURIComponent(sid) + '&AID=0&CI=0&TYPE=xmlhttp&zx=' + Math.random().toString(36).slice(2) + '&t=1', { credentials: 'include', signal: ctrl.signal });",
      "        const rd = r3.body.getReader();",
      "        const dec = new TextDecoder();",
      "        while (true) {",
      "          const step = await rd.read();",
      "          if (step.done) break;",
      "          window.__flowStream += dec.decode(step.value, { stream: true });",
      "        }",
      "      } catch (e) {}",
      "    })();",
      "    while (Date.now() < deadline) {",
      "      const id = pickId();",
      "      if (id) { ctrl.abort(); return { ok: true, id }; }",
      "      const s = window.__flowStream;",
      "      const q = s.indexOf('PER_MODEL_DAILY_QUOTA') >= 0 ? 'daily quota reached for this model' : (s.indexOf('wait_for_reset') >= 0 || s.indexOf('upgrade_plan') >= 0) ? 'Flow asks to switch model or wait for quota reset' : '';",
      "      if (q) { ctrl.abort(); return { ok: false, step: 'quota', body: q }; }",
      "      await new Promise((r) => setTimeout(r, 350));",
      "    }",
      "    ctrl.abort();",
      "    return { ok: true, id: null };",
      "  } catch (e) {",
      "    return { ok: false, step: 'fetch', body: String(e).slice(0, 200) };",
      "  }",
      "})()",
    ].join(String.fromCharCode(10));
    return this.run(account, index, async (w) => {
      const result: any = await w.page.evaluate(page);
      if (!result || !result.ok) {
        if (result?.step === "quota") throw new Error("upstream quota exhausted for this model (" + String(result.body) + ")");
        throw new Error("agent chat failed: " + JSON.stringify(result).slice(0, 300));
      }
      return result.id ? String(result.id) : null;
    });
  }

  /** Navigate the bot tab to a project and return the image srcs the app rendered. */
  async projectImageSrcs(account: Account, index: number, projectId: string): Promise<string[]> {
    return this.run(account, index, async (w) => {
      await w.page.goto("https://flow.google.com/project/" + projectId , {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      await new Promise((r) => setTimeout(r, 6000));
      const srcs: string[] = await w.page.evaluate(
        "(() => Array.from(document.querySelectorAll('img')).map((e) => e.src).filter((s) => s.indexOf('/asb/') > 0 || s.indexOf('flow-content') > 0))()"
      );
      return [...new Set(srcs)];
    });
  }

  /** Fetch a URL inside the logged-in page and return base64 bytes. */
  async fetchBase64(account: Account, index: number, url: string): Promise<string> {
    return this.run(account, index, async (w) => {
      const script =
        "(async () => { const r = await fetch(" + JSON.stringify(url) + ", { credentials: 'include' }); const b = await r.arrayBuffer(); const u = new Uint8Array(b); let s = ''; const CH = 0x8000; for (let i = 0; i < u.length; i += CH) { s += String.fromCharCode.apply(null, u.subarray(i, i + CH)); } return btoa(s); })()";
      return String(await w.page.evaluate(script));
    });
  }
  async exportCookies(accountId: string): Promise<CookieRecord[] | null> {
    const slot = this.slots.get(accountId);
    if (!slot) return null;
    const cookies = await slot.context.cookies();
    return cookies
      .filter((c) => c.value && /google\.com$/.test(c.domain))
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/" }));
  }

  async closeAccount(accountId: string) {
    const slot = this.slots.get(accountId);
    if (!slot) return;
    this.slots.delete(accountId);
    for (const w of slot.workers) await w.page.close().catch(() => {});
  }

  async close() {
    for (const slot of this.slots.values()) {
      for (const w of slot.workers) await w.page.close().catch(() => {});
    }
    this.slots.clear();
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
  }
}

export const browserHub = new BrowserHub();