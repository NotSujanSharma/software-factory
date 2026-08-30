export type StageName =
  | "requirements"
  | "architecture"
  | "development"
  | "qa"
  | "review"
  | "security"
  | "validation"
  | "deploy"
  | "evolution";

export interface FactoryConfig {
  model: string;
  /** Per-role model overrides; anything unset falls back to `model`. */
  models: ModelRoutes;
  workspaceDir: string;
  sentinel: {
    port: number;
    url: string;
    /** Interface to bind. Defaults to loopback - the ingest API is not public. */
    host: string;
    /** Reject ingest without a valid per-app key. */
    requireKey: boolean;
    rateLimit: IngestRateLimit;
  };
  github: { enabled: boolean; owner: string; private: boolean };
  budget: BudgetConfig;
  sandbox: SandboxConfig;
  limits: {
    qaIterations: number;
    reviewIterations: number;
    securityIterations: number;
    validationRounds: number;
    devConcurrency: number;
    healConcurrency: number;
    maxHealAttempts: number;
  };
  deploy: { basePort: number };
  approvals: { autoMergeHealPRs: boolean; autoImplementEvolution: boolean };
  autonomous: AutonomousConfig;
}

/** Settings for unattended operation. Counts of 0 mean "no limit" unless noted. */
export interface AutonomousConfig {
  /** Master switch for the supervisor loop, PR auto-merge and incident re-arming. */
  enabled: boolean;
  /** Sleep through a session/usage limit and retry instead of failing. Independent of `enabled`. */
  waitOnLimit: boolean;
  /** Extra delay after a parsed reset time, to avoid waking a moment too early. */
  limitBufferMs: number;
  /** Cap on any single limit sleep; the retry loop simply waits again if the limit persists. */
  maxLimitWaitMs: number;
  /** Backoff used when a limit message carries no parseable reset time. */
  limitFallbackMs: number;
  /** Attempts to push the pipeline past a parked stage before giving up. 0 = unlimited. */
  maxStageRetries: number;
  /** Base delay between stage retries; scales linearly with the attempt number. */
  stageRetryDelayMs: number;
  /** Evolution rounds to run after the first deploy. 0 = unlimited. */
  evolutionCycles: number;
  /** Idle time between evolution rounds. */
  evolutionIntervalMs: number;
  /** Proposals implemented per evolution round, highest value first. */
  evolutionMaxPerCycle: number;
  /** Wait before a `failed` incident is re-armed for another healing attempt. */
  incidentRetryCooldownMs: number;
  /** Times one incident may be re-armed after exhausting its attempts. 0 = unlimited. */
  maxIncidentRearms: number;
  /** How long a redeployed app has to answer HTTP before it is judged unhealthy. */
  healthCheckMs: number;
  /** Roll a merged heal back out of main when the redeployed app fails its health check. */
  rollbackOnUnhealthy: boolean;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
}

export type WorkItemStatus = "pending" | "in_progress" | "done" | "failed";

export interface WorkItem {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
  files?: string[];
  acceptance?: string[];
  status: WorkItemStatus;
}

export interface Defect {
  id: string;
  source: "qa" | "review" | "security" | "validation";
  severity: "blocker" | "major" | "minor";
  title: string;
  detail: string;
  suggestedFix?: string;
}

export type StageStatus = "pending" | "running" | "passed" | "failed" | "needs_human";

export interface StageRecord {
  name: StageName;
  status: StageStatus;
  iterations: number;
  startedAt?: string;
  finishedAt?: string;
  notes?: string;
}

export interface AppMeta {
  id: string;
  name: string;
  prompt: string;
  dir: string;
  repoUrl?: string;
  port?: number;
  releaseSha?: string;
}

export interface PipelineState {
  app: AppMeta;
  stages: StageRecord[];
  tasks: WorkItem[];
  criteria: AcceptanceCriterion[];
  defectsLog: Defect[];
  assumptions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ErrorEvent {
  appId: string;
  release?: string;
  type: string;
  message: string;
  stack?: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

export type IncidentStatus = "open" | "healing" | "pr_open" | "resolved" | "failed";

export interface Incident {
  id: number;
  appId: string;
  fingerprint: string;
  status: IncidentStatus;
  count: number;
  firstSeen: string;
  lastSeen: string;
  sampleEvent: ErrorEvent;
  prUrl?: string;
  prNumber?: number;
  branch?: string;
  attempts: number;
  /** Times the incident was re-armed after exhausting its healing attempts. */
  rearms: number;
  lastNote?: string;
}

export interface RegisteredApp {
  appId: string;
  name: string;
  dir: string;
  repoUrl?: string;
  port: number;
  startCmd: string;
}

// ---------- cost control ----------

/**
 * Spend ceilings. Dollar budgets are checked *before* each agent run, because the
 * SDK only reports cost when a run finishes: a single run can therefore overshoot
 * by at most its own cost, which `maxTurnsPerRun` / `maxToolCallsPerRun` bound.
 * A ceiling of 0 means "no limit".
 */
export interface BudgetConfig {
  enabled: boolean;
  /** Rolling-window ceiling across every app and agent. */
  dailyUsd: number;
  /** Length of that rolling window. */
  dailyWindowHours: number;
  /** Lifetime ceiling for one app: build + evolution + every heal it needs. */
  perAppUsd: number;
  /** Ceiling for one pipeline stage, summed across its retries and iterations. */
  perStageUsd: number;
  /** Ceiling for healing one incident, summed across attempts. */
  perIncidentUsd: number;
  /** Ceiling on all spend ever recorded in the ledger. The last-resort kill switch. */
  totalUsd: number;
  /** Turn ceiling handed to the SDK for a single run. */
  maxTurnsPerRun: number;
  /** Tool-call ceiling enforced by the guard hook within a single run. */
  maxToolCallsPerRun: number;
  /**
   * What an unattended run does when the *daily* budget is spent. "wait" sleeps
   * until the window rolls (hands-free); "park" fails the stage for a human.
   * Non-windowed ceilings can never resolve on their own, so they always park.
   */
  onDailyExhausted: "wait" | "park";
}

/**
 * Per-role model overrides. Falls back to `FactoryConfig.model` for any role left
 * unset. Cheap roles on a cheap model is the largest single cost lever available.
 */
export type ModelRoutes = Partial<Record<string, string>>;

// ---------- agent sandboxing ----------

/**
 * Guardrails applied to every agent tool call. This is a guardrail, not a jail:
 * it makes the known-bad moves impossible rather than proving the agent harmless.
 * Real isolation needs a container; this costs one in-process function call.
 */
export interface SandboxConfig {
  enabled: boolean;
  /** Refuse file tools that resolve outside the agent's working directory. */
  confineToWorkdir: boolean;
  /** Absolute paths an agent may touch in addition to its working directory. */
  allowPaths: string[];
  /** Regex sources; a Bash command matching any of them is denied. */
  denyCommands: string[];
  /** Deny `curl … | sh` style fetch-and-execute pipelines. */
  blockRemoteExec: boolean;
}

// ---------- error ingest security ----------

export interface IngestRateLimit {
  /** Sustained per-app event rate. */
  eventsPerMinute: number;
  /** Bucket depth, so a burst of simultaneous crashes is not dropped. */
  burst: number;
  /** Per-app ceiling on *new* incidents per hour - caps healing-agent storms. */
  newIncidentsPerHour: number;
}
