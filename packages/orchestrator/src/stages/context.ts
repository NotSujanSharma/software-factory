import path from "node:path";
import fs from "node:fs";
import { resolveStack, stackBrief, type AppStack } from "@factory/stacks";
import type { FactoryConfig, PipelineState, StageName } from "@factory/shared";
import { makeLogger, type Logger } from "@factory/shared";
import { logsDir, saveState, stageRec } from "../state.ts";

export interface Ctx {
  cfg: FactoryConfig;
  state: PipelineState;
  appDir: string;
  log: Logger;
  save(): void;
  agentLog(stage: string): string;
  /** The app's stack, re-read each time so an agent's edits take effect. */
  stack(): AppStack;
  /** The stack block appended to agent prompts. */
  stackContext(): string;
}

export function makeCtx(cfg: FactoryConfig, state: PipelineState, appDir: string): Ctx {
  return {
    cfg,
    state,
    appDir,
    log: makeLogger("pipeline"),
    save: () => saveState(appDir, state),
    agentLog: (stage: string) =>
      path.join(logsDir(appDir), `${stage}-${Date.now()}.log`),
    stack: () => resolveStack(appDir),
    stackContext: () => stackBrief(resolveStack(appDir)),
  };
}

export function beginStage(ctx: Ctx, name: StageName): void {
  const rec = stageRec(ctx.state, name);
  rec.status = "running";
  rec.startedAt = rec.startedAt ?? new Date().toISOString();
  rec.iterations += 1;
  ctx.save();
  ctx.log.info(`=== stage ${name} (iteration ${rec.iterations}) ===`);
}

export function endStage(ctx: Ctx, name: StageName, status: "passed" | "failed" | "needs_human", notes?: string): void {
  const rec = stageRec(ctx.state, name);
  rec.status = status;
  rec.finishedAt = new Date().toISOString();
  if (notes) rec.notes = notes;
  ctx.save();
  const fn = status === "passed" ? "ok" : "warn";
  ctx.log[fn](`=== stage ${name}: ${status} ${notes ? `(${notes})` : ""} ===`);
}

/** Ledger/budget attribution for an agent run belonging to this app. */
export function agentMeta(ctx: Ctx, stage?: StageName): { appId: string; appName: string; stage?: string } {
  return { appId: ctx.state.app.id, appName: ctx.state.app.name, stage };
}

/** Read a small file if present (for prompt context). */
export function readIfExists(appDir: string, rel: string, maxChars = 12000): string {
  const p = path.join(appDir, rel);
  if (!fs.existsSync(p)) return "(missing)";
  const text = fs.readFileSync(p, "utf8");
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…(truncated)" : text;
}
