import { runAgentForJson } from "@factory/agents";
import type { WorkItem } from "@factory/shared";
import { outPath, clearOut, TasksOut } from "../state.ts";
import { agentMeta, beginStage, endStage, readIfExists, type Ctx } from "./context.ts";

export async function architectureStage(ctx: Ctx): Promise<void> {
  beginStage(ctx, "architecture");
  clearOut(ctx.appDir, "tasks");
  const out = outPath(ctx.appDir, "tasks");

  const prompt = [
    "Design the architecture and task breakdown for the app specified in requirements.md.",
    `Acceptance criteria:\n${JSON.stringify(ctx.state.criteria, null, 2)}`,
    "Write architecture.md and .factory/out/tasks.json exactly per your role instructions.",
  ].join("\n\n");

  const { data } = await runAgentForJson({
    role: "architect",
    prompt,
    cwd: ctx.appDir,
    outFile: out,
    parse: (raw) => TasksOut.parse(raw),
    logFile: ctx.agentLog("architecture"),
    ...agentMeta(ctx, "architecture"),
  });

  ctx.state.tasks = data.items.map(
    (i): WorkItem => ({ ...i, dependsOn: i.dependsOn ?? [], status: "pending" }),
  );
  endStage(ctx, "architecture", "passed", `${ctx.state.tasks.length} work items`);
}
