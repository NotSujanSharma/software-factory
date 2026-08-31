/**
 * Everything the dashboard shows, gathered from where it already lives.
 *
 * There is no dashboard database. Pipeline state is `.factory/state.json` in each
 * app repo, incidents are in the sentinel's store, spend is in the ledger, and
 * agent transcripts are log files. This module reads those and shapes them for a
 * browser; it never becomes a second source of truth.
 */
import fs from "node:fs";
import path from "node:path";
import {
  budgetReport,
  loadConfig,
  probeHealth,
  recentSpend,
  spendByApp,
  spendByRole,
  spendByStage,
  spendForApp,
  spendSince,
  spendTotal,
  workspaceRoot,
  type FactoryConfig,
  type PipelineState,
} from "@factory/shared";
import { resolveStack, type AppStack } from "@factory/stacks";
import { listIncidents } from "@factory/sentinel";
import { activeRuns, listRuns, tailFile, type BuildRun } from "./runs.ts";

export interface AppSummary {
  name: string;
  id: string;
  prompt: string;
  dir: string;
  repoUrl?: string;
  port?: number;
  stack: { id: string; label: string; language: string; framework?: string };
  /** The stage the pipeline is at, and how it is doing. */
  current: { stage: string; status: string; iterations: number; notes?: string } | null;
  stages: PipelineState["stages"];
  tasks: { total: number; done: number; failed: number; pending: number };
  progress: number;
  /** Is a pipeline process working on this app right now? */
  run?: { id: string; mode: string; startedAt: string; pid: number };
  /** Is the built app itself listening? */
  serving: boolean;
  incidents: { open: number; healing: number; prOpen: number; failed: number; resolved: number };
  costUsd: number;
  createdAt: string;
  updatedAt: string;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export function appDirs(cfg: FactoryConfig): string[] {
  const ws = workspaceRoot(cfg);
  if (!fs.existsSync(ws)) return [];
  return fs
    .readdirSync(ws)
    .map((name) => path.join(ws, name))
    .filter((dir) => fs.existsSync(path.join(dir, ".factory", "state.json")));
}

/** The stage a pipeline is actually at: the first that is not yet passed. */
function currentStage(state: PipelineState): AppSummary["current"] {
  const running = state.stages.find((s) => s.status === "running");
  const blocked = state.stages.find((s) => s.status === "failed" || s.status === "needs_human");
  const next = state.stages.find((s) => s.status !== "passed");
  const rec = running ?? blocked ?? next;
  if (!rec) return null;
  return { stage: rec.name, status: rec.status, iterations: rec.iterations, notes: rec.notes };
}

function stackOf(dir: string): AppSummary["stack"] {
  const s: AppStack = resolveStack(dir);
  return { id: s.id, label: s.label, language: s.language, framework: s.framework };
}

export function summarize(dir: string, runs: BuildRun[]): AppSummary | null {
  const state = readJson<PipelineState>(path.join(dir, ".factory", "state.json"));
  if (!state) return null;

  const tasks = state.tasks ?? [];
  const done = tasks.filter((t) => t.status === "done").length;
  const failed = tasks.filter((t) => t.status === "failed").length;
  const passedStages = state.stages.filter((s) => s.status === "passed").length;

  const incidents = listIncidents().filter((i) => i.appId === state.app.id);
  const count = (status: string) => incidents.filter((i) => i.status === status).length;

  const run = runs.find((r) => r.app === state.app.name && !r.finishedAt);
  const runFile = readJson<{ pid: number; port: number }>(path.join(dir, ".factory", "run.json"));

  return {
    name: state.app.name,
    id: state.app.id,
    prompt: state.app.prompt,
    dir,
    repoUrl: state.app.repoUrl,
    port: state.app.port,
    stack: stackOf(dir),
    current: currentStage(state),
    stages: state.stages,
    tasks: { total: tasks.length, done, failed, pending: tasks.length - done - failed },
    // Stage completion is the honest progress signal; task counts move within one stage.
    progress: Math.round((passedStages / Math.max(1, state.stages.length)) * 100),
    run: run ? { id: run.id, mode: run.mode, startedAt: run.startedAt, pid: run.pid } : undefined,
    serving: Boolean(runFile?.pid),
    incidents: {
      open: count("open"),
      healing: count("healing"),
      prOpen: count("pr_open"),
      failed: count("failed"),
      resolved: count("resolved"),
    },
    costUsd: spendForApp(state.app.id),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}

export function listApps(): AppSummary[] {
  const cfg = loadConfig();
  const runs = listRuns();
  return appDirs(cfg)
    .map((dir) => summarize(dir, runs))
    .filter((a): a is AppSummary => a !== null)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function findApp(name: string): AppSummary | null {
  const cfg = loadConfig();
  const dir = path.join(workspaceRoot(cfg), name);
  if (!fs.existsSync(path.join(dir, ".factory", "state.json"))) return null;
  return summarize(dir, listRuns());
}

/** Full detail for one app, including the parts too heavy for a list view. */
export function appDetail(name: string) {
  const summary = findApp(name);
  if (!summary) return null;
  const state = readJson<PipelineState>(path.join(summary.dir, ".factory", "state.json"))!;
  const stack = resolveStack(summary.dir);

  return {
    ...summary,
    stackDetail: stack,
    taskList: state.tasks ?? [],
    criteria: state.criteria ?? [],
    assumptions: state.assumptions ?? [],
    // Newest defects first: an old QA finding is rarely what you came to look at.
    defects: [...(state.defectsLog ?? [])].reverse().slice(0, 100),
    incidents: listIncidents().filter((i) => i.appId === summary.id),
    spendByStage: spendByStage(summary.id),
    spendByRole: spendByRole(summary.id),
    logs: listLogs(summary.dir),
    docs: readDocs(summary.dir),
    outs: listOuts(summary.dir),
  };
}

export interface LogFile {
  name: string;
  size: number;
  modified: string;
}

/** Agent transcripts for an app, newest first. */
export function listLogs(dir: string): LogFile[] {
  const logsDir = path.join(dir, ".factory", "logs");
  if (!fs.existsSync(logsDir)) return [];
  return fs
    .readdirSync(logsDir)
    .map((name) => {
      const st = fs.statSync(path.join(logsDir, name));
      return { name, size: st.size, modified: st.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, 200);
}

/** Read one agent transcript. The name is validated by the caller. */
export function readLog(dir: string, name: string, maxBytes = 200_000): string {
  const file = path.join(dir, ".factory", "logs", name);
  return tailFile(file, maxBytes);
}

/** The app's own log (stdout of the running process). */
export function readAppLog(dir: string, maxBytes = 100_000): string {
  return tailFile(path.join(dir, ".factory", "app.log"), maxBytes);
}

const DOC_FILES = ["requirements.md", "architecture.md", "IMPROVEMENTS.md", "README.md"];

function readDocs(dir: string): { name: string; size: number }[] {
  return DOC_FILES.filter((f) => fs.existsSync(path.join(dir, f))).map((f) => ({
    name: f,
    size: fs.statSync(path.join(dir, f)).size,
  }));
}

/**
 * The JSON contracts agents wrote (`.factory/out/<name>.json`).
 *
 * This is the structured thing a stage actually produced - the requirements it
 * gathered, the task DAG it planned, the defects a gate found - so the stage
 * drawer can show the output rather than only the transcript that led to it.
 */
export function listOuts(dir: string): LogFile[] {
  const outDir = path.join(dir, ".factory", "out");
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const st = fs.statSync(path.join(outDir, name));
      return { name: name.replace(/\.json$/, ""), size: st.size, modified: st.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Read one agent contract. The name is validated by the caller. */
export function readOut(dir: string, name: string, maxBytes = 200_000): string | null {
  try {
    return fs.readFileSync(path.join(dir, ".factory", "out", `${name}.json`), "utf8").slice(0, maxBytes);
  } catch {
    return null;
  }
}

export function readDoc(dir: string, name: string): string | null {
  if (!DOC_FILES.includes(name)) return null;
  try {
    return fs.readFileSync(path.join(dir, name), "utf8").slice(0, 400_000);
  } catch {
    return null;
  }
}

/** Is a deployed app actually answering, not just listening? */
export async function healthOf(app: AppSummary): Promise<{ healthy: boolean; detail: string } | null> {
  if (!app.port || !app.serving) return null;
  const cfg = loadConfig();
  const verdict = await probeHealth(`http://localhost:${app.port}`, { ...cfg.health, timeoutMs: 3000 });
  return { healthy: verdict.healthy, detail: verdict.detail };
}

export function spendOverview() {
  const cfg = loadConfig();
  const windowStart = new Date(Date.now() - cfg.budget.dailyWindowHours * 3_600_000);
  return {
    enabled: cfg.budget.enabled,
    windowHours: cfg.budget.dailyWindowHours,
    windowSpend: spendSince(windowStart),
    dailyUsd: cfg.budget.dailyUsd,
    total: spendTotal(),
    totalUsd: cfg.budget.totalUsd,
    perAppUsd: cfg.budget.perAppUsd,
    byApp: spendByApp(),
    byRole: spendByRole(),
    report: budgetReport(cfg),
    recent: recentSpend(25),
  };
}

/** The single payload the dashboard polls: everything a live view needs. */
export function overview() {
  const cfg = loadConfig();
  const apps = listApps();
  const incidents = listIncidents();
  const runs = listRuns().slice(0, 20);

  return {
    apps,
    runs,
    activeRuns: activeRuns().length,
    incidents: {
      open: incidents.filter((i) => i.status === "open").length,
      healing: incidents.filter((i) => i.status === "healing").length,
      prOpen: incidents.filter((i) => i.status === "pr_open").length,
      failed: incidents.filter((i) => i.status === "failed").length,
      resolved: incidents.filter((i) => i.status === "resolved").length,
      recent: incidents.slice(0, 12),
    },
    spend: spendOverview(),
    config: {
      provider: cfg.provider,
      model: cfg.model,
      sentinelUrl: cfg.sentinel.url,
      devConcurrency: cfg.limits.devConcurrency,
      autoMergeHealPRs: cfg.approvals.autoMergeHealPRs,
      sandbox: cfg.sandbox.enabled,
      budgets: cfg.budget.enabled,
    },
    now: new Date().toISOString(),
  };
}
