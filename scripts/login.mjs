#!/usr/bin/env node
/**
 * Login helper.
 *
 * Launches a *plain* Chrome (no automation flags) with a debugging port, waits
 * until flow.google.com actually renders the logged-in app, then reads cookies
 * over CDP while the browser is still running (session cookies never hit disk,
 * so closing Chrome first would lose them).
 *
 *   node scripts/login.mjs [label]
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import readline from "node:readline";

const label = process.argv[2] || "account-" + Date.now();
const root = path.resolve(import.meta.dirname, "..");
const accountsFile = process.env.ACCOUNTS_FILE
  ? path.resolve(process.env.ACCOUNTS_FILE)
  : path.join(root, "data", "accounts.json");
const profileDir = path.join(root, "data", "profiles", label);

fs.mkdirSync(path.dirname(accountsFile), { recursive: true });
fs.mkdirSync(profileDir, { recursive: true });

const candidates = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
const chrome = candidates.find((bin) => fs.existsSync("/usr/bin/" + bin) || fs.existsSync("/usr/local/bin/" + bin));
if (!chrome) {
  console.error("找不到 Chrome，请先安装 google-chrome");
  process.exit(1);
}

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}
// Fixed port so the service can attach later via CHROME_CDP_URL.
const port = Number(process.env.LOGIN_CDP_PORT || 9222);
const portFree = await new Promise((resolve) => {
  const srv = net.createServer();
  srv.once("error", () => resolve(false));
  srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
});
if (!portFree) {
  console.error("端口 " + port + " 已被占用（可能已经有 Chrome 在跑）。先关掉它，或用 LOGIN_CDP_PORT 换一个端口。");
}

console.log("");
console.log("已打开一个普通 Chrome 窗口，请完成 Google 登录。");
console.log("脚本会自动检测：一旦 flow.google.com 显示为已登录就会保存 cookie。");
console.log("（保存后窗口留着即可，确认看到 Flow 项目列表后可以自行关闭）");
console.log("");

const child = spawn(
  chrome,
  [
    "--user-data-dir=" + profileDir,
    "--remote-debugging-port=" + port,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
    "https://flow.google.com/",
  ],
  { stdio: "ignore", detached: true }
);
child.unref();
child.on("error", (e) => {
  console.error("chrome 启动失败:", e.message);
  process.exit(1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("> 确认已经看到 Flow 项目列表后按 Enter（不会关闭窗口）...", () => {
    rl.close();
    resolve();
  });
});

let browser;
for (let i = 0; i < 30 && !browser; i++) {
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
  } catch {
    await sleep(1000);
  }
}
if (!browser) {
  console.error("无法连接到 Chrome 调试端口，请重试");
  process.exit(1);
}

async function loggedInCookies() {
  const contexts = browser.contexts();
  for (const ctx of contexts) {
    for (const page of ctx.pages()) {
      try {
        if (!page.url().startsWith("https://flow.google.com")) continue;
        const html = await page.evaluate(async () => await (await fetch("/", { credentials: "include" })).text());
        if (/SNlM0e/.test(html)) return await ctx.cookies();
      } catch {
        /* page busy / navigating */
      }
    }
  }
  return null;
}

let cookies = null;
for (let i = 0; i < 15; i++) {
  cookies = await loggedInCookies();
  if (cookies) break;
  await sleep(2000);
}

if (!cookies) {
  console.error("");
  console.error("等待超时：没有检测到已登录的 Flow 页面。窗口先留着，可以重新运行脚本。");
  process.exit(1);
}

const jar = cookies
  .filter((c) => c.value && /google\.com$/.test(c.domain))
  .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/" }));

let accounts = [];
if (fs.existsSync(accountsFile)) {
  try {
    const raw = JSON.parse(fs.readFileSync(accountsFile, "utf8"));
    accounts = Array.isArray(raw) ? raw : raw.accounts || [];
  } catch {}
}
accounts = accounts.filter((a) => a.id !== label);
accounts.push({ id: label, profileDir, cookies: jar });
fs.writeFileSync(accountsFile, JSON.stringify({ accounts }, null, 2));

const names = jar.map((c) => c.name);
console.log("");
console.log("登录成功，已保存 " + jar.length + " 个 cookie 到 " + accountsFile);
console.log("关键 cookie: SID=" + names.includes("SID") + " SAPISID=" + names.includes("SAPISID") + " OSID=" + names.includes("OSID"));
console.log("");
console.log("这个 Chrome 窗口请保持打开：服务会用 CHROME_CDP_URL=http://127.0.0.1:" + port + " 连它。");
console.log("关闭窗口会导致会话 cookie 丢失，需要重新登录。");
await browser.close().catch(() => {});
process.exit(0);