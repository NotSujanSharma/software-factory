import { runAgentForJson } from "@factory/agents";
import type { Defect, StageName, WorkItem } from "@factory/shared";
import { commitAll } from "@factory/shared";
import { outPath, clearOut, DevReport } from "../state.ts";
import { agentMeta, beginStage, endStage, readIfExists, type Ctx } from "./context.ts";

function itemPrompt(ctx: Ctx, item: WorkItem): string {
  return [
    `Work item ${item.id}: ${item.title}`,
    item.description,
    item.acceptance?.length ? `Acceptance: ${item.acceptance.join("; ")}` : "",
    `Requirements summary:\n${readIfExists(ctx.appDir, "requirements.md", 6000)}`,
    `Architecture:\n${readIfExists(ctx.appDir, "architecture.md", 6000)}`,
    `When done write .factory/out/dev-report.json with itemId "${item.id}".`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function runDevItem(ctx: Ctx, item: WorkItem): Promise<boolean> {
  clearOut(ctx.appDir, "dev-report");
  item.status = "in_progress";
  ctx.save();
  try {
    const { data } = await runAgentForJson({
      role: "developer",
      prompt: itemPrompt(ctx, item),
      cwd: ctx.appDir,
      outFile: outPath(ctx.appDir, "dev-report"),
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

/**
 * Wave-based DAG scheduler: run independent ready items in parallel (capped),
 * commit after each wave to keep git history coherent.
 */
export async function developmentStage(ctx: Ctx): Promise<void> {
  beginStage(ctx, "development");
  const cap = Math.max(1, ctx.cfg.limits.devConcurrency);

  for (;;) {
    const done = new Set(ctx.state.tasks.filter((t) => t.status === "done").map((t) => t.id));
    const ready = ctx.state.tasks.filter(
      (t) => t.status === "pending" && t.dependsOn.every((d) => done.has(d)),
    );
    if (ready.length === 0) break;

    // Parallel dev agents share one working tree, so only batch items when >1 is ready;
    // serialize the scaffold-style first item naturally via its dependents.
    const wave = ready.slice(0, cap);
    ctx.log.info(`development wave: ${wave.map((w) => w.id).join(", ")}`);
    const results =
      wave.length === 1
        ? [await runDevItem(ctx, wave[0])]
        : await Promise.all(wave.map((item) => runDevItem(ctx, item)));

    await commitAll(ctx.appDir, `feat: ${wave.map((w) => `${w.id} ${w.title}`).join("; ")}`);
    if (results.every((r) => !r)) break; // no progress -> stop
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
    JSON.stringify(defects, null, 2),
    "Add or update tests proving each fix. Run npm test before finishing.",
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
