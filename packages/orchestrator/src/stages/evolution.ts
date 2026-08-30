import { runAgentForJson } from "@factory/agents";
import { commitAll } from "@factory/shared";
import { outPath, clearOut, EvolutionOut } from "../state.ts";
import { agentMeta, beginStage, endStage, type Ctx } from "./context.ts";
import type { z } from "zod";

export type EvolutionData = z.infer<typeof EvolutionOut>;

export async function evolutionStage(ctx: Ctx): Promise<EvolutionData> {
  beginStage(ctx, "evolution");
  clearOut(ctx.appDir, "evolution");
  const { data } = await runAgentForJson({
    role: "evolution",
    prompt: [
      "Analyze the shipped application and produce your improvement proposals.",
      ctx.stackContext(),
      "Write IMPROVEMENTS.md and .factory/out/evolution.json exactly per your role instructions.",
    ].join("\n\n"),
    cwd: ctx.appDir,
    outFile: outPath(ctx.appDir, "evolution"),
    parse: (raw) => EvolutionOut.parse(raw),
    logFile: ctx.agentLog("evolution"),
    scope: "evolution",
    ...agentMeta(ctx, "evolution"),
  });
  await commitAll(ctx.appDir, "docs: evolution analysis and improvement proposals");
  endStage(ctx, "evolution", "passed", `${data.proposals.length} proposals`);
  return data;
}
