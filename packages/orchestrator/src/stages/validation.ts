import { runAgentForJson } from "@factory/agents";
import type { WorkItem } from "@factory/shared";
import { outPath, clearOut, ValidationOut } from "../state.ts";
import { agentMeta, beginStage, endStage, type Ctx } from "./context.ts";
import { developmentStage } from "./development.ts";
import { gateStage } from "./gates.ts";

export async function validationStage(ctx: Ctx): Promise<void> {
  beginStage(ctx, "validation");
  const rounds = ctx.cfg.limits.validationRounds;

  for (let round = 1; round <= rounds; round++) {
    clearOut(ctx.appDir, "validation");
    const { data } = await runAgentForJson({
      role: "validator",
      prompt: [
        `Validate every acceptance criterion (round ${round} of max ${rounds}).`,
        ctx.stackContext(),
        `Criteria:\n${JSON.stringify(ctx.state.criteria, null, 2)}`,
        "Write .factory/out/validation.json exactly per your role instructions.",
      ].join("\n\n"),
      cwd: ctx.appDir,
      outFile: outPath(ctx.appDir, "validation"),
      parse: (raw) => ValidationOut.parse(raw),
      logFile: ctx.agentLog("validation"),
      scope: "validation",
      ...agentMeta(ctx, "validation"),
    });

    if (data.passed && data.unmet.length === 0) {
      endStage(ctx, "validation", "passed", `${data.met.length}/${ctx.state.criteria.length} criteria met`);
      return;
    }

    ctx.log.warn(`validation: ${data.unmet.length} unmet criteria`);
    if (round === rounds) {
      endStage(ctx, "validation", "needs_human", `unmet: ${data.unmet.map((u) => u.criterionId).join(", ")}`);
      throw new Error("validation failed: unmet acceptance criteria remain");
    }

    // Turn each unmet criterion into a new work item and re-enter dev + QA.
    let n = ctx.state.tasks.length;
    for (const u of data.unmet) {
      const item: WorkItem = {
        id: `V${round}-${++n}`,
        title: u.workItem?.title ?? `Close gap on ${u.criterionId}`,
        description: `${u.workItem?.description ?? u.reason}\n\nThis closes acceptance criterion ${u.criterionId}: ${u.reason}`,
        dependsOn: [],
        acceptance: [u.criterionId],
        status: "pending",
      };
      ctx.state.tasks.push(item);
    }
    ctx.save();
    await developmentStage(ctx);
    await gateStage(ctx, "qa");
  }
}
