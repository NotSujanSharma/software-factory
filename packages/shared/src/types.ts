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
  workspaceDir: string;
  sentinel: { port: number; url: string };
  github: { enabled: boolean; owner: string; private: boolean };
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
