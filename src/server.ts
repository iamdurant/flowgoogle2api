import Fastify from "fastify";
import multipart from "@fastify/multipart";
import fs from "node:fs";
import { config } from "./config.js";
import { accountPool, parseCookieHeader, type CookieRecord } from "./accounts.js";
import { generateImages, gate } from "./generate.js";
import { MODELS, aspectFromSize } from "./models.js";
import { saveImage, getImage, publicUrl, sweeper, sweepDisk } from "./store.js";
import { Session } from "./google/session.js";
import { browserHub } from "./google/browser.js";
import { downloadImage } from "./flow/client.js";
import { sniffImage, filenameFor } from "./image.js";
import { assertPublicUrl } from "./net-guard.js";
import { verifyCookies } from "./cookie-check.js";
import { logStore } from "./logs.js";

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || "info" }, bodyLimit: 30 * 1024 * 1024 });

await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 8 } });

function auth(req: any) {
  if (!config.authKey) return;
  const h = req.headers["authorization"] || "";
  const key = String(h).replace(/^Bearer\s+/i, "");
  if (key !== config.authKey) {
    const err: any = new Error("invalid api key");
    err.statusCode = 401;
    throw err;
  }
}

app.addHook("onRequest", async (req, reply) => {
  // The management page is static; its API calls carry the key themselves.
  if (req.url === "/" || req.url.startsWith("/images/") || req.url === "/health" || req.url === "/admin") return;
  try {
    auth(req);
  } catch (e: any) {
    reply.code(401).send({ error: { message: e.message, type: "invalid_request_error", code: "invalid_api_key" } });
  }
});

app.get("/health", async () => ({
  ok: true,
  accounts: accountPool.count(),
  workersPerAccount: config.workersPerAccount,
  maxConcurrency: config.maxConcurrency,
  gate: gate.stats(),
}));

app.get("/v1/models", async () => ({
  object: "list",
  data: MODELS.map((m) => ({ id: m.id, object: "model", owned_by: "google-flow", created: 0 })),
}));

function aspectOf(size?: string, aspect?: string): string {
  return aspectFromSize(size, aspect || (config.defaultAspect !== "16:9" ? config.defaultAspect : undefined));
}

function toResponse(images: Awaited<ReturnType<typeof generateImages>>, prompt: string, format: string) {
  const data = images.map((img) => {
    if (format === "b64_json") {
      return { b64_json: img.buffer.toString("base64"), revised_prompt: prompt };
    }
    const saved = saveImage(img.buffer, img.contentType);
    const ext = saved.file.split(".").pop()!;
    return { url: publicUrl(saved.id, ext), revised_prompt: prompt };
  });
  return { created: Math.floor(Date.now() / 1000), data };
}

app.post("/v1/images/generations", async (req, reply) => {
  const body = (req.body || {}) as any;
  const prompt = String(body.prompt || "").trim();
  if (!prompt) return reply.code(400).send({ error: { message: "prompt is required", type: "invalid_request_error" } });

  const started = Date.now();
  const aspect = aspectOf(body.size, body.aspect_ratio);
  const format = body.response_format === "b64_json" ? "b64_json" : "url";
  const modelName = String(body.model || config.defaultModel);

  try {
    const images = await generateImages({
      prompt,
      modelName: body.model,
      n: Number(body.n || 1),
      aspect,
      upscale2k: body.quality === "2k" ? true : body.quality === "1k" ? false : config.default2k,
    });
    logStore.add({
      at: started,
      ms: Date.now() - started,
      ok: true,
      model: modelName,
      aspect,
      prompt: prompt,
      kind: "generate",
      account: images[0]?.account,
      format,
      bytes: images.reduce((sum, img) => sum + img.buffer.length, 0),
    });
    return toResponse(images, prompt, format);
  } catch (e: any) {
    logStore.add({
      at: started,
      ms: Date.now() - started,
      ok: false,
      model: modelName,
      aspect,
      prompt: prompt,
      kind: "generate",
      error: String(e?.message || e).slice(0, 300),
      account: e?.account,
      format,
    });
    req.log.error({ err: String(e?.stack || e?.message || e) }, "generation failed");
    const busy = /server busy/.test(String(e?.message || ""));
    const quota = /QUOTA/.test(String(e?.code || "") + String(e?.message || ""));
    return reply.code(quota || busy ? 429 : 502).send({
      error: {
        message: String(e?.message || e).slice(0, 500),
        type: quota || busy ? "rate_limit_error" : "upstream_error",
        code: e?.code || "upstream_error",
      },
    });
  }
});

