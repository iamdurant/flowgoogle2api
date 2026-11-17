import { request, ProxyAgent } from "undici";
import { cookieHeader, type CookieRecord } from "./accounts.js";
import { config } from "./config.js";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
let agent: ProxyAgent | undefined;
let agentFor = "";

function dispatcher() {
  if (!config.proxyUrl) return undefined;
  if (!agent || agentFor !== config.proxyUrl) {
    agent = new ProxyAgent(config.proxyUrl);
    agentFor = config.proxyUrl;
  }
  return agent;
}

/** Check a candidate jar before it replaces a working account. */
export async function verifyCookies(cookies: CookieRecord[]): Promise<boolean> {
  try {
    const res = await request("https://flow.google.com/", {
      dispatcher: dispatcher(),
      headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9", cookie: cookieHeader(cookies, "flow.google.com") },
    });
    const html = await res.body.text();
    return /SNlM0e/.test(html);
  } catch {
    return false;
  }
}
