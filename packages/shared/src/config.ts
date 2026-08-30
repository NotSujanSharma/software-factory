import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FactoryConfig } from "./types.ts";

const DEFAULTS: FactoryConfig = {
  model: "claude-opus-5",
  workspaceDir: "workspace",
  sentinel: { port: 4600, url: "http://localhost:4600" },
  github: { enabled: true, owner: "", private: true },
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
  return deepMerge(deepMerge(DEFAULTS, user), autonomousOverride());
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
