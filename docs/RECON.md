# Flow (flow.google.com) 逆向记录

> 抓包时间 2026-11-16，账号已登录，UI 语言 zh-CN。以下结论均已在 Node 侧无浏览器复现（除 reCAPTCHA 铸造）。

## 1. 模型映射

| 展示名 | 生成请求 model | 项目设置 modelKey |
|---|---|---|
| 🍌 Nano Banana Pro | `GEM_PIX_2` | `nano_banana_pro` |
| 🍌 Nano Banana 2 Lite | `HARBOR_SEAL` | `harbor_seal` |
| 🍌 Nano Banana 2.1 | `BELUGA` | `beluga_display` |
| 🍌 Nano Banana 2（旧） | `NARWHAL` | `narwhal_display` |
| 2K 高清重塑 | `GEM_PIX_2_UPSAMPLE_2K` | — |
| 4K 高清重塑 | `GEM_PIX_2_UPSAMPLE_4K` | — |

## 2. 账号凭据

需要 `.google.com` 域下的 Google 登录 Cookie（`SID`、`HSID`、`SSID`、`APISID`、`SAPISID`、`__Secure-1PSID`、`__Secure-3PSID`、`__Secure-1PAPISID`、`__Secure-3PAPISID`、`__Secure-1PSIDTS`、`__Secure-3PSIDTS` 等）。

每个页面会话还需要：

- `at`：HTML 里的 `SNlM0e`（形如 `AHw14vbc...:1794764915268`）
- `f.sid`：HTML 里的 `FdrFJe`
- `bl`：HTML 里的 `cfb2h`（`boq_labs-ai-sandbox-frontend_20261111.08_p0`）

即 `GET https://flow.google.com/`（带 Cookie）后正则提取，约 30 分钟内可复用。

## 3. batchexecute 调用

```
POST https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute
  ?rpcids=<ID>&source-path=<urlencode("/project/<pid>")>
  &bl=<bl>&f.sid=<sid>&hl=zh-CN&_reqid=<random>&rt=c
Content-Type: application/x-www-form-urlencoded;charset=UTF-8
Cookie: <jar>

f.req=<urlencode(JSON.stringify([[[rpcid, JSON.stringify(inner), null, "generic"]]]))>
&at=<urlencode(at)>
```

响应：`)]}'\n\n<len>\n<json>\n<len>\n<json>`。`<len>` 可能按字符计，**不要**直接按字节切；按括号配对扫描 JSON 数组最稳（实现见 `src/google/session.ts`）。

数据帧：`["wrb.fr","<rpcid>","<inner JSON string>",...,"generic"]`
错误帧：`["wrb.fr","<rpcid>",null,null,null,[<code>,...],...]`，`code=8` 常见于配额。

## 4. RPC 一览（全部已验证）

| 用途 | RPC | 请求 inner |
|---|---|---|
| 建项目 | `jHPbke` | `["projects/*", [null, ["<标题>"]], [null, 22]]` → `["<pid>",[...]]` |
| 设默认生图参数 | `Kcr7Ub` | `["projects/<pid>", [null,null,[[null,<aspect>,<count>,"<modelKey>"]]], [["default_generation_settings.image_defaults"]]]` |
| 文生图 / 编辑 | `ogiZ0b` | 见 §5 |
| 上传参考图 | `maseQ` | 见 §6 |
| 2K 高清重塑 | `SPrCad` | `["<mediaId>", 1, <ctx>]` → 内联 base64 JPEG |
| 归档单图 | `pGCYOe` | `[[["<mediaId>",null,null,[null,null,1],"<pid>"]],[["metadata.archived"]]]` |
| 删除项目 | `QI2zvc` | `["projects/<pid>"]` |
| 列出会话 | `mrlkwd` | `["<pid>"]` |
| 会话详情（含媒体/思考） | `GN0Bre` | `["<conversationId>"]` |
| 项目列表 | `UpteDb` | `["projects/*",21,null,null,null,null,[1]]` |

## 5. 生成 / 编辑 ogiZ0b

```json
[null,
 [[null, null, <refs|null>, <seed>, 3, "<GEM_PIX_2|BELUGA|HARBOR_SEAL>", null, <ctx>,
   [[["<prompt>"]]], null, null, null, null, "<UUID1>"]],
 1, <ctx>, ["<UUID2>"]]
```

`<ctx>` = `[null, 22, null, null, <conversationId|null>, "<projectId>", null,null,null,null, ["<recaptchaToken>", 1]]`

- `refs`：文生图传 `null`；编辑传 `[["<mediaId>", null, null, null, 2]]`（可多张）
- `ctx[1] = 22` 是常量，**不是**比例；实际比例由项目默认设置 `Kcr7Ub` 决定
- 末尾必须是 `["UUID2"]`（数组包一个字符串）。写成 `[["UUID2"]]` 会返回 `[3]`（INVALID_ARGUMENT）
- `conversationId` 可为 null（自动新建会话）

响应 inner 里包含新媒体 id（`inner[0][0][0]`）与签名直链
`https://flow-content.google/image/<mediaId>?Expires=...&KeyName=labs-flow-prod-cdn-key&Signature=...`，
以及原图尺寸（1K 16:9 = `[1376,768]`）。

## 6. 上传参考图 maseQ（内联 base64，无需单独 PUT）

