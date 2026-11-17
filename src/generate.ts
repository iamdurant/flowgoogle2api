import { Session, RpcError } from "./google/session.js";
import { FlowClient, downloadImage } from "./flow/client.js";
import { accountPool, type Account } from "./accounts.js";
import { findModel, ASPECT_ENUM, type ModelDef } from "./models.js";
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
  account?: string;
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

/**
 * One long-lived project per account, shared by all worker tabs — this mirrors
 * the web client, where several tabs generate inside the same open project.
 * Creating and deleting a project for every API call produced bursts of RPCs
 * that Google's risk control treated as unusual activity. Media is archived
 * after the bytes are fetched, so the project does not grow.
 */
type PooledProject = { id: string; createdAt: number };
const POOLED_PROJECT_TTL_MS = 12 * 3600_000;
const pooledProjects = new Map<string, PooledProject>();
const pooledCreating = new Map<string, Promise<string>>();

function poolKey(acc: Account) {
  return acc.id;
}

async function generationProject(client: FlowClient, acc: Account): Promise<string> {
  const key = poolKey(acc);
  const cached = pooledProjects.get(key);
  if (cached) {
    if (Date.now() - cached.createdAt < POOLED_PROJECT_TTL_MS) return cached.id;
    // recycle a stale project so one crashed worker cannot pin it forever
    pooledProjects.delete(key);
    client.deleteProject(cached.id).catch(() => {});
  }
  const pending = pooledCreating.get(key);
  if (pending) return pending;
  const creating = client.createProject(projectTitle()).then((id) => {
    pooledProjects.set(key, { id, createdAt: Date.now() });
    return id;
  });
  pooledCreating.set(key, creating);
  try {
    return await creating;
  } finally {
    pooledCreating.delete(key);
  }
}

function forgetProject(acc: Account) {
  pooledProjects.delete(poolKey(acc));
}

/**
 * Parallel tabs are fine (the web client does four), but requests that start
 * in the same millisecond look like automation. Space starts per account.
 */
const START_GAP_MS = 400;
const lastStartAt = new Map<string, number>();
const paceChain = new Map<string, Promise<void>>();

function paceAccount(accId: string): Promise<void> {
  const prev = paceChain.get(accId) ?? Promise.resolve();
  const next = prev.then(async () => {
    const gap = START_GAP_MS + Math.floor(Math.random() * 400);
    const wait = (lastStartAt.get(accId) || 0) + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStartAt.set(accId, Date.now());
  });
  paceChain.set(accId, next);
  return next;
}

async function runOnAccount(acc: Account, workerIndex: number, model: ModelDef, opts: GenerateOptions): Promise<GeneratedImage[]> {
  const session = new Session(acc, workerIndex);
  const client = new FlowClient(session);
  const projectId = await generationProject(client, acc);
  const n = Math.max(1, Math.min(4, opts.n || 1));
  const aspect = opts.aspect || "16:9";
  const discard: string[] = [];
  try {
    await client.setImageDefaults(projectId, model, 1, aspect);

    let refIds: string[] = [];
    if (opts.images?.length) {
      for (const img of opts.images) {
        const token = await session.mint("IMAGE_GENERATION");
        refIds.push(await client.uploadImage(projectId, img.data, img.mime, img.filename, token));
      }
      discard.push(...refIds);
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
        out.push({ buffer, contentType: "image/jpeg", mediaId, account: acc.id });
        discard.push(mediaId);
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
        aspect: ASPECT_ENUM[aspect] ?? ASPECT_ENUM["16:9"],
      });

      let buffer: Buffer | null = null;
      let contentType = "image/png";
      if (gen.url) {
        const dl = await downloadImage(gen.url);
        buffer = dl.data;
        contentType = dl.contentType.startsWith("image/") ? dl.contentType : "image/png";
      }

      if (opts.upscale2k && gen.mediaId) {
        // The 2K pass is a second upstream call and is the first RPC Google's
        // risk control rejects under load. Space it from the generation call
        // instead of firing back to back; retry once, then keep the 1K image.
        await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 400)));
        for (let attempt = 0; attempt < 2 && buffer; attempt++) {
          try {
            const t2 = await session.mint("IMAGE_GENERATION");
            const hi = await client.upscale2k(projectId, gen.mediaId, t2);
            buffer = hi;
            contentType = "image/jpeg";
            break;
          } catch (e: any) {
            console.error("2k upscale failed (attempt " + (attempt + 1) + "): " + String(e?.message || e).slice(0, 200));
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      }

      if (!buffer) throw new Error("generation returned no image");
      out.push({ buffer, contentType, width: gen.width, height: gen.height, mediaId: gen.mediaId, account: acc.id });
      if (gen.mediaId) discard.push(gen.mediaId);
    }
    return out;
  } finally {
    // The project is reused; only the media produced (or uploaded) by this
    // request is archived so it disappears from the account's project grid.
    for (const id of discard) await client.archiveMedia(projectId, id).catch(() => {});
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
  try {
    return await runOnce(opts);
  } finally {
    release();
  }
}

/** Budget covers one generation, not the time a request waits in the warmup queue. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("generation timed out")), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
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
    let rampRelease: () => void = () => {};
    try {
      // Until every tab of this account has produced one image, serve requests
      // one at a time so the freshly opened pages never fire together.
      rampRelease = await accountPool.rampWait(acc.id);
      await paceAccount(acc.id);
      const images = await withTimeout(runOnAccount(acc, workerIndex, model, opts), config.generateTimeoutMs + 30_000);
      accountPool.markAuthFailed(acc.id, false);
      accountPool.markRampWarm(acc.id, workerIndex);
      accountPool.markResult(acc.id, true);
      return images;
    } catch (e) {
      lastErr = e;
      (e as any).account = acc.id;
      accountPool.markResult(acc.id, false, String((e as Error)?.message || e));
      if (e instanceof RpcError) {
        const code = e.code;
        if (/QUOTA/.test(code)) {
          accountPool.coolDown(acc.id, model.rpcModel, QUOTA_COOLDOWN_MS);
          continue;
        }
        if (/UNUSUAL_ACTIVITY/.test(code)) {
          console.error("risk control flagged " + acc.id + " on worker " + workerIndex);
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
      // A pooled project can disappear (deleted elsewhere); rebuild on next try.
      if (/project/i.test(msg)) forgetProject(acc);
      throw e;
    } finally {
      rampRelease();
      accountPool.release(acc.id);
    }
  }
  throw lastErr ?? new Error("no available account");
}