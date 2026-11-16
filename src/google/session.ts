import { browserHub } from "./browser.js";
import type { Account } from "../accounts.js";

export const RECAPTCHA_SITE_KEY = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV";

export class RpcError extends Error {
  status: unknown;
  details: unknown;
  rpcid?: string;
  constructor(status: unknown, details: unknown, rpcid?: string) {
    const text = JSON.stringify(details ?? status);
    super("flow rpc error" + (rpcid ? " [" + rpcid + "]" : "") + ": " + text.slice(0, 400));
    this.status = status;
    this.details = details;
    this.rpcid = rpcid;
  }
  get code(): string {
    const s = JSON.stringify(this.details ?? "");
    const m = s.match(/PUBLIC_ERROR_[A-Z_]+/);
    return m ? m[0] : "";
  }
}

export type BootInfo = { at: string; sid: string; bl: string; fetchedAt: number };

/**
 * One account's upstream session. All requests run inside that account's browser
 * page (see BrowserHub) so Google's rotating auth cookies stay consistent.
 */
export class Session {
  account: Account;
  workerIndex: number;

  constructor(account: Account, workerIndex = 0) {
    this.account = account;
    this.workerIndex = workerIndex;
  }

  async boot(force = false): Promise<BootInfo> {
    return browserHub.boot(this.account, this.workerIndex, force);
  }

  async rpc(rpcid: string, inner: unknown, sourcePath = "/"): Promise<any> {
    const text = await browserHub.rpc(this.account, this.workerIndex, rpcid, inner, sourcePath);
    return parseBatchExecute(text, rpcid);
  }

  private async workerProject(): Promise<string> {
    const res = await this.rpc("jHPbke", ["projects/*", [null, ["minter"]], [null, 22]], "/");
    const pid = Array.isArray(res) ? res[0] : null;
    if (typeof pid !== "string") throw new Error("failed to create worker project");
    return pid;
  }

  async mint(action: "IMAGE_GENERATION" | "CHAT_GENERATION" = "IMAGE_GENERATION"): Promise<string> {
    await browserHub.ensureRecaptcha(this.account, this.workerIndex, () => this.workerProject());
    return browserHub.mint(this.account, this.workerIndex, RECAPTCHA_SITE_KEY, action);
  }
}

export function parseBatchExecute(text: string, rpcid: string): any {
  // Response shape: ")]}'\n\n<len>\n<json>\n<len>\n<json>..." where <len> may be
  // counted in characters or bytes, so scan for balanced JSON arrays instead of
  // trusting the prefix length.
  const frames: any[] = [];
  let i = 0;
  while (i < text.length) {
    const start = text.indexOf("[[", i);
    if (start === -1) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = start;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === "[") {
        depth++;
      } else if (ch === "]") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    const chunk = text.slice(start, j);
    try {
      frames.push(JSON.parse(chunk));
    } catch {
      /* not a frame */
    }
    i = j;
  }

  for (const frame of frames) {
    if (!Array.isArray(frame)) continue;
    for (const row of frame) {
      if (!Array.isArray(row) || row[0] !== "wrb.fr" || row[1] !== rpcid) continue;
      if (row[2] == null) throw new RpcError(row[5] ?? null, row[5] ?? null, rpcid);
      return JSON.parse(row[2]);
    }
  }
  throw new RpcError("NO_RESULT", { raw: text.slice(0, 300) }, rpcid);
}