```json
[ <ctx>, "<base64 图片>", "image/png", 1, null, null, null, null,
  "<filename>", null, "<UUID>", "<UUID>" ]
```

响应 `inner[0] = ["<mediaId>", "<pid>", "<conversationId>", ...]`，服务端会转成 JPEG 并记录尺寸。

## 7. reCAPTCHA Enterprise

- site key：`6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV`
- action：生成/编辑用 `IMAGE_GENERATION`（Agent 对话用 `CHAT_GENERATION`）
- token：`0cAFcWeA...`，~2700 字符，约 2 分钟过期，一次性
- **只有项目页才会加载 enterprise.js**；首页不会。无头 Chrome 打开一个项目页即可长期铸造
- 纯 HTTP 的 anchor+reload 拿不到（企业版需要 JS），必须用浏览器

## 8. 图片下载

- 签名直链（约 6 小时有效，无需 Cookie）：`https://flow-content.google/image/<mediaId>?Expires=...&Signature=...`
- 稳定代理（需 Cookie）：`https://flow.google.com/asb/<token>=s1600-rw` 或 `https://lh3.googleusercontent.com/asb/<token>`
- 2K：`SPrCad` 直接返回 base64 JPEG（1376x768 → 2752x1536）

## 9. 删除 / 清理

- 单图归档：`pGCYOe`（= UI 删除，进回收站）
- 彻底清理：`QI2zvc` 删除项目，图片 + 会话 + 上传素材一并消失（推荐每个请求独立项目）

## 10. 错误与限额

- `[8, ...]` + `PUBLIC_ERROR_PER_MODEL_DAILY_QUOTA_REACHED_UPGRADEABLE`：该账号该模型当日额度用尽
- `[3]`：INVALID_ARGUMENT（多为 payload 结构错误，如 UUID 嵌套写错）
- 额度按「账号 × 模型」计算，普通号 Pro 一天约 20 张左右；2.1 / 2 Lite 更宽松

## 11. 未使用但已确认

Agent 模式（智能体）走 `aisandbox-pa-webchannel.clients6.google.com/v1/flowCreationAgent/streamCreationAgentChat/channel`，
需要 `SAPISIDHASH` + `X-Goog-Api-Key` + `X-Server-Token`（页面 `y83d5b`）且必须带 Cookie。
模型/比例由项目默认设置决定，结果需要从 WebChannel 流或会话详情里取。**本项目的生图/编辑不依赖它。**

## 12. Cookie 域（重要）

flow.google.com 的登录态需要两类 cookie：

- `.google.com`：`SID`、`HSID`、`SSID`、`APISID`、`SAPISID`、`__Secure-1PSID`、`__Secure-3PSID`、`__Secure-1PAPISID`、`__Secure-3PAPISID`、`__Secure-1PSIDTS`、`__Secure-3PSIDTS` …
- `flow.google.com`：`OSID`、`__Secure-OSID`

只带 `.google.com` 时页面会返回未登录外壳（~168KB，HTML 里没有 `SNlM0e`，但有 `ServiceLogin`），此时 `boot()` 拿不到 `at`，所有 RPC 都会失败。必须按 host 匹配域来拼 Cookie 头。

另外 multipart 上传的 Content-Type 必须是 `image/*`：Flow 对 `application/octet-stream` 直接返回 `[3]`，所以服务端按文件头嗅探真实类型。

## 13. 智能体通道（比例 / 编辑）

- 端点：`aisandbox-pa-webchannel.clients6.google.com/v1/flowCreationAgent/streamCreationAgentChat/channel`
- 认证：`SAPISIDHASH`（必须用**页面里**的 `document.cookie` 计算，Node 侧 JSON 副本里的 SAPISID 往往是旧的）+ `X-Goog-Api-Key` + `X-Server-Token`（页面 HTML 的 `y83d5b`）+ Cookie
- 流程：POST count=0 拿 SID → POST `req0___data__` → GET 长轮询流
- **流里就有结果**：图片的 media id 会以 `["image", ..., "<uuid>"]` 的形式出现在流帧里（约 +7s），比会话列表（`mrlkwd`/`GN0Bre`，约 +10.6s）更早；注意流文本里的引号是转义的（`\"image\"`），匹配前先反转义
- 拿到 id 后 `as29s` 仍会失败一段时间（约 +23s 才成功），这是服务端还在落盘，不是轮询问题
- 比例：把 `" 9:16"` 拼在 prompt 末尾，Agent 会解析并控制画布
- 取图：
  1. `mrlkwd` 列会话 → `GN0Bre` 取详情，遍历结构找 `["image", ..., "<uuid>"]` 得到 agent 媒体 id
  2. `as29s` 传该 id（=「保存到项目」），媒体才变成可寻址；刚出图时可能返回 `[5]`，需要重试
  3. `SPrCad` 传该 id 得到 2K base64
- 直连 RPC（`ogiZ0b`）的画布固定 16:9，prompt 里写比例无效（实测 9:16/1:1/4:3 都是 1376x768）
- **带参考图**：消息 parts 就是「文本部件 + 媒体部件」的平铺数组，例如
  `[["把圆形改成绿色 1:1"], ["<mediaId>"]]`（媒体部件是只含 id 的单元素数组）。
  实测 agent 能正确识别图片内容（会描述出图片里的黄色圆形/蓝色横条），多张就并列多个媒体部件。