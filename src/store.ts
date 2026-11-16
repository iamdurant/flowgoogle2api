import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

type Entry = { file: string; expires: number; contentType: string };

const entries = new Map<string, Entry>();

function ensureDir() {
  fs.mkdirSync(path.resolve(config.imageDir), { recursive: true });
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function saveImage(data: Buffer, contentType: string): { id: string; file: string } {
  ensureDir();
  const id = randomUUID();
  const ext = EXT[contentType] || "png";
  const file = path.resolve(config.imageDir, id + "." + ext);
  fs.writeFileSync(file, data);
  entries.set(id, { file, expires: Date.now() + config.imageTtlMs, contentType });
  return { id, file };
}

export function getImage(id: string): Entry | null {
  const e = entries.get(id);
  if (!e) return null;
  if (e.expires < Date.now()) {
    entries.delete(id);
    fs.existsSync(e.file) && fs.unlinkSync(e.file);
    return null;
  }
  return e;
}

export function publicUrl(id: string, ext: string): string {
  const base = config.publicBaseUrl || "http://127.0.0.1:" + config.port;
  return base.replace(/\/$/, "") + "/images/" + id + "." + ext;
}

/** Remove images left on disk by a previous run (they are not in the map). */
export function sweepDisk() {
  ensureDir();
  const dir = path.resolve(config.imageDir);
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile() && now - st.mtimeMs > config.imageTtlMs) fs.unlinkSync(file);
    } catch {}
  }
}

export function sweeper() {
  const tick = () => {
    const now = Date.now();
    for (const [id, e] of entries) {
      if (e.expires >= now) continue;
      entries.delete(id);
      try {
        fs.unlinkSync(e.file);
      } catch {}
    }
  };
  setInterval(tick, 60_000).unref();
}