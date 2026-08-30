import fs from "node:fs";
import path from "node:path";
import { runAgentForJson } from "@factory/agents";
import { availableStackCatalogue, missingTools, saveStack } from "@factory/stacks";
import { commitAll } from "@factory/shared";
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
    "Choose the stack that genuinely suits these requirements - language, framework and",
    "data store. You are not restricted to the templates below; they are starting points",
    "with known-good defaults, and you may declare a custom stack instead.",
    "Templates marked NOT INSTALLED cannot be built on this machine. Do not choose one,",
    "and do not choose a custom stack needing a toolchain that is not there.",
    `Built-in templates:\n${availableStackCatalogue()}`,
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

  // Fail here rather than after a developer agent has written a service in a
  // language this machine cannot build. Nothing downstream can retry its way out
  // of a missing toolchain, so this is permanent.
  const missing = missingTools(data.stack);
  if (missing.length) {
    endStage(ctx, "architecture", "needs_human", `toolchain missing: ${missing.join(", ")}`);
    throw new StackUnavailableError(data.stack.label, missing);
  }

  // The stack has to land before development starts: every gate after this point
  // runs its commands, and the deploy stage vendors an SDK based on it.
  saveStack(ctx.appDir, data.stack);
  writeStackIgnore(ctx.appDir, data.stack.ignore);
  await commitAll(ctx.appDir, `chore: adopt ${data.stack.label} stack`);
  ctx.log.ok(`stack: ${data.stack.label} (${data.stack.language})`);

  ctx.state.tasks = data.items.map(
    (i): WorkItem => ({ ...i, dependsOn: i.dependsOn ?? [], status: "pending" }),
  );
  endStage(ctx, "architecture", "passed", `${data.stack.label}, ${ctx.state.tasks.length} work items`);
}

/**
 * Keep the generated repo's .gitignore in step with its stack.
 *
 * The app is created before the stack is known, so it starts with a generic
 * ignore file; once the architect has chosen, its build artefacts go in too.
 */
function writeStackIgnore(appDir: string, ignore: string[]): void {
  const file = path.join(appDir, ".gitignore");
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : [];
  const merged = [...new Set([...existing, ...ignore].map((l) => l.trim()).filter(Boolean))];
  fs.writeFileSync(file, merged.join("\n") + "\n");
}

/** The chosen stack cannot be built here, and no amount of retrying will change that. */
export class StackUnavailableError extends Error {
  readonly permanent = true;
  constructor(label: string, missing: string[]) {
    super(
      `the architect chose ${label}, but this machine is missing: ${missing.join(", ")}. ` +
        `Install them, or re-run with a prompt that asks for a different stack.`,
    );
    this.name = "StackUnavailableError";
  }
}
