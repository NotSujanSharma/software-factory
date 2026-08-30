import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AppMeta, PipelineState, StageName, StageRecord } from "@factory/shared";

export const STAGE_ORDER: StageName[] = [
  "requirements",
  "architecture",
  "development",
  "qa",
  "review",
  "security",
  "validation",
  "deploy",
  "evolution",
];

export function statePath(appDir: string): string {
  return path.join(appDir, ".factory", "state.json");
}

export function outPath(appDir: string, name: string): string {
  return path.join(appDir, ".factory", "out", `${name}.json`);
}

export function logsDir(appDir: string): string {
  const d = path.join(appDir, ".factory", "logs");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function newState(app: AppMeta): PipelineState {
  const now = new Date().toISOString();
  return {
    app,
    stages: STAGE_ORDER.map((name): StageRecord => ({ name, status: "pending", iterations: 0 })),
    tasks: [],
    criteria: [],
    defectsLog: [],
    assumptions: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function loadState(appDir: string): PipelineState {
  return JSON.parse(fs.readFileSync(statePath(appDir), "utf8")) as PipelineState;
}

export function saveState(appDir: string, state: PipelineState): void {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(statePath(appDir)), { recursive: true });
  fs.writeFileSync(statePath(appDir), JSON.stringify(state, null, 2));
}

export function stageRec(state: PipelineState, name: StageName): StageRecord {
  const rec = state.stages.find((s) => s.name === name);
  if (!rec) throw new Error(`unknown stage ${name}`);
  return rec;
}

/**
 * Put a parked pipeline back into a runnable shape: stages that failed, parked or
 * were interrupted mid-flight go back to pending, as do tasks that failed or were
 * left in_progress. Stages already `passed` are untouched so nothing is redone.
 */
export function rearmState(state: PipelineState): void {
  for (const s of state.stages) {
    if (s.status === "failed" || s.status === "needs_human" || s.status === "running") s.status = "pending";
  }
  for (const t of state.tasks) {
    if (t.status === "in_progress" || t.status === "failed") t.status = "pending";
  }
}

/** Force specific stages back to pending so they re-run (used by the evolution loop). */
export function reopenStages(state: PipelineState, names: StageName[]): void {
  for (const name of names) stageRec(state, name).status = "pending";
}

/** Remove a stale agent output file before a fresh run. */
export function clearOut(appDir: string, name: string): void {
  fs.rmSync(outPath(appDir, name), { force: true });
  fs.mkdirSync(path.dirname(outPath(appDir, name)), { recursive: true });
}

// ---------- zod schemas for agent JSON contracts ----------

export const RequirementsOut = z.object({
  appName: z.string().min(1),
  summary: z.string(),
  assumptions: z.array(z.string()).default([]),
  criteria: z.array(z.object({ id: z.string(), description: z.string() })).min(1),
  future: z.array(z.string()).default([]),
});

export const TasksOut = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        description: z.string(),
        dependsOn: z.array(z.string()).default([]),
        acceptance: z.array(z.string()).optional(),
      }),
    )
    .min(1),
});

const severity = z.enum(["blocker", "major", "minor"]);

export const GateOut = z.object({
  passed: z.boolean(),
  summary: z.string(),
  defects: z
    .array(
      z.object({
        id: z.string(),
        severity,
        title: z.string(),
        detail: z.string(),
        suggestedFix: z.string().optional(),
      }),
    )
    .default([]),
});

export const ValidationOut = z.object({
  passed: z.boolean(),
  met: z.array(z.string()).default([]),
  unmet: z
    .array(
      z.object({
        criterionId: z.string(),
        reason: z.string(),
        workItem: z.object({ title: z.string(), description: z.string() }).optional(),
      }),
    )
    .default([]),
});

export const DevReport = z.object({
  itemId: z.string().optional(),
  done: z.boolean(),
  notes: z.string().default(""),
  filesChanged: z.array(z.string()).optional(),
  crashRepro: z
    .object({
      method: z.string(),
      path: z.string(),
      body: z.unknown().optional(),
    })
    .optional(),
});

export const EvolutionOut = z.object({
  proposals: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        value: z.string(),
        effort: z.enum(["small", "medium", "large"]),
        workItem: z.object({ title: z.string(), description: z.string() }),
      }),
    )
    .default([]),
});

export const HealOut = z.object({
  fixed: z.boolean(),
  rootCause: z.string(),
  fixSummary: z.string(),
  testAdded: z.string().optional(),
});
