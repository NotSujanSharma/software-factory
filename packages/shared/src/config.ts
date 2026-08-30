import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FactoryConfig } from "./types.ts";

/**
 * Shell commands no agent may run, whatever its prompt says.
 *
 * The first group is the one that has actually bitten this project: an agent
 * stopping "the app" by image name takes the orchestrator, the sentinel and every
 * sibling agent down with it, because they are all `node`.
 */
export const DEFAULT_DENY_COMMANDS: string[] = [
  // Kill by name/image rather than by PID.
  String.raw`taskkill\s+[^|;&]*\/im\b`,
  String.raw`\bpkill\b`,
  String.raw`\bkillall\b`,
  String.raw`Stop-Process\b[^|;&]*-Name\b`,
  String.raw`\bkill\s+-9\s+-1\b`,
  // Destroying the filesystem.
  String.raw`\brm\s+-[a-z]*r[a-z]*f?\s+(/|~|\$HOME|\*)\s*$`,
  String.raw`\brm\s+-[a-z]*r[a-z]*f?\s+/(\s|$)`,
  String.raw`\bmkfs\b`,
  String.raw`\bformat\s+[a-z]:`,
  String.raw`\bdel\s+/[a-z]*\s+/[a-z]*\s+[a-z]:\\`,
  // Taking the machine down.
  String.raw`\bshutdown\b`,
  String.raw`\breboot\b`,
  String.raw`\bRestart-Computer\b`,
  // Publishing or rewriting shared history.
  String.raw`\bnpm\s+publish\b`,
  String.raw`\bgit\s+push\b[^|;&]*\s(-f|--force)(\s|$)`,
];

const DEFAULTS: FactoryConfig = {
  model: "claude-opus-5",
  models: {},
  workspaceDir: "workspace",
  sentinel: {
    port: 4600,
    url: "http://localhost:4600",
    host: "127.0.0.1",
    requireKey: true,
    rateLimit: { eventsPerMinute: 120, burst: 60, newIncidentsPerHour: 20 },
  },
  github: { enabled: true, owner: "", private: true },
  // Conservative on purpose: a fresh clone must not be able to run up a surprise
  // bill. Raise these deliberately once you know what a run costs you.
  budget: {
    enabled: true,
    dailyUsd: 25,
    dailyWindowHours: 24,
    perAppUsd: 50,
    perStageUsd: 15,
    perIncidentUsd: 5,
    totalUsd: 0,
    maxTurnsPerRun: 80,
    maxToolCallsPerRun: 120,
    onDailyExhausted: "wait",
  },
  health: {
    paths: ["/health", "/healthz", "/api/health", "/"],
    unhealthyStatusFrom: 500,
    timeoutMs: 45_000,
    stableChecks: 3,
  },
  sandbox: {
    enabled: true,
    confineToWorkdir: true,
    allowPaths: [],
    denyCommands: DEFAULT_DENY_COMMANDS,
    blockRemoteExec: true,
  },
  limits: {
    qaIterations: 3,
    reviewIterations: 2,
    securityIterations: 2,
    validationRounds: 2,
    devConcurrency: 2,
    healConcurrency: 1,
    maxHealAttempts: 2,
  },
  deploy: { basePort: 5100 },
  approvals: { autoMergeHealPRs: false, autoImplementEvolution: false },
  autonomous: {
    enabled: false,
    waitOnLimit: true,
    limitBufferMs: 90_000,
    maxLimitWaitMs: 6 * 60 * 60_000,
    limitFallbackMs: 10 * 60_000,
    maxStageRetries: 5,
    stageRetryDelayMs: 60_000,
    evolutionCycles: 0,
    evolutionIntervalMs: 15 * 60_000,
    evolutionMaxPerCycle: 3,
    incidentRetryCooldownMs: 30 * 60_000,
    maxIncidentRearms: 3,
    healthCheckMs: 45_000,
    rollbackOnUnhealthy: true,
  },
};

/** The framework root = directory containing factory.config.json (walk up from this file). */
export function frameworkRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "factory.config.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Env var that flips this process (and anything it spawns) into unattended mode. */
export const AUTONOMOUS_ENV = "FACTORY_AUTONOMOUS";

/**
 * Overrides layered on top of factory.config.json while `factory auto` runs.
 * This travels through the environment rather than a mutated object because every
 * package calls loadConfig() independently and spawned processes inherit env.
 */
function autonomousOverride(): Partial<FactoryConfig> {
  if (process.env[AUTONOMOUS_ENV] !== "1") return {};
  return {
    autonomous: { enabled: true, waitOnLimit: true },
    approvals: { autoMergeHealPRs: true, autoImplementEvolution: true },
  } as Partial<FactoryConfig>;
}

export function loadConfig(): FactoryConfig {
  const root = frameworkRoot();
  const file = path.join(root, "factory.config.json");
  let user: Partial<FactoryConfig> = {};
  if (fs.existsSync(file)) {
    user = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  const merged = deepMerge(deepMerge(DEFAULTS, user), autonomousOverride());

  // Deny rules are additive rather than replaced. Ordinary deep-merge semantics
  // would mean that adding one project-specific rule silently drops every built-in
  // one, which is a very quiet way to lose a safety net.
  merged.sandbox.denyCommands = [...new Set([...DEFAULT_DENY_COMMANDS, ...(user.sandbox?.denyCommands ?? [])])];
  return merged;
}

export function workspaceRoot(cfg: FactoryConfig): string {
  return path.resolve(frameworkRoot(), cfg.workspaceDir);
}

function deepMerge<T>(base: T, over: Partial<T>): T {
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object") {
      out[k] = deepMerge(out[k], v as any);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}
