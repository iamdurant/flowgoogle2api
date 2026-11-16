/**
 * Calibrate the project-default aspect enum used by Kcr7Ub:
 * for each candidate value, set it and generate one image, then read the
 * returned dimensions.
 *
 *   FLOW_PROXY=http://127.0.0.1:10808 npx tsx scripts/calibrate-aspect.ts
 */
import { AccountPool } from "../src/accounts.js";
import { Session } from "../src/google/session.js";
import { FlowClient } from "../src/flow/client.js";
import { findModel } from "../src/models.js";
import { browserHub } from "../src/google/browser.js";

const pool = new AccountPool();
pool.load();
const acc = pool.all().find((a) => !a.disabled);
if (!acc) {
  console.error("no account");
  process.exit(1);
}

const session = new Session(acc);
const client = new FlowClient(session);
const model = findModel("nano-banana-2-lite");

const workProject = await client.createProject("aspect-calib");
for (const v of [1, 2, 3, 4, 5]) {
  await session.rpc(
    "Kcr7Ub",
    ["projects/" + workProject, [null, null, [[null, v, 1, model.modelKey]]], [["default_generation_settings.image_defaults"]]],
    "/project/" + workProject
  );
  await new Promise((r) => setTimeout(r, 1200));
  const token = await session.mint("IMAGE_GENERATION");
  const gen = await client.generate({
    projectId: workProject,
    prompt: "a plain grey cube on a white background, studio photo",
    model,
    token,
  });
  console.log("enum", v, "->", gen.width + "x" + gen.height, gen.url ? "" : "(no url)");
}

await client.deleteProject(workProject).catch(() => {});
await browserHub.close();
process.exit(0);
