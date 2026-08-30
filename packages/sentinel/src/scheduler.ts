import fs from "node:fs";
import path from "node:path";
import {
  getPR,
  git,
  gitTry,
  githubToken,
  isMergedIntoMain,
  isReachable,
  killTree,
  loadConfig,
  makeLogger,
  mergePR,
  run,
  spawnDetached,
} from "@factory/shared";
import type { FactoryConfig, Incident } from "@factory/shared";
import { claimIncident, getApp, listIncidents, setIncident, statusChangedAt, type AppRow } from "./db.ts";
import { healIncident } from "./healer.ts";

const log = makeLogger("scheduler");
let active = 0;

/** One scheduler tick: claim & heal open incidents, land finished fixes, re-arm parked ones. */
export async function tick(): Promise<void> {
  const cfg = loadConfig();

  // 1. Dispatch healing agents (bounded; CAS claim prevents duplicates even with several tickers).
  for (const incident of listIncidents("open")) {
    if (active >= cfg.limits.healConcurrency) break;
    if (incident.attempts >= cfg.limits.maxHealAttempts) {
      setIncident(incident.id, { status: "failed", last_note: `gave up after ${incident.attempts} attempts: ${incident.lastNote ?? ""}`.slice(0, 500) });
      log.warn(`incident ${incident.id}: max heal attempts reached - marked failed`);
      continue;
    }
    const app = getApp(incident.appId);
    if (!app) {
      setIncident(incident.id, { status: "failed", last_note: "app not registered with sentinel" });
      continue;
    }
    if (!claimIncident(incident.id)) continue; // someone else won the claim
    active++;
    const claimed = { ...incident, attempts: incident.attempts + 1 };
    healIncident(claimed, app)
      .catch((err) => log.error(`healIncident crashed: ${err}`))
      .finally(() => {
        active--;
      });
  }

  // 2. Land fixes: merged (or auto-merged) -> redeploy -> health check -> resolved.
  for (const incident of listIncidents("pr_open")) {
    const app = getApp(incident.appId);
    if (!app) continue;
    try {
      // Captured before any merge or pull, so a rollback has a known-good target.
      const preSha = (await gitTry(app.dir, "rev-parse", "HEAD")) ?? "";

      let merged = await isHealMerged(app, incident);
      if (!merged && cfg.approvals.autoMergeHealPRs) merged = await autoMergeHeal(app, incident);
      if (!merged) continue;

      log.ok(`incident ${incident.id}: fix landed - redeploying ${app.name}`);
      await redeployAndVerify(cfg, app, incident, preSha);
    } catch (err) {
      log.warn(`poll incident ${incident.id}: ${String(err).slice(0, 200)}`);
    }
  }

  // 3. Unattended mode never leaves an incident parked forever: re-arm after a cooldown.
  if (cfg.autonomous.enabled) rearmFailedIncidents(cfg);
}

/** Has the heal branch already reached main (by a human, CI, or a previous tick)? */
async function isHealMerged(app: AppRow, incident: Incident): Promise<boolean> {
  if (app.repoFull && githubToken() && incident.prNumber) {
    return (await getPR(app.repoFull, incident.prNumber)).merged;
  }
  if (incident.branch) return isMergedIntoMain(app.dir, incident.branch);
  return false;
}

/** Merge the fix without a human: squash the PR on GitHub, or merge the branch locally. */
async function autoMergeHeal(app: AppRow, incident: Incident): Promise<boolean> {
  if (app.repoFull && githubToken() && incident.prNumber) {
    try {
      await mergePR(app.repoFull, incident.prNumber);
      log.ok(`incident ${incident.id}: PR #${incident.prNumber} auto-merged`);
      return true;
    } catch (err) {
      // Not mergeable yet (checks pending, conflict) - try again next tick.
      log.warn(`incident ${incident.id}: auto-merge deferred: ${String(err).slice(0, 200)}`);
      return false;
    }
  }

  if (!incident.branch) return false;
  const checkout = await gitTry(app.dir, "checkout", "main");
  if (checkout === null) return false;
  const merge = await gitTry(app.dir, "merge", "--no-ff", "--no-edit", incident.branch);
  if (merge === null) {
    await gitTry(app.dir, "merge", "--abort");
    log.warn(`incident ${incident.id}: local merge of ${incident.branch} conflicted - left for a human`);
    setIncident(incident.id, { last_note: `auto-merge conflicted on ${incident.branch}` });
    return false;
  }
  log.ok(`incident ${incident.id}: branch ${incident.branch} auto-merged into main`);
  return true;
}

/**
 * Redeploy after a fix lands and confirm the app still answers. An unattended
 * system that merges its own fixes must be able to undo one: a dead app reports
 * no further errors, so nothing would ever heal it.
 */