app.post("/v1/images/edits", async (req, reply) => {
  const body = (req.body || {}) as any;
  const images: { data: Buffer; mime: string; filename: string }[] = [];
  let totalBytes = 0;
  let prompt = "";
  let model: string | undefined;
  let n = 1;
  let size: string | undefined;
  let aspect: string | undefined;
  let format = "url";

  const isMultipart = String(req.headers["content-type"] || "").includes("multipart/form-data");
  if (isMultipart) {
    try {
      for await (const part of (req as any).parts()) {
      if (part.type === "file") {
        if (images.length >= 4) throw new Error("too many input images (max 4)");
        const buf = await part.toBuffer();
        totalBytes += buf.length;
        if (totalBytes > 20 * 1024 * 1024) throw new Error("input images exceed 20MB");
        const sniffed = sniffImage(buf, part.mimetype || "");
        images.push({ data: buf, mime: sniffed.mime, filename: filenameFor(part.filename, sniffed.ext) });
      } else {
        const v = String(part.value ?? "");
        if (part.fieldname === "prompt") prompt = v;
        else if (part.fieldname === "model") model = v;
        else if (part.fieldname === "n") n = Number(v) || 1;
        else if (part.fieldname === "size") size = v;
        else if (part.fieldname === "aspect_ratio") aspect = v;
        else if (part.fieldname === "response_format") format = v;
        }
      }
    } catch (e: any) {
      return reply.code(400).send({ error: { message: String(e?.message || e).slice(0, 200), type: "invalid_request_error" } });
    }
  } else {
    prompt = String(body.prompt || "");
    model = body.model;
    n = Number(body.n || 1);
    size = body.size;
    aspect = body.aspect_ratio;
    format = body.response_format || "url";
    const list: any[] = Array.isArray(body.images) ? body.images : body.image_url ? [{ image_url: body.image_url }] : [];
    for (const item of list) {
      const url = typeof item === "string" ? item : item?.image_url || item?.url;
      if (!url) continue;
      if (String(url).startsWith("data:")) {
        const m = String(url).match(/^data:([^;]+);base64,(.*)$/);
        if (m) {
          const buf = Buffer.from(m[2], "base64");
          const sniffed = sniffImage(buf, m[1]);
          images.push({ data: buf, mime: sniffed.mime, filename: filenameFor(undefined, sniffed.ext) });
        }
      } else {
        await assertPublicUrl(String(url));
        const dl = await downloadImage(String(url));
        if (dl.data.length > 15 * 1024 * 1024) throw new Error("remote image exceeds 15MB");
        const sniffed = sniffImage(dl.data, dl.contentType);
        images.push({ data: dl.data, mime: sniffed.mime, filename: filenameFor(undefined, sniffed.ext) });
      }
    }
  }

  if (!images.length) return reply.code(400).send({ error: { message: "image is required", type: "invalid_request_error" } });
  if (!prompt.trim()) return reply.code(400).send({ error: { message: "prompt is required", type: "invalid_request_error" } });

  const started = Date.now();
  const editAspect = aspectOf(size, aspect);
  const editFormat = format === "b64_json" ? "b64_json" : "url";
  const editModel = String(model || config.defaultModel);

  try {
    const out = await generateImages({
      prompt: prompt.trim(),
      modelName: model,
      n,
      aspect: editAspect,
      upscale2k: config.default2k,
      images,
    });
    logStore.add({
      at: started,
      ms: Date.now() - started,
      ok: true,
      model: editModel,
      aspect: editAspect,
      prompt: prompt.trim(),
      kind: "edit",
      account: out[0]?.account,
      format: editFormat,
      bytes: out.reduce((sum, img) => sum + img.buffer.length, 0),
    });
    return toResponse(out, prompt, editFormat);
  } catch (e: any) {
    logStore.add({
      at: started,
      ms: Date.now() - started,
      ok: false,
      model: editModel,
      aspect: editAspect,
      prompt: prompt.trim(),
      kind: "edit",
      error: String(e?.message || e).slice(0, 300),
      account: e?.account,
      format: editFormat,
    });
    req.log.error({ err: String(e?.stack || e?.message || e) }, "upstream call failed");
    const busy = /server busy/.test(String(e?.message || ""));
    const quota = /QUOTA/.test(String(e?.code || "") + String(e?.message || ""));
    return reply.code(quota || busy ? 429 : 502).send({
      error: {
        message: String(e?.message || e).slice(0, 500),
        type: quota || busy ? "rate_limit_error" : "upstream_error",
        code: e?.code || "upstream_error",
      },
    });
  }
});


