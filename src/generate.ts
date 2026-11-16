import { Session, RpcError } from "./google/session.js";
import { FlowClient, downloadImage } from "./flow/client.js";
import { accountPool, type Account } from "./accounts.js";
import { findModel, type ModelDef } from "./models.js";
import { config } from "./config.js";
import { Semaphore } from "./semaphore.js";

/** Global gate: one permit per upstream generation. */
export const gate = new Semaphore(config.maxConcurrency);

export type GeneratedImage = {
  buffer: Buffer;
  contentType: string;
  width?: number;
  height?: number;
  mediaId?: string | null;
};

export type GenerateOptions = {
  prompt: string;
  modelName?: string;
  n?: number;
  aspect?: string;
  upscale2k?: boolean;
  images?: { data: Buffer; mime: string; filename: string }[];
};

const QUOTA_COOLDOWN_MS = 6 * 3600_000;

/** Promote an agent output; the media becomes addressable a moment later. */
async function saveOnce(client: FlowClient, projectId: string, mediaId: string, attempts = 30): Promise<boolean> {
  let last = "";
  for (let i = 0; i < attempts; i++) {
    try {
      await client.saveAgentMedia(projectId, mediaId);
      return true;
    } catch (e: any) {
      last = String(e?.message || e).slice(0, 300);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.error("saveAgentMedia gave up: " + last);
  return false;
}

function projectTitle() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return mm + "月 " + dd + " 日 - " + hh + ":" + mi;
}

async function runOnAccount(acc: Account, workerIndex: number, model: ModelDef, opts: GenerateOptions): Promise<GeneratedImage[]> {
  const session = new Session(acc, workerIndex);
  const client = new FlowClient(session);
  const projectId = await client.createProject(projectTitle());
  const n = Math.max(1, Math.min(4, opts.n || 1));
  const aspect = opts.aspect || "16:9";
  try {
    await client.setImageDefaults(projectId, model, 1, aspect);

    let refIds: string[] = [];
    if (opts.images?.length) {
      for (const img of opts.images) {
        const token = await session.mint("IMAGE_GENERATION");
        refIds.push(await client.uploadImage(projectId, img.data, img.mime, img.filename, token));
      }
    }

    const out: GeneratedImage[] = [];

    // The direct generation RPC always renders 16:9. For any other ratio we go
    // through the Flow agent, which reads the ratio hint from the prompt.
    // The agent path returns media ids only, so bytes come from the 2K upscaler.
    // With a live Chrome attached we can use the agent for everything: it is the
    // only path that honours the requested aspect ratio, for both text-to-image
    // and edits. Without it we fall back to the direct RPC (16:9 only).
    const useAgent = config.agentMode;

    if (useAgent) {
      for (let i = 0; i < n; i++) {
        let saved = false;
        let mediaId = "";
        let failure = "";
        // A stream id that never becomes savable is a dead end: the turn's media
        // was dropped upstream. Ask the agent for a fresh image instead of
        // burning the whole request on as29s retries for the same id.
        for (let attempt = 0; attempt < 2 && !saved; attempt++) {
          const ids = refIds.length
            ? await client.agentEdit({ projectId, prompt: opts.prompt, model, aspect, mediaIds: refIds })
            : await client.agentGenerate({ projectId, prompt: opts.prompt, model, aspect });
          // Fresh ids may include the reference images we just uploaded; only the
          // agent's own output can be promoted with as29s.
          const candidates = ids.filter((id) => !refIds.includes(id));
          const pool = candidates.length ? candidates : ids;
          if (!pool.length) {
            failure = "agent generation returned no media";
            continue;
          }
          const preferred = pool[Math.min(i, pool.length - 1)];
          for (const candidate of [preferred, ...pool.filter((id) => id !== preferred)]) {
            if (await saveOnce(client, projectId, candidate)) {
              mediaId = candidate;
              saved = true;
              break;
            }
          }
          if (!saved) failure = "agent media was not savable (" + pool.join(",") + ")";
        }
        if (!saved) throw new Error(failure || "agent generation returned no media");

        const t2 = await session.mint("IMAGE_GENERATION");
        const buffer = await client.upscale2k(projectId, mediaId, t2);
        out.push({ buffer, contentType: "image/jpeg", mediaId });
      }
      return out;
    }

    if (!refIds.length && aspect !== "16:9") {
      for (let i = 0; i < n; i++) {
        const ids = await client.agentGenerate({ projectId, prompt: opts.prompt, model, aspect });
        const mediaId = ids[Math.min(i, ids.length - 1)];
        if (!mediaId) throw new Error("agent generation returned no media");

        if (!(await saveOnce(client, projectId, mediaId))) {
          throw new Error("agent media was not savable (media id " + mediaId + ")");
        }
        const t2 = await session.mint("IMAGE_GENERATION");
        const buffer = await client.upscale2k(projectId, mediaId, t2);
        out.push({ buffer, contentType: "image/jpeg", mediaId });
      }
      return out;
    }

    for (let i = 0; i < n; i++) {
      const token = await session.mint("IMAGE_GENERATION");
      const gen = await client.generate({
        projectId,
        prompt: opts.prompt,
        model,
        token,
        refs: refIds.length ? refIds : undefined,
      });

      let buffer: Buffer | null = null;
      let contentType = "image/png";
      if (gen.url) {
        const dl = await downloadImage(gen.url);
        buffer = dl.data;
        contentType = dl.contentType.startsWith("image/") ? dl.contentType : "image/png";
      }

      if (opts.upscale2k && gen.mediaId) {
        const t2 = await session.mint("IMAGE_GENERATION");
        buffer = await client.upscale2k(projectId, gen.mediaId, t2);
        contentType = "image/jpeg";
      }

      if (!buffer) throw new Error("generation returned no image");
      out.push({ buffer, contentType, width: gen.width, height: gen.height, mediaId: gen.mediaId });
    }
    return out;
  } finally {
    // best effort cleanup: removes the project, its images and conversations
    await client.deleteProject(projectId).catch(() => {});
  }
}

export async function generateImages(opts: GenerateOptions): Promise<GeneratedImage[]> {
  const requested = Math.max(1, Math.min(4, opts.n || 1));

  // n > 1: fan out into independent requests so each one gets its own account
  // worker (and its own 2K upscale) instead of running back to back.
  if (requested > 1) {
    const results = await Promise.allSettled(
      Array.from({ length: requested }, () => generateImages({ ...opts, n: 1 }))
    );
    const ok = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    if (ok.length) return ok;
    throw (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason;
  }

  const release = await gate.acquire(config.queueTimeoutMs);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("generation timed out")), config.generateTimeoutMs + 30_000);
  });
  try {
    return await Promise.race([runOnce(opts), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }
}

async function runOnce(opts: GenerateOptions): Promise<GeneratedImage[]> {
  const model = findModel(opts.modelName);
  const tried = new Set<string>();
  let lastErr: unknown;

  for (let attempt = 0; attempt < Math.max(1, accountPool.count()); attempt++) {
    const picked = accountPool.acquire(model.rpcModel);
    if (!picked) break;
    const { account: acc, workerIndex } = picked;
    if (tried.has(acc.id)) {
      accountPool.release(acc.id);
      break;
    }
    tried.add(acc.id);
    try {
      const images = await runOnAccount(acc, workerIndex, model, opts);
      accountPool.markAuthFailed(acc.id, false);
      return images;
    } catch (e) {
      lastErr = e;
      if (e instanceof RpcError) {
        const code = e.code;
        if (/QUOTA/.test(code)) {
          accountPool.coolDown(acc.id, model.rpcModel, QUOTA_COOLDOWN_MS);
          continue;
        }
        if (/AUTH|UNAUTHENTICATED|CREDENTIALS|SESSION/.test(code) || /401|403/.test(String(e.status))) {
          accountPool.markAuthFailed(acc.id, true);
          continue;
        }
      }
      const msg = String((e as Error)?.message || e);
      if (/AUTH_REQUIRED|BOOT_FAILED|CREDENTIALS|UNAUTHENTICATED/.test(msg)) {
        accountPool.markAuthFailed(acc.id, true);
        continue;
      }
      throw e;
    } finally {
      accountPool.release(acc.id);
    }
  }
  throw lastErr ?? new Error("no available account");
}