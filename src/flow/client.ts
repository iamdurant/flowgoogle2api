import { randomUUID } from "node:crypto";
import { Session } from "../google/session.js";
import { ASPECT_ENUM, type ModelDef } from "../models.js";

const TOOL_ASPECT = 22; // constant observed in every generation context

export type GenResult = {
  mediaId: string | null;
  url: string | null;
  width?: number;
  height?: number;
};

function uuid() {
  return randomUUID().toUpperCase();
}

function projectPath(projectId: string) {
  return "/project/" + projectId;
}

function walkStrings(v: unknown, out: string[]) {
  if (Array.isArray(v)) {
    for (const x of v) walkStrings(x, out);
  } else if (typeof v === "string") {
    out.push(v);
  }
}

function collect(inner: unknown): GenResult {
  const strs: string[] = [];
  walkStrings(inner, strs);
  const url = strs.find((s) => s.startsWith("https://flow-content.google/image/")) ?? null;
  const b64 = strs.find((s) => s.length > 5000 && (s.startsWith("/9j/") || s.startsWith("iVBOR")));

  let mediaId: string | null = null;
  let width: number | undefined;
  let height: number | undefined;

  const root = inner as any[];
  const first = root?.[0];
  if (Array.isArray(first) && Array.isArray(first[0]) && typeof first[0][0] === "string") {
    mediaId = first[0][0];
  }
  if (!mediaId && url) {
    const m = url.match(/\/image\/([0-9a-f-]{36})/);
    if (m) mediaId = m[1];
  }
  // dimensions appear as [width, height]
  const flat = JSON.stringify(inner);
  const dm = flat.match(/\[(\d{3,4}),(\d{3,4})\]/);
  if (dm) {
    width = Number(dm[1]);
    height = Number(dm[2]);
  }
  return { mediaId, url, width, height };
}

export class FlowClient {
  session: Session;
  constructor(session: Session) {
    this.session = session;
  }

  async createProject(title: string): Promise<string> {
    const inner = ["projects/*", [null, [title]], [null, TOOL_ASPECT]];
    const res = await this.session.rpc("jHPbke", inner, "/");
    const pid = Array.isArray(res) ? res[0] : null;
    if (typeof pid !== "string") throw new Error("createProject: unexpected response");
    return pid;
  }

  async setImageDefaults(projectId: string, model: ModelDef, count: number, aspect: string) {
    const aspectEnum = ASPECT_ENUM[aspect] ?? ASPECT_ENUM["16:9"];
    const inner = [
      "projects/" + projectId,
      [null, null, [[null, aspectEnum, count, model.modelKey]]],
      [["default_generation_settings.image_defaults"]],
    ];
    await this.session.rpc("Kcr7Ub", inner, projectPath(projectId));
  }

  /** Upload an image into a project; returns the media id usable as edit reference. */
  async uploadImage(projectId: string, data: Buffer, mime: string, filename: string, token: string): Promise<string> {
    const ctx = [null, TOOL_ASPECT, null, null, null, projectId, null, null, null, null, [token, 1]];
    const inner = [ctx, data.toString("base64"), mime, 1, null, null, null, null, filename, null, uuid(), uuid()];
    const res = await this.session.rpc("maseQ", inner, projectPath(projectId));
    const mediaId = Array.isArray(res) && Array.isArray(res[0]) ? res[0][0] : Array.isArray(res) ? res[0] : null;
    if (typeof mediaId !== "string") throw new Error("uploadImage: unexpected response " + JSON.stringify(res).slice(0, 200));
    return mediaId;
  }

  async generate(opts: {
    projectId: string;
    prompt: string;
    model: ModelDef;
    token: string;
    refs?: string[];
    conversationId?: string | null;
    /** Flow aspect enum (1=1:1, 2=9:16, 3=16:9, 4=3:4, 5=4:3); the UI sends it in the request. */
    aspect?: number;
  }): Promise<GenResult> {
    const { projectId, prompt, model, token } = opts;
    const ctx = [
      null,
      TOOL_ASPECT,
      null,
      null,
      opts.conversationId ?? null,
      projectId,
      null,
      null,
      null,
      null,
      [token, 1],
    ];
    const refs = opts.refs && opts.refs.length ? opts.refs.map((id) => [id, null, null, null, 2]) : null;
    const rid = uuid();
    const rid2 = uuid();
    const inner = [
      null,
      [
        [
          null,
          null,
          refs,
          Math.floor(Math.random() * 2_000_000_000),
          opts.aspect ?? 3,
          model.rpcModel,
          null,
          ctx,
          [[[prompt]]],
          null,
          null,
          null,
          null,
          rid,
        ],
      ],
      1,
      ctx,
      [rid2],
    ];
    const res = await this.session.rpc("ogiZ0b", inner, projectPath(projectId));
    return collect(res);
  }