async function redeployAndVerify(
  cfg: FactoryConfig,
  app: AppRow,
  incident: Incident,
  preSha: string,
): Promise<void> {
  await redeployApp(app);

  const url = `http://localhost:${app.port}/`;
  if (await isReachable(url, cfg.autonomous.healthCheckMs)) {
    setIncident(incident.id, {
      status: "resolved",
      last_note: `fix merged, redeployed and healthy at ${new Date().toISOString()}`,
    });
    log.ok(`incident ${incident.id}: resolved - ${app.name} healthy after redeploy`);
    return;
  }

  log.error(`incident ${incident.id}: ${app.name} did not answer after redeploy`);
  if (!cfg.autonomous.rollbackOnUnhealthy || !preSha) {
    setIncident(incident.id, { status: "failed", last_note: "app unhealthy after redeploy; rollback disabled" });
    return;
  }

  await rollbackTo(app, preSha);
  await redeployApp(app);
  const recovered = await isReachable(url, cfg.autonomous.healthCheckMs);
  log.warn(`incident ${incident.id}: rolled back to ${preSha.slice(0, 8)} (recovered=${recovered})`);

  const rearms = incident.rearms + 1;
  const note =
    `fix broke the app and was rolled back to ${preSha.slice(0, 8)} (recovered=${recovered}). ` +
    `The previous fix was wrong - try a different approach.`;
  if (cfg.autonomous.maxIncidentRearms && rearms > cfg.autonomous.maxIncidentRearms) {
    setIncident(incident.id, { status: "failed", last_note: `${note} Re-arm budget spent.`.slice(0, 500) });
  } else {
    setIncident(incident.id, { status: "open", attempts: 0, rearms, last_note: note.slice(0, 500) });
  }
}

/** Undo everything after `sha` on main. Reverts (and pushes) when a remote is in play. */
async function rollbackTo(app: AppRow, sha: string): Promise<void> {
  if (app.repoFull && githubToken()) {
    await gitTry(app.dir, "revert", "--no-edit", "--no-commit", `${sha}..HEAD`);
    await gitTry(app.dir, "commit", "-m", `revert: automated rollback to ${sha.slice(0, 8)} (failed health check)`);
    await gitTry(app.dir, "push", "origin", "main");
  } else {
    await gitTry(app.dir, "reset", "--hard", sha);
  }
}

/** Give up permanently only when the re-arm budget is spent. */
function rearmFailedIncidents(cfg: FactoryConfig): void {
  const cooldown = cfg.autonomous.incidentRetryCooldownMs;
  const cap = cfg.autonomous.maxIncidentRearms;

  for (const inc of listIncidents("failed")) {
    const since = statusChangedAt(inc.id);
    const age = since ? Date.now() - Date.parse(since) : Number.NaN;
    if (!Number.isFinite(age) || age < cooldown) continue;

    const rearms = inc.rearms + 1;
    if (cap && rearms > cap) continue; // stays failed; a human can POST /incidents/:id/retry
    setIncident(inc.id, {
      status: "open",
      attempts: 0,
      rearms,
      last_note: `auto re-armed (${rearms}/${cap || "unlimited"}) after cooldown; previous: ${(inc.lastNote ?? "").slice(0, 300)}`,
    });
    log.info(`incident ${inc.id}: auto re-armed for another healing attempt (${rearms})`);
  }
}

/** Pull latest main into the app dir, restart the app process. */
export async function redeployApp(app: AppRow): Promise<void> {
  const cfg = loadConfig();
  if (app.repoFull && githubToken()) {
    await gitTry(app.dir, "fetch", "origin");
    await git(app.dir, "checkout", "main");
    await git(app.dir, "pull", "origin", "main");
  }
  await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: app.dir, timeoutMs: 180000 });

  const runFile = path.join(app.dir, ".factory", "run.json");
  if (fs.existsSync(runFile)) {
    try {
      const { pid } = JSON.parse(fs.readFileSync(runFile, "utf8"));
      if (pid) killTree(pid);
    } catch { /* ignore */ }
  }
  await new Promise((r) => setTimeout(r, 1500));
  const sha = (await gitTry(app.dir, "rev-parse", "HEAD")) ?? "";
  const pid = spawnDetached("npm", ["start"], {
    cwd: app.dir,
    env: {
      PORT: String(app.port),
      FACTORY_APP_ID: app.appId,
      SENTINEL_URL: cfg.sentinel.url,
      FACTORY_RELEASE: sha,
    },
    logFile: path.join(app.dir, ".factory", "app.log"),
  });
  fs.mkdirSync(path.dirname(runFile), { recursive: true });
  fs.writeFileSync(runFile, JSON.stringify({ pid, port: app.port }, null, 2));
  log.ok(`${app.name} restarted on port ${app.port} (pid ${pid}, release ${sha.slice(0, 8)})`);
}

export function startScheduler(intervalMs = 15000): NodeJS.Timeout {
  log.info(`scheduler running every ${intervalMs / 1000}s`);
  const t = setInterval(() => {
    tick().catch((err) => log.error(`tick failed: ${err}`));
  }, intervalMs);
  t.unref();
  return t;
}