app.post("/v1/chat/completions", async (req, reply) => {
  const body = (req.body || {}) as any;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m: any) => m.role === "user");
  let prompt = "";
  if (typeof lastUser?.content === "string") prompt = lastUser.content;
  else if (Array.isArray(lastUser?.content)) {
    prompt = lastUser.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  }
  prompt = String(prompt || body.prompt || "").trim();
  if (!prompt) return reply.code(400).send({ error: { message: "prompt is required", type: "invalid_request_error" } });

  const started = Date.now();
  const chatAspect = config.defaultAspect;
  const chatModel = String(body.model || config.defaultModel);

  try {
    const images = await generateImages({
      prompt,
      modelName: body.model,
      n: Number(body.n || 1),
      aspect: chatAspect,
      upscale2k: config.default2k,
    });
    logStore.add({
      at: started,
      ms: Date.now() - started,
      ok: true,
      model: chatModel,
      aspect: chatAspect,
      prompt: prompt,
      kind: "chat",
      account: images[0]?.account,
      format: "url",
      bytes: images.reduce((sum, img) => sum + img.buffer.length, 0),
    });
    const urls = images.map((img) => {
      const saved = saveImage(img.buffer, img.contentType);
      const ext = saved.file.split(".").pop()!;
      return publicUrl(saved.id, ext);
    });
    const content = urls.map((u) => "![image](" + u + ")").join("\n");
    const created = Math.floor(Date.now() / 1000);
    const id = "chatcmpl-" + created + "-" + Math.random().toString(36).slice(2, 8);

    if (body.stream) {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model: body.model || config.defaultModel,
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      };
      reply.raw.write("data: " + JSON.stringify(chunk) + "\n\n");
      reply.raw.write(
        "data: " + JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "\n\n"
      );
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
      return;
    }

    return {
      id,
      object: "chat.completion",
      created,
      model: body.model || config.defaultModel,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  } catch (e: any) {
    logStore.add({
      at: started,
      ms: Date.now() - started,
      ok: false,
      model: chatModel,
      aspect: chatAspect,
      prompt: prompt,
      kind: "chat",
      error: String(e?.message || e).slice(0, 300),
      account: e?.account,
      format: "url",
    });
    req.log.error({ err: String(e?.stack || e?.message || e) }, "upstream call failed");
    const busy = /server busy/.test(String(e?.message || ""));
    const quota = /QUOTA/.test(String(e?.code || "") + String(e?.message || ""));
    return reply.code(quota || busy ? 429 : 502).send({
      error: {
        message: String(e?.message || e).slice(0, 500),
        type: quota || busy ? "rate_limit_error" : "upstream_error",
        code: e?.code || "upstream_error",
      },
    });
  }
});

app.get("/", async () => ({
  name: "flowgoogle2api",
  models: MODELS.map((m) => m.id),
  endpoints: ["/v1/models", "/v1/images/generations", "/v1/images/edits", "/v1/chat/completions"],
}));

app.get("/images/:name", async (req, reply) => {
  const name = (req.params as any).name as string;
  const id = name.split(".")[0];
  const e = getImage(id);
  if (!e) return reply.code(404).send({ error: { message: "not found" } });
  reply.header("content-type", e.contentType);
  reply.header("cache-control", "public, max-age=300");
  return reply.send(fs.createReadStream(e.file));
});

app.get("/v1/accounts", async () => ({ data: accountPool.snapshot() }));

const adminFile = new URL("./web/admin.html", import.meta.url);

