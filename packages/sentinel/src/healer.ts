import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { runAgentForJson } from "@factory/agents";
import {
  createPR,
  git,
  gitClone,
  githubToken,
  makeLogger,
  remoteUrl,
  run,
} from "@factory/shared";
import type { Incident } from "@factory/shared";
import { setIncident, type AppRow } from "./db.ts";

const log = makeLogger("healer");

const HealOut = z.object({
  fixed: z.boolean(),
  rootCause: z.string(),
  fixSummary: z.string(),
  testAdded: z.string().optional(),
});

/**
 * Heal one claimed incident: clone -> branch -> RCA+fix agent -> test -> push -> PR.
 * Caller has already CAS-claimed the incident (status=healing), so this run is exclusive.
 */
export async function healIncident(incident: Incident, app: AppRow): Promise<void> {
  const branch = `heal/incident-${incident.id}-attempt-${incident.attempts}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `heal-${incident.id}-`));
  log.info(`healing incident ${incident.id} (${incident.fingerprint}) in ${work}`);

  try {
    // Clone from GitHub when available (that is where the PR lives), else from the local repo.
    const source =
      app.repoFull && githubToken() ? remoteUrl(`https://github.com/${app.repoFull}.git`) : app.dir;
    await gitClone(source, work);
    await git(work, "config", "user.email", "healer@self-healing.local");
    await git(work, "config", "user.name", "Factory Healer");
    await git(work, "checkout", "-b", branch);
    fs.mkdirSync(path.join(work, ".factory", "out"), { recursive: true });

    const priorContext = incident.lastNote ? `\nPrior history: ${incident.lastNote}` : "";
    const { data } = await runAgentForJson({
      role: "healer",
      prompt: [
        `Incident #${incident.id} - occurred ${incident.count} time(s), first ${incident.firstSeen}, last ${incident.lastSeen}.${priorContext}`,
        `Error: ${incident.sampleEvent.type}: ${incident.sampleEvent.message}`,
        `Stack:\n${incident.sampleEvent.stack ?? "(none)"}`,
        `Request context: ${JSON.stringify(incident.sampleEvent.context ?? {}, null, 2)}`,
        `Release: ${incident.sampleEvent.release ?? "unknown"}`,
        "Follow your role procedure. Write .factory/out/heal.json when done.",
      ].join("\n\n"),
      cwd: work,
      outFile: path.join(work, ".factory", "out", "heal.json"),
      parse: (raw) => HealOut.parse(raw),
      logFile: path.join(work, "heal-agent.log"),
      scope: `heal:${incident.id}`,
      appId: app.appId,
      appName: app.name,
      stage: "heal",
    });

    if (!data.fixed) {
      setIncident(incident.id, { status: "failed", last_note: `not code-fixable: ${data.rootCause.slice(0, 400)}` });
      log.warn(`incident ${incident.id}: healer says not fixable - ${data.rootCause.slice(0, 160)}`);
      return;
    }

    // Verify the suite really passes before shipping the fix.
    const test = await run("npm", ["test"], { cwd: work, timeoutMs: 300000 });
    if (test.code !== 0) {
      throw new Error(`healer claimed fixed but npm test exits ${test.code}:\n${(test.stderr || test.stdout).slice(-1500)}`);
    }

    await git(work, "add", "-A");
    await git(work, "commit", "-m", `fix: heal incident ${incident.id} - ${data.fixSummary.slice(0, 100)}`);
    await git(work, "push", "origin", branch);

    const prBody = [
      `Automated fix for incident **#${incident.id}** (${incident.count} occurrence(s)).`,
      `**Error:** \`${incident.sampleEvent.type}: ${incident.sampleEvent.message.slice(0, 200)}\``,
      `**Root cause:** ${data.rootCause}`,
      `**Fix:** ${data.fixSummary}`,
      data.testAdded ? `**Regression test:** \`${data.testAdded}\`` : "",
      "See RCA.md in this branch for the full analysis.",
    ]
      .filter(Boolean)
      .join("\n\n");

    if (app.repoFull && githubToken()) {
      const pr = await createPR(app.repoFull, {
        title: `[self-heal] Fix incident #${incident.id}: ${incident.sampleEvent.message.slice(0, 60)}`,
        body: prBody,
        head: branch,
        base: "main",
      });
      setIncident(incident.id, { status: "pr_open", pr_url: pr.html_url, pr_number: pr.number, branch });
      log.ok(`incident ${incident.id}: PR opened ${pr.html_url}`);
    } else {
      // Local-only mode: the pushed branch is the "PR"; merging it resolves the incident.
      fs.writeFileSync(path.join(app.dir, `.factory/heal-${incident.id}.md`), prBody);
      setIncident(incident.id, { status: "pr_open", branch, last_note: `local branch ${branch} pushed; merge to main to resolve` });
      log.ok(`incident ${incident.id}: local heal branch ${branch} pushed`);
    }
  } catch (err) {
    const msg = String(err).slice(0, 500);
    log.error(`healing incident ${incident.id} failed: ${msg}`);
    // Return to open for another attempt, or park as failed after max attempts (scheduler enforces).
    setIncident(incident.id, { status: "open", last_note: `attempt ${incident.attempts} failed: ${msg}` });
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}
