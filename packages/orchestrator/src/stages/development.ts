import path from "node:path";
import { runAgentForJson } from "@factory/agents";
import { runStackPhase } from "@factory/stacks";
import type { Defect, StageName, WorkItem, Worktree } from "@factory/shared";
import {
  commitAll,
  commitWorktree,
  createWorktree,
  ensureWorktreesIgnored,
  mergeWorktree,
  pruneWorktrees,
  removeWorktree,
} from "@factory/shared";
import { clearOut, outPath, DevReport } from "../state.ts";
import { agentMeta, beginStage, endStage, readIfExists, type Ctx } from "./context.ts";

function itemPrompt(ctx: Ctx, item: WorkItem, isolated: boolean, dir: string): string {
  return [
    `Work item ${item.id}: ${item.title}`,
    item.description,
    item.acceptance?.length ? `Acceptance: ${item.acceptance.join("; ")}` : "",
    ctx.stackContext(),
    isolated
      ? `You are working in your own git worktree, in parallel with other agents. You cannot see ` +
        `their changes and they cannot see yours; your work is merged afterwards. Stay inside the ` +
        `files this work item calls for - editing shared files you were not asked to touch is what ` +
        `turns a clean merge into a conflict. Do NOT run git commit, merge, rebase, checkout or ` +
        `push: the factory commits and merges your work for you.`
      : "",
    `Requirements summary:\n${readIfExists(ctx.appDir, "requirements.md", 6000)}`,
    `Architecture:\n${readIfExists(ctx.appDir, "architecture.md", 6000)}`,
    // Absolute, not `.factory/out/dev-report.json`. In a worktree the relative
    // form is ambiguous - the app checkout one level up has a `.factory/out`
    // too - and a Codex agent resolves it there, so the report lands where the
    // runner does not read it and the guard denies the write as an escape.
    `When done write ${outPath(dir, "dev-report")} with itemId "${item.id}". ` +
      `Use exactly that path, not a path relative to the repository root.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Run one work item to completion in `dir`, which is either the app checkout or a
 * worktree of it. Returns whether the agent reported success.
 */
async function runDevItem(ctx: Ctx, item: WorkItem, dir: string, isolated: boolean): Promise<boolean> {
  clearOut(dir, "dev-report");
  item.status = "in_progress";
  ctx.save();
  try {
    const { data } = await runAgentForJson({
      role: "developer",
      prompt: itemPrompt(ctx, item, isolated, dir),
      cwd: dir,
      outFile: outPath(dir, "dev-report"),
      parse: (raw) => DevReport.parse(raw),
      logFile: ctx.agentLog(`dev-${item.id}`),
      scope: `dev:${item.id}`,
      ...agentMeta(ctx, "development"),
    });
    item.status = data.done ? "done" : "failed";
    ctx.save();
    return data.done;
  } catch (err) {
    ctx.log.error(`dev item ${item.id} failed:`, err);
    item.status = "failed";
    ctx.save();
    return false;
  }
}

interface DevOutcome {
  item: WorkItem;
  done: boolean;
  worktree?: Worktree;
}

/**
 * Run a wave of items in parallel, each in its own worktree, then merge them back
 * one at a time.
 *
 * Items whose merge conflicts are reported back to the caller rather than resolved
 * here: two agents genuinely edited the same lines, and guessing which was right is
 * how an automated system quietly destroys work. The caller re-queues them to be
 * rebuilt serially against the merged tree.
 */
async function runIsolatedWave(ctx: Ctx, wave: WorkItem[]): Promise<{ results: boolean[]; conflicted: string[] }> {
  const stack = ctx.stack();

  const outcomes: DevOutcome[] = await Promise.all(
    wave.map(async (item): Promise<DevOutcome> => {
      let worktree: Worktree;
      try {
        worktree = await createWorktree(ctx.appDir, item.id);
      } catch (err) {
        ctx.log.error(`could not create a worktree for ${item.id}: ${err}`);
        item.status = "failed";
        ctx.save();
        return { item, done: false };
      }

      // A fresh worktree has no dependencies: they live in ignored directories that
      // git does not carry across. Without this the agent's first test run fails for
      // reasons that have nothing to do with its work item.
      const install = await runStackPhase(ctx.cfg, stack, "install", { cwd: worktree.dir, timeoutMs: 300_000 });
      if (install && install.code !== 0) {
        ctx.log.warn(`${item.id}: install in worktree failed: ${(install.stderr || install.stdout).slice(-300)}`);
      }

      const done = await runDevItem(ctx, item, worktree.dir, true);
      return { item, done, worktree };
    }),
  );

  // Merge sequentially, in wave order, so a rerun behaves the same way.
  const results: boolean[] = [];
  const conflicted: string[] = [];

  for (const outcome of outcomes) {
    const { item, worktree } = outcome;
    let done = outcome.done;

    if (worktree) {
      if (done) {
        const sha = await commitWorktree(worktree, `feat: ${item.id} ${item.title}`);
        if (!sha) {
          ctx.log.warn(`${item.id}: agent reported success but changed nothing`);
          item.status = "failed";
          done = false;
        } else {
          const merge = await mergeWorktree(ctx.appDir, worktree.branch, `merge: ${item.id} ${item.title}`);
          if (merge.merged) {
            ctx.log.ok(`${item.id}: merged (${merge.detail})`);
          } else {
            ctx.log.warn(`${item.id}: ${merge.detail} - re-queued to be rebuilt against the merged tree`);
            item.status = "pending";
            conflicted.push(item.id);
            done = false;
          }
        }
        ctx.save();
      }
      await removeWorktree(worktree);
    }
    results.push(done);
  }
  return { results, conflicted };
}

/**
 * Choose the next wave of work items.
 *
 * An item that lost a merge is rebuilt **alone**, against the tree that beat it.
 * Without that rule two items which conflict with each other would be re-queued
 * together forever, each wave faithfully recreating the collision that caused it.
 * A wave of one runs in the app checkout, where there is no merge and so no
 * conflict, which is what guarantees the loop terminates.
 *
 * Pure, so the scheduling rules can be tested without running an agent.
 */
export function selectWave(tasks: WorkItem[], cap: number, rebuildSerially: ReadonlySet<string>): WorkItem[] {
  const done = new Set(tasks.filter((t) => t.status === "done").map((t) => t.id));
  const ready = tasks.filter((t) => t.status === "pending" && t.dependsOn.every((d) => done.has(d)));
  if (ready.length === 0) return [];

  const needsRebuild = ready.find((t) => rebuildSerially.has(t.id));
  if (needsRebuild) return [needsRebuild];
  return ready.slice(0, Math.max(1, cap));
}

/**
 * Wave-based DAG scheduler: run independent ready items in parallel, merging each
 * agent's isolated worktree back into the app checkout.
 *
 * A single-item wave runs directly in the app checkout - there is nothing to
 * isolate it from, and a worktree would only add a dependency install. Anything
 * wider gets one worktree per agent.
 */
export async function developmentStage(ctx: Ctx): Promise<void> {
  beginStage(ctx, "development");
  const cap = Math.max(1, ctx.cfg.limits.devConcurrency);

  // Apps built before worktrees existed do not ignore the worktree root, and an
  // interrupted run can leave worktrees behind whose branches would collide with
  // the ones this run is about to create.
  ensureWorktreesIgnored(ctx.appDir);
  await pruneWorktrees(ctx.appDir);

  // Items that lost a merge and must be rebuilt alone. See selectWave.
  const rebuildSerially = new Set<string>();

  try {
    for (;;) {
      const wave = selectWave(ctx.state.tasks, cap, rebuildSerially);
      if (wave.length === 0) break;

      const serial = wave.length === 1 && rebuildSerially.has(wave[0].id);
      ctx.log.info(`development wave: ${wave.map((w) => w.id).join(", ")}${serial ? " (serial rebuild)" : ""}`);

      let results: boolean[];
      if (wave.length === 1) {
        rebuildSerially.delete(wave[0].id);
        results = [await runDevItem(ctx, wave[0], ctx.appDir, false)];
        await commitAll(ctx.appDir, `feat: ${wave[0].id} ${wave[0].title}`);
      } else {
        const outcome = await runIsolatedWave(ctx, wave);
        results = outcome.results;
        for (const id of outcome.conflicted) rebuildSerially.add(id);
        // Worktree work is already committed and merged; this catches anything the
        // orchestrator itself left in the tree.
        await commitAll(ctx.appDir, `chore: record ${wave.map((w) => w.id).join(", ")}`);
      }

      // A conflicted item made no progress but is not stuck - it will be rebuilt.
      if (results.every((r) => !r) && rebuildSerially.size === 0) break;
    }
  } finally {
    await pruneWorktrees(ctx.appDir);
  }

  const failed = ctx.state.tasks.filter((t) => t.status === "failed" || t.status === "pending");
  if (failed.length) {
    endStage(ctx, "development", "needs_human", `unfinished items: ${failed.map((t) => t.id).join(", ")}`);
    throw new Error(`development incomplete: ${failed.map((t) => t.id).join(", ")}`);
  }
  endStage(ctx, "development", "passed", `${ctx.state.tasks.length} items done`);
}

/** Run a developer agent to fix a batch of defects (used by QA/review/security/validation loops). */
export async function runDefectFix(ctx: Ctx, source: StageName, defects: Defect[]): Promise<void> {
  clearOut(ctx.appDir, "dev-report");
  const prompt = [
    `Fix the following ${source} defects in this repository. Address every blocker and major defect; fix minors when cheap.`,
    ctx.stackContext(),
    JSON.stringify(defects, null, 2),
    "Add or update tests proving each fix. Run the test command before finishing.",
    'When done write .factory/out/dev-report.json (use itemId "defect-fix").',
  ].join("\n\n");
  await runAgentForJson({
    role: "developer",
    prompt,
    cwd: ctx.appDir,
    outFile: outPath(ctx.appDir, "dev-report"),
    parse: (raw) => DevReport.parse(raw),
    logFile: ctx.agentLog(`fix-${source}`),
    scope: `fix:${source}`,
    ...agentMeta(ctx, source),
  });
  await commitAll(ctx.appDir, `fix: address ${source} defects (${defects.map((d) => d.id).join(", ")})`);
}
