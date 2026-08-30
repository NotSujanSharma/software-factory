import { runAgentForJson, type Role } from "@factory/agents";
import type { Defect, StageName } from "@factory/shared";
import { outPath, clearOut, GateOut } from "../state.ts";
import { agentMeta, beginStage, endStage, type Ctx } from "./context.ts";
import { runDefectFix } from "./development.ts";

interface GateSpec {
  stage: StageName & ("qa" | "review" | "security");
  role: Role;
  outName: string;
  maxIterations(ctx: Ctx): number;
}

const SPECS: GateSpec[] = [
  { stage: "qa", role: "qa", outName: "qa", maxIterations: (c) => c.cfg.limits.qaIterations },
  { stage: "review", role: "reviewer", outName: "review", maxIterations: (c) => c.cfg.limits.reviewIterations },
  { stage: "security", role: "security", outName: "security", maxIterations: (c) => c.cfg.limits.securityIterations },
];

/**
 * Generic verify->fix loop: run the gate agent; if blocker/major defects are
 * found, hand them to a developer agent and re-run the gate, bounded by config.
 */
export async function gateStage(ctx: Ctx, name: "qa" | "review" | "security"): Promise<void> {
  const spec = SPECS.find((s) => s.stage === name)!;
  beginStage(ctx, name);
  const max = spec.maxIterations(ctx);

  for (let i = 1; i <= max; i++) {
    clearOut(ctx.appDir, spec.outName);
    const { data } = await runAgentForJson({
      role: spec.role,
      prompt: [
        `Run your ${name} pass on this repository (pass ${i} of max ${max}).`,
        ctx.stackContext(),
        `Write your verdict to .factory/out/${spec.outName}.json exactly per your role instructions.`,
      ].join("\n\n"),
      cwd: ctx.appDir,
      outFile: outPath(ctx.appDir, spec.outName),
      parse: (raw) => GateOut.parse(raw),
      logFile: ctx.agentLog(name),
      scope: name,
      ...agentMeta(ctx, name),
    });

    const blocking = data.defects.filter((d) => d.severity !== "minor");
    for (const d of data.defects) {
      ctx.state.defectsLog.push({ ...d, source: name } as Defect);
    }
    ctx.save();

    if (data.passed && blocking.length === 0) {
      endStage(ctx, name, "passed", data.summary.slice(0, 200));
      return;
    }
    ctx.log.warn(`${name}: ${blocking.length} blocking defect(s) - ${data.summary.slice(0, 160)}`);
    if (i === max) {
      endStage(ctx, name, "needs_human", `still failing after ${max} iterations: ${data.summary.slice(0, 200)}`);
      throw new Error(`${name} gate failed after ${max} iterations`);
    }
    await runDefectFix(ctx, name, blocking.map((d) => ({ ...d, source: name }) as Defect));
  }
}
