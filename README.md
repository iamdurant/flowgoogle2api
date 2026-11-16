# flowgoogle2api

把 [Google Flow](https://flow.google.com) 的文生图 / 图生图能力代理成 OpenAI 兼容 API。默认输出 2K，支持多个 Google 账号，请求结束后自动删除远端项目（图片与会话一并清理）。

- 模型：`nano-banana-pro`、`nano-banana-2.1`、`nano-banana-2-lite`
- 接口：`/v1/models`、`/v1/images/generations`、`/v1/images/edits`、`/v1/chat/completions`
- 比例：`1:1`、`4:3`、`3:4`、`16:9`、`9:16`，由 `size` 或 `aspect_ratio` 指定
- 单进程：一个无头 Chrome，每个账号一个隔离上下文，每账号多个并发标签页

## 架构

```
下游 (OpenAI 格式)
   │
   ▼
Fastify 服务 ── 账号池 / 并发闸门 / 图片托管
   │
   ▼
一个无头 Chrome
├── context(account A) ── worker tab ×N
└── context(account B) ── worker tab ×N
   │
   ▼
flow.google.com  (batchexecute RPC)
```

生成与编辑走 `ogiZ0b` 直连 RPC，比例作为请求里的枚举字段随请求下发（1:1=1、9:16=2、16:9=3、3:4=4、4:3=5）；出图后用 `SPrCad` 做 2K 高清重塑。智能体通道仅作为可选路径（`AGENT_MODE=true`），默认关闭。

## 快速开始

```bash
npm install
npm run login            # 普通 Chrome 窗口登录 Google，回车保存到 data/accounts.json
cp .env.example .env     # 填 AUTH_KEY、FLOW_PROXY
npm start
```

```bash
curl http://127.0.0.1:3000/v1/images/generations \
  -H "Authorization: Bearer $AUTH_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"nano-banana-pro","prompt":"a cabin in a snowy forest","size":"1536x1024"}'
```

```json
{"created":1794768834,"data":[{"url":"http://127.0.0.1:3000/images/<id>.jpg","revised_prompt":"..."}]}
```

## 接口

### POST /v1/images/generations

| 字段 | 说明 |
|---|---|
| `model` | `nano-banana-pro` / `nano-banana-2.1` / `nano-banana-2-lite`（也接受 `beluga`、`harbor_seal`、`GEM_PIX_2`） |
| `prompt` | 提示词 |
| `n` | 1–4，多张时并发生成 |
| `size` | 如 `1024x1536`，按比例就近映射到 5 档 |
| `aspect_ratio` | `1:1` / `4:3` / `3:4` / `16:9` / `9:16`，优先于 size |
| `quality` | `2k`（默认，长边约 2K）/ `1k`；仅 2K 会走 `SPrCad` 重塑 |
| `response_format` | `url`（默认，图片托管在本服务）/ `b64_json` |

### POST /v1/images/edits

multipart：`image`（可重复，最多 4 张）+ `prompt` + 上表其余字段；也支持 JSON：

```json
{"model":"nano-banana-2.1","prompt":"改成秋天","images":[{"image_url":"https://example.com/a.png"}]}
```

支持 data URL。`image_url` 只允许公网 http(s)，单张上限 15MB。

### POST /v1/chat/completions

把最后一条用户消息当 prompt 出图，返回 markdown 图片；支持 `stream`（SSE）。

## 多账号

`npm run login <id>` 可重复执行，账号写入 `data/accounts.json`（每个账号一份 cookie，包含 `flow.google.com` 域的 `OSID`）。

运行时按「在途最少」选账号，失败处理：

- `PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED_*` → 该账号该模型冷却 6 小时
- 登录态失效（`AUTH_REQUIRED` / `CREDENTIALS_MISSING`）→ 标记该账号不可用，换下一个

`GET /v1/accounts` 查看池状态（含 `inflight`）。

## 并发

| 变量 | 默认 | 说明 |
|---|---|---|
| `WORKERS_PER_ACCOUNT` | 4 | 每账号并发的标签页数，即单账号最大并发 |
| `MAX_CONCURRENCY` | 128 | 全局同时在跑的上游请求数，超出的排队 |
| `QUEUE_TIMEOUT_MS` | 120000 | 排队超时后返回 429 |

- `n > 1` 会拆成 n 个独立生成并发执行，全部完成后统一返回
- `GET /health` 返回 `workersPerAccount` / `maxConcurrency` / `gate` 实时状态
- 单账号并发过高容易触发 Google 风控，账号越多越安全

## 部署

单容器即可，无需 Xvfb / VNC：

```bash
cp .env.example .env
# 把本地登录生成的 data/accounts.json 拷到 VPS 的 data/
AUTH_KEY=xxx docker compose up -d --build
```

- 镜像内安装 Chrome，以 headless 方式由服务拉起（`--no-sandbox`，`shm_size: 512mb`）
- 内存参考：Chrome 主进程约 290MB + 渲染进程约 250MB，每多一个账号约 +30–60MB
- 账号 cookie 失效时在本地重新 `npm run login` 并同步 `accounts.json` 即可

## 配置

见 `.env.example`。常用：

| 变量 | 说明 |
|---|---|
| `AUTH_KEY` | 下游鉴权，留空则不校验（仅建议本地使用） |
| `FLOW_PROXY` | 访问 Google 的代理，如 `http://127.0.0.1:10808` |
| `DEFAULT_MODEL` / `DEFAULT_ASPECT` / `DEFAULT_2K` | 默认模型、比例、是否 2K |
| `IMAGE_TTL_MS` | 托管图片保留时间，默认 1 小时 |
| `CHROME_CDP_URL` | 可选，复用已运行的 Chrome；留空则自动拉起无头 Chrome |

## 排障

| 现象 | 处理 |
|---|---|
| `AUTH_REQUIRED` / 502 | 账号 cookie 失效，重新 `npm run login` |
| `[8, ... PER_MODEL_DAILY_QUOTA_REACHED]` | 该账号该模型当日额度用尽，换模型或加账号 |
| `429 server busy` | 并发打满，调大 `MAX_CONCURRENCY` 或加账号 |
| 图片 404 | 托管图片已过期，调大 `IMAGE_TTL_MS` 或改用 `b64_json` |

更多协议细节见 [docs/RECON.md](docs/RECON.md)。

## 免责声明

本项目仅用于个人学习与技术研究。使用本项目可能违反 Google 服务条款并导致账号受限，请勿用于商业用途或批量滥用；由此产生的一切后果由使用者自行承担。