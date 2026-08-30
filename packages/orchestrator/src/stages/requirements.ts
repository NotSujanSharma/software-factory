import { runAgentForJson } from "@factory/agents";
import { outPath, clearOut, RequirementsOut } from "../state.ts";
import { beginStage, endStage, type Ctx } from "./context.ts";

export async function requirementsStage(ctx: Ctx, extraContext: string): Promise<void> {
  beginStage(ctx, "requirements");
  clearOut(ctx.appDir, "requirements");
  const out = outPath(ctx.appDir, "requirements");

  const prompt = [
    `Product request: ${ctx.state.app.prompt}`,
    extraContext ? `Additional context from the user:\n${extraContext}` : "",
    `Produce requirements.md and the JSON file at ${rel(out)} exactly per your role instructions.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const { data } = await runAgentForJson({
    role: "requirements",
    prompt,
    cwd: ctx.appDir,
    outFile: out,
    parse: (raw) => RequirementsOut.parse(raw),
    logFile: ctx.agentLog("requirements"),
  });

  ctx.state.criteria = data.criteria;
  ctx.state.assumptions = data.assumptions;
  endStage(ctx, "requirements", "passed", `${data.criteria.length} acceptance criteria`);
}

function rel(p: string): string {
  return ".factory/out/requirements.json";
}