  /** Media ids of every image the agent produced in this project. */
  async agentMediaIds(projectId: string): Promise<string[]> {
    const ids = new Set<string>();
    let conversations: any[] = [];
    try {
      const res: any = await this.listConversations(projectId);
      if (Array.isArray(res?.[0])) conversations = res[0];
    } catch {
      return [];
    }
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const firstUuid = (v: any, depth = 0): string | null => {
      if (depth > 32) return null;
      if (typeof v === "string") return uuidRe.test(v) ? v : null;
      if (Array.isArray(v)) {
        for (const x of v) {
          const u = firstUuid(x, depth + 1);
          if (u) return u;
        }
      } else if (v && typeof v === "object") {
        for (const x of Object.values(v)) {
          const u = firstUuid(x, depth + 1);
          if (u) return u;
        }
      }
      return null;
    };
    const walk = (v: any, depth = 0) => {
      if (depth > 48) return;
      if (Array.isArray(v)) {
        if (v[0] === "image") {
          const u = firstUuid(v);
          if (u) ids.add(u);
        }
        for (const x of v) walk(x, depth + 1);
      } else if (v && typeof v === "object") {
        for (const x of Object.values(v)) walk(x, depth + 1);
      }
    };
    for (const row of conversations) {
      const cid = row?.[0];
      if (typeof cid !== "string") continue;
      try {
        walk(await this.conversationDetail(cid, projectId));
      } catch {
        /* still generating */
      }
    }
    return [...ids];
  }

  /**
   * Agent generation: sends the prompt through the Flow agent (which honours the
   * ratio hint) and returns the produced media id.
   */
  async agentGenerate(opts: { projectId: string; prompt: string; model: ModelDef; aspect: string }): Promise<string[]> {
    const { browserHub } = await import("../google/browser.js");
    const { config } = await import("../config.js");
    const session = this.session as any;
    const token = await session.mint("CHAT_GENERATION");
    const id = await browserHub.agentRun(
      session.account,
      session.workerIndex,
      opts.projectId,
      [[opts.prompt.trim() + " " + opts.aspect]],
      token,
      [],
      config.generateTimeoutMs
    );
    return id ? [id] : [];
  }

  /**
   * Agent edit: attaches the uploaded media ids to the message so the agent can
   * work on them, then returns the produced media id.
   */
  async agentEdit(opts: {
    projectId: string;
    prompt: string;
    model: ModelDef;
    aspect: string;
    mediaIds: string[];
  }): Promise<string[]> {
    const { browserHub } = await import("../google/browser.js");
    const { config } = await import("../config.js");
    const session = this.session as any;
    const token = await session.mint("CHAT_GENERATION");
    const parts: unknown[] = [[opts.prompt.trim() + " " + opts.aspect], ...opts.mediaIds.map((id) => [id])];
    const id = await browserHub.agentRun(
      session.account,
      session.workerIndex,
      opts.projectId,
      parts,
      token,
      opts.mediaIds,
      config.generateTimeoutMs
    );
    return id ? [id] : [];
  }

  /** Promote an agent output into project media so the upscaler can address it. */
  async saveAgentMedia(projectId: string, mediaId: string): Promise<string> {
    const res: any = await this.session.rpc("as29s", [mediaId], projectPath(projectId));
    const saved = Array.isArray(res) && typeof res[0] === "string" ? res[0] : mediaId;
    return saved;
  }

  /** 2K upscale; returns raw image bytes (server returns base64 JPEG). */
  async upscale2k(projectId: string, mediaId: string, token: string): Promise<Buffer> {
    const ctx = [null, TOOL_ASPECT, null, null, null, projectId, null, null, null, null, [token, 1]];
    const res = await this.session.rpc("SPrCad", [mediaId, 1, ctx], projectPath(projectId));
    const strs: string[] = [];
    walkStrings(res, strs);
    const b64 = strs
      .filter((s) => s.length > 5000 && !s.startsWith("http"))
      .sort((a, b) => b.length - a.length)[0];
    if (!b64) throw new Error("upscale2k: no image payload");
    return Buffer.from(b64, "base64");
  }

  async archiveMedia(projectId: string, mediaId: string) {
    const inner = [[[mediaId, null, null, [null, null, 1], projectId]], [["metadata.archived"]]];
    await this.session.rpc("pGCYOe", inner, projectPath(projectId));
  }

  async deleteProject(projectId: string) {
    await this.session.rpc("QI2zvc", ["projects/" + projectId], "/");
  }

  async listConversations(projectId: string) {
    return this.session.rpc("mrlkwd", [projectId], projectPath(projectId));
  }

  async conversationDetail(conversationId: string, projectId: string) {
    return this.session.rpc("GN0Bre", [conversationId], projectPath(projectId));
  }
}

export async function downloadImage(url: string): Promise<{ data: Buffer; contentType: string }> {
  const { request } = await import("undici");
  const { config } = await import("../config.js");
  const mod = await import("undici");
  const dispatcher = config.proxyUrl ? new mod.ProxyAgent(config.proxyUrl) : undefined;
  const res = await request(url, {
    method: "GET",
    dispatcher,
    headersTimeout: 60_000,
    bodyTimeout: 120_000,
  });
  if (res.statusCode !== 200) throw new Error("download failed: " + res.statusCode);
  const chunks: Buffer[] = [];
  for await (const chunk of res.body) chunks.push(chunk as Buffer);
  return {
    data: Buffer.concat(chunks),
    contentType: String(res.headers["content-type"] || "image/png"),
  };
}