// Read per request so the page can be updated without restarting the service.
app.get("/admin", async (req, reply) => reply.type("text/html; charset=utf-8").send(fs.readFileSync(adminFile, "utf8")));

app.get("/admin/api/accounts", async () => ({ data: accountPool.snapshot() }));

app.post("/admin/api/accounts", async (req, reply) => {
  const body = (req.body || {}) as any;
  const id = String(body.id || "").trim() || "main";
  let cookies: CookieRecord[] = [];
  if (Array.isArray(body.cookies)) {
    cookies = body.cookies
      .filter((c: any) => c && typeof c.name === "string" && typeof c.value === "string")
      .map((c: any) => ({ name: c.name, value: c.value, domain: String(c.domain || ".google.com"), path: c.path || "/" }));
  } else if (typeof body.cookie === "string") {
    cookies = parseCookieHeader(body.cookie);
  }
  if (!cookies.length) return reply.code(400).send({ error: { message: "cookie is empty" } });

  const verified = await verifyCookies(cookies);
  if (!verified) {
    return reply.code(400).send({ error: { message: "Cookie 校验失败：Google 未返回登录态（缺 LSID 或已过期）" } });
  }

  const existing = accountPool.all().find((a) => a.id === id);
  accountPool.addOrUpdate({
    id,
    email: existing?.email,
    disabled: typeof body.disabled === "boolean" ? body.disabled : existing?.disabled,
    cookies,
  });
  // Drop any live context: it still holds the previous cookie jar.
  await browserHub.closeAccount(id);
  accountPool.save();
  return { ok: true, verified, data: accountPool.snapshot().find((a) => a.id === id) };
});

app.delete("/admin/api/accounts/:id", async (req) => {
  const id = String((req.params as any).id || "");
  accountPool.remove(id);
  await browserHub.closeAccount(id);
  accountPool.save();
  return { ok: true };
});

app.patch("/admin/api/accounts/:id", async (req) => {
  const id = String((req.params as any).id || "");
  const body = (req.body || {}) as any;
  const acc = accountPool.all().find((a) => a.id === id);
  if (acc && typeof body.disabled === "boolean") acc.disabled = body.disabled;
  accountPool.save();
  return { ok: true };
});

app.delete("/admin/api/accounts", async (req) => {
  const body = (req.body || {}) as any;
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  for (const id of ids) {
    accountPool.remove(id);
    await browserHub.closeAccount(id);
  }
  if (ids.length) accountPool.save();
  return { ok: true, removed: ids.length };
});

app.get("/admin/api/logs", async (req) => {
  const q = (req.query || {}) as any;
  return logStore.page(Number(q.page || 1), Number(q.size || 20));
});

app.delete("/admin/api/logs", async (req) => {
  const body = (req.body || {}) as any;
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  return { ok: true, removed: logStore.remove(ids) };
});

async function main() {
  accountPool.load();
  logStore.load();
  if (!accountPool.count()) {
    app.log.warn("no accounts loaded; add one via the /admin page");
  }
  sweepDisk();
  sweeper();

  // Warm one account up in the background: opens its browser page, creates the
  // throwaway project that hosts reCAPTCHA, and pre-mints a token.
  const first = accountPool.all()[0];
  if (first) {
    new Session(first)
      .mint("IMAGE_GENERATION")
      .then(() => app.log.info("upstream session ready for " + first.id))
      .catch((e) => app.log.error("upstream warmup failed: " + e.message));
  }

  // Google rotates __Secure-1PSIDTS inside the browser; write the refreshed jar
  // back so a restart does not need a fresh login.
  setInterval(async () => {
    for (const acc of accountPool.all()) {
      const cookies = await browserHub.exportCookies(acc.id).catch(() => null);
      if (cookies && cookies.length) accountPool.replaceCookies(acc.id, cookies);
    }
    try {
      accountPool.save();
    } catch (e: any) {
      app.log.warn("failed to persist cookies: " + e.message);
    }
  }, 5 * 60_000).unref();

  await app.listen({ port: config.port, host: config.host });
  app.log.info("flowgoogle2api listening on " + config.host + ":" + config.port);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    try {
      accountPool.save();
      accountPool.saveStats();
      if (config.chromeCdpUrl) await browserHub.closeBotTabs();
      else await browserHub.close();
    } catch {}
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});