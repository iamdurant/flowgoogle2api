import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export type LogEntry = {
  id: string;
  at: number;
  ms: number;
  ok: boolean;
  model: string;
  aspect: string;
  prompt: string;
  kind?: "generate" | "edit" | "chat";
  error?: string;
  account?: string;
  format?: string;
  bytes?: number;
};

const MAX_ENTRIES = 5000;

class LogStore {
  private items: LogEntry[] = [];
  private seq = 0;

  load() {
    const file = path.resolve(config.logsFile);
    if (!fs.existsSync(file)) return;
    try {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      this.items = lines
        .map((line) => {
          try {
            return JSON.parse(line) as LogEntry;
          } catch {
            return null;
          }
        })
        .filter((x): x is LogEntry => Boolean(x))
        .slice(-MAX_ENTRIES);
      const last = this.items[this.items.length - 1];
      if (last) this.seq = Number(String(last.id).split("-")[1]) || 0;
    } catch {
      /* a broken log file must not stop the service */
    }
  }

  add(entry: Omit<LogEntry, "id">) {
    const item: LogEntry = { id: Date.now().toString(36) + "-" + (++this.seq).toString(36), ...entry };
    this.items.push(item);
    if (this.items.length > MAX_ENTRIES) this.items.splice(0, this.items.length - MAX_ENTRIES);
    try {
      const file = path.resolve(config.logsFile);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFile(file, JSON.stringify(item) + "\n", () => {});
    } catch {
      /* logging must never break a request */
    }
    return item;
  }

  page(page: number, size: number) {
    const perPage = Math.min(100, Math.max(1, size || 20));
    const total = this.items.length;
    const pages = Math.max(1, Math.ceil(total / perPage));
    const p = Math.min(Math.max(1, page || 1), pages);
    const end = total - (p - 1) * perPage;
    const start = Math.max(0, end - perPage);
    return { items: this.items.slice(start, end).reverse(), page: p, pages, total };
  }

  remove(ids: string[]) {
    const set = new Set(ids);
    const before = this.items.length;
    this.items = this.items.filter((i) => !set.has(i.id));
    const removed = before - this.items.length;
    if (removed) this.rewrite();
    return removed;
  }

  clear() {
    this.items = [];
    this.rewrite();
  }

  private rewrite() {
    try {
      const file = path.resolve(config.logsFile);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, this.items.map((i) => JSON.stringify(i)).join("\n") + (this.items.length ? "\n" : ""));
    } catch {
      /* ignore */
    }
  }
}

export const logStore = new LogStore();
