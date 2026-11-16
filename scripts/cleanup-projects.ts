/**
 * Delete Flow projects by title (default: the throwaway projects created by the
 * reCAPTCHA minter).
 *
 *   npx tsx scripts/cleanup-projects.ts --title minter [--dry]
 */
import { AccountPool } from "../src/accounts.js";
import { Session } from "../src/google/session.js";
import { FlowClient } from "../src/flow/client.js";
import { config } from "../src/config.js";

const args = process.argv.slice(2);
const titleArg = args.find((a) => a.startsWith("--title="))?.split("=")[1] || (args.includes("--title") ? args[args.indexOf("--title") + 1] : "minter");
const dry = args.includes("--dry");

const pool = new AccountPool();
pool.load();
const acc = pool.all().find((a) => !a.disabled);
if (!acc) {
  console.error("no account in " + config.accountsFile);
  process.exit(1);
}

const session = new Session(acc);
const client = new FlowClient(session);

const list: any = await client.session.rpc("UpteDb", ["projects/*", 21, null, null, null, null, [1]], "/");
const rows = Array.isArray(list?.[0]) ? list[0] : [];
const targets: { pid: string; title: string }[] = [];
for (const row of rows) {
  const pid = row?.[0];
  const title = row?.[1]?.[0];
  if (typeof pid === "string" && typeof title === "string" && title.trim() === titleArg.trim()) {
    targets.push({ pid, title });
  }
}
console.log("matched", targets.length, "projects titled", JSON.stringify(titleArg));
for (const t of targets) {
  if (dry) {
    console.log("would delete", t.pid);
    continue;
  }
  try {
    await client.deleteProject(t.pid);
    console.log("deleted", t.pid);
  } catch (e: any) {
    console.log("failed", t.pid, String(e?.message || e).slice(0, 120));
  }
}