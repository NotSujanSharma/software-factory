/**
 * Build runs started from the dashboard.
 *
 * Starting a build from a web page means spawning the same CLI a human would run,
 * detached, with its output going to a file the dashboard can tail. The registry is
 * persisted so a dashboard restart does not lose track of pipelines that are still
 * running - the processes outlive it, and an orphaned build nobody can see or stop
 * is exactly the kind of thing this dashboard exists to prevent.
 */
import fs from "node:fs";
import path from "node:path";
import { AGENT_MODEL_ENV, AGENT_PROVIDER_ENV, frameworkRoot, killTree, loadConfig, makeLogger, spawnDetached } from "@factory/shared";

const log = makeLogger("runs");

export type RunMode = "auto" | "build" | "resume" | "evolve";

export interface BuildRun {
  id: string;
  app: string;
  mode: RunMode;
  prompt?: string;
  pid: number;
  startedAt: string;
  logFile: string;
  /** Set when the process is no longer alive. */
  finishedAt?: string;
  exitReason?: string;
  /** Provider/model captured when this run was created. */
  provider?: "claude" | "codex";
  model?: string;
}

function runsDir(): string {
  const dir = path.join(frameworkRoot(), ".factory-runs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function registryPath(): string {
  return path.join(runsDir(), "runs.json");
}

function readRegistry(): BuildRun[] {
  try {
    return JSON.parse(fs.readFileSync(registryPath(), "utf8")) as BuildRun[];
  } catch {
    return [];
  }
}

function writeRegistry(runs: BuildRun[]): void {
  // Newest first, and bounded: this is a live view, not an archive.
  const trimmed = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 50);
  fs.writeFileSync(registryPath(), JSON.stringify(trimmed, null, 2));
}

/** Is this process still alive? Signal 0 checks for existence without signalling. */
export function isAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every known run, with liveness refreshed and finished ones marked. */
export function listRuns(): BuildRun[] {
  const runs = readRegistry();
  let changed = false;
  for (const run of runs) {
    if (!run.finishedAt && !isAlive(run.pid)) {
      run.finishedAt = new Date().toISOString();
      run.exitReason = "process exited";
      changed = true;
    }
  }
  if (changed) writeRegistry(runs);
  return runs;
}

export function activeRuns(): BuildRun[] {
  return listRuns().filter((r) => !r.finishedAt);
}

export function runFor(app: string): BuildRun | undefined {
  return activeRuns().find((r) => r.app === app);
}

/** A run is already going for this app; the caller should report a conflict. */
export class RunConflictError extends Error {
  readonly conflict = true;
  constructor(message: string) {
    super(message);
    this.name = "RunConflictError";
  }
}

export interface StartOptions {
  app: string;
  mode: RunMode;
  prompt?: string;
  /** Stop after the app is deployed instead of looping on evolution. */
  buildOnly?: boolean;
}

/**
 * Spawn a pipeline. Returns the run record, or throws when one is already going
 * for this app - two pipelines on one working tree would fight over it.
 */
export function startRun(opts: StartOptions): BuildRun {
  const existing = runFor(opts.app);
  if (existing) {
    throw new RunConflictError(
      `${opts.app} already has a ${existing.mode} run in progress (pid ${existing.pid}). Stop it first.`,
    );
  }

  const args: string[] = ["run", "factory", "--"];
  switch (opts.mode) {
    case "auto":
      args.push("auto");
      if (opts.prompt) args.push("--name", opts.app, opts.prompt);
      else args.push("--app", opts.app);
      if (opts.buildOnly) args.push("--build-only");
      break;
    case "build":
      if (!opts.prompt) throw new Error("a build needs a prompt");
      args.push("build", "--auto", "--name", opts.app, opts.prompt);
      break;
    case "resume":
      args.push("resume", opts.app);
      break;
    case "evolve":
      args.push("evolve", opts.app, "--all");
      break;
  }

  const id = `${opts.app}-${Date.now().toString(36)}`;
  const logFile = path.join(runsDir(), `${id}.log`);
  fs.writeFileSync(logFile, `# factory ${opts.mode} ${opts.app}\n# started ${new Date().toISOString()}\n\n`);

  const cfg = loadConfig();

  // Snapshot these values into the child. Agent calls load config independently,
  // so without this a dashboard edit could silently switch an active pipeline
  // halfway through its stages.
  const agentEnv = {
    [AGENT_PROVIDER_ENV]: cfg.provider,
    [AGENT_MODEL_ENV]: cfg.model,
  };

  // npm is resolved to `node npm-cli.js` by planSpawn, so there is no shell and the
  // prompt - which is arbitrary user text - is passed as one argv element.
  const pid = spawnDetached("npm", args, { cwd: frameworkRoot(), logFile, env: agentEnv });
  if (!pid) throw new Error("could not start the pipeline process");

  const run: BuildRun = {
    id,
    app: opts.app,
    mode: opts.mode,
    prompt: opts.prompt,
    pid,
    startedAt: new Date().toISOString(),
    logFile,
    provider: cfg.provider,
    model: cfg.model,
  };
  writeRegistry([run, ...readRegistry()]);
  log.ok(`started ${opts.mode} for ${opts.app} (pid ${pid})`);
  return run;
}

/** Stop a running pipeline and everything it spawned. */
export function stopRun(id: string): boolean {
  const runs = readRegistry();
  const run = runs.find((r) => r.id === id);
  if (!run || run.finishedAt) return false;

  killTree(run.pid);
  run.finishedAt = new Date().toISOString();
  run.exitReason = "stopped from the dashboard";
  writeRegistry(runs);
  log.warn(`stopped run ${id} (pid ${run.pid})`);
  return true;
}

/** Read the tail of a run's log. */
export function runLog(id: string, maxBytes = 200_000): string {
  const run = readRegistry().find((r) => r.id === id);
  if (!run) return "";
  return tailFile(run.logFile, maxBytes);
}

/** Last `maxBytes` of a file, trimmed to a whole first line. */
export function tailFile(file: string, maxBytes = 200_000): string {
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(size, maxBytes));
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}
