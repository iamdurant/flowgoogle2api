#!/usr/bin/env node
/**
 * Import cookies from an existing Chrome profile directory (e.g. one created by
 * this project's login flow, or a real Chrome profile) into data/accounts.json.
 *
 *   node scripts/import-profile.mjs <profileDir> [label]
 *
 * The profile must not be in use by another Chrome instance.
 */
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const profileDir = process.argv[2];
const label = process.argv[3] || "account-" + Date.now();
if (!profileDir) {
  console.error("usage: node scripts/import-profile.mjs <profileDir> [label]");
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const accountsFile = process.env.ACCOUNTS_FILE
  ? path.resolve(process.env.ACCOUNTS_FILE)
  : path.join(root, "data", "accounts.json");

const ctx = await chromium.launchPersistentContext(path.resolve(profileDir), {
  channel: "chrome",
  headless: true,
  locale: "zh-CN",
});
const cookies = await ctx.cookies();
await ctx.close();

const jar = cookies
  .filter((c) => c.value && /google\.com$/.test(c.domain))
  .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path || "/" }));

const hasFlow = jar.some((c) => c.domain === "flow.google.com" && (c.name === "OSID" || c.name === "__Secure-OSID"));
const hasSap = jar.some((c) => c.name === "SAPISID");
if (!hasSap || !hasFlow) {
  console.error("profile 里没有完整的 flow 登录态（缺少 SAPISID 或 flow.google.com OSID）");
  process.exit(1);
}

let accounts = [];
if (fs.existsSync(accountsFile)) {
  try {
    const raw = JSON.parse(fs.readFileSync(accountsFile, "utf8"));
    accounts = Array.isArray(raw) ? raw : raw.accounts || [];
  } catch {}
}
accounts = accounts.filter((a) => a.id !== label);
accounts.push({ id: label, cookies: jar });
fs.mkdirSync(path.dirname(accountsFile), { recursive: true });
fs.writeFileSync(accountsFile, JSON.stringify({ accounts }, null, 2));
console.log("imported " + jar.length + " cookies as " + label + " -> " + accountsFile);
