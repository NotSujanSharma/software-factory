/**
 * Spend ledger.
 *
 * Every agent run is recorded here the moment it finishes, so budgets can be
 * enforced against measured cost rather than a guess. It lives in its own SQLite
 * file: the sentinel's store is on the hot error-ingest path and there is no
 * reason for a budget query to contend with it.
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { frameworkRoot } from "./config.ts";

export interface SpendEntry {
  /** App this run was for; empty string when the run is not app-scoped. */
  appId: string;
  appName?: string;
  role: string;
  /** Pipeline stage, when the run belongs to one. */
  stage?: string;
  /** Free-form attribution label, e.g. "dev:T3" or "heal:12". */
  scope: string;
  model: string;
  costUsd: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
  isError: boolean;
}

export interface SpendRow extends SpendEntry {
  id: number;
  ts: string;
}

let db: DatabaseSync | null = null;

export function ledgerDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(process.env.FACTORY_DB ?? path.join(frameworkRoot(), "factory.db"));
  // WAL keeps a long-running read (the cost report) from blocking a write.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS spend (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      app_id TEXT NOT NULL DEFAULT '',
      app_name TEXT,
      role TEXT NOT NULL,
      stage TEXT,
      scope TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      cost_usd REAL NOT NULL DEFAULT 0,
      turns INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      is_error INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS spend_ts ON spend (ts);
    CREATE INDEX IF NOT EXISTS spend_app ON spend (app_id);
    CREATE INDEX IF NOT EXISTS spend_scope ON spend (scope);
  `);
  return db;
}

/** Close the handle (tests reopening a fresh file). */
export function closeLedger(): void {
  db?.close();
  db = null;
}

export function recordSpend(e: SpendEntry): void {
  ledgerDb()
    .prepare(
      `INSERT INTO spend (ts, app_id, app_name, role, stage, scope, model, cost_usd, turns, tool_calls, duration_ms, is_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      new Date().toISOString(),
      e.appId,
      e.appName ?? null,
      e.role,
      e.stage ?? null,
      e.scope,
      e.model,
      e.costUsd,
      e.turns,
      e.toolCalls,
      e.durationMs,
      e.isError ? 1 : 0,
    );
}

function sum(sql: string, params: unknown[] = []): number {
  const r = ledgerDb()
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM spend ${sql}`)
    .get(...(params as never[])) as { total: number } | undefined;
  return Number(r?.total ?? 0);
}

export function spendTotal(): number {
  return sum("");
}

/** Spend inside a rolling window ending now. */
export function spendSince(since: Date): number {
  return sum("WHERE ts >= ?", [since.toISOString()]);
}

export function spendForApp(appId: string): number {
  return sum("WHERE app_id = ?", [appId]);
}

export function spendForStage(appId: string, stage: string): number {
  return sum("WHERE app_id = ? AND stage = ?", [appId, stage]);
}

export function spendForScope(scope: string): number {
  return sum("WHERE scope = ?", [scope]);
}

export interface SpendGroup {
  key: string;
  costUsd: number;
  runs: number;
  turns: number;
  errors: number;
}

function group(column: string, sql = "", params: unknown[] = []): SpendGroup[] {
  const rows = ledgerDb()
    .prepare(
      `SELECT COALESCE(${column}, '(none)') AS key,
              COALESCE(SUM(cost_usd), 0) AS cost,
              COUNT(*) AS runs,
              COALESCE(SUM(turns), 0) AS turns,
              COALESCE(SUM(is_error), 0) AS errors
       FROM spend ${sql}
       GROUP BY key ORDER BY cost DESC`,
    )
    .all(...(params as never[])) as Record<string, unknown>[];
  return rows.map((r) => ({
    key: String(r.key),
    costUsd: Number(r.cost),
    runs: Number(r.runs),
    turns: Number(r.turns),
    errors: Number(r.errors),
  }));
}

export function spendByApp(): SpendGroup[] {
  return group("app_name");
}

export function spendByRole(appId?: string): SpendGroup[] {
  return appId ? group("role", "WHERE app_id = ?", [appId]) : group("role");
}

export function spendByStage(appId: string): SpendGroup[] {
  return group("stage", "WHERE app_id = ?", [appId]);
}

/** Most recent runs, newest first (for `factory cost --recent`). */
export function recentSpend(limit = 20): SpendRow[] {
  const rows = ledgerDb()
    .prepare("SELECT * FROM spend ORDER BY id DESC LIMIT ?")
    .all(limit as never) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    ts: String(r.ts),
    appId: String(r.app_id),
    appName: (r.app_name as string) ?? undefined,
    role: String(r.role),
    stage: (r.stage as string) ?? undefined,
    scope: String(r.scope),
    model: String(r.model),
    costUsd: Number(r.cost_usd),
    turns: Number(r.turns),
    toolCalls: Number(r.tool_calls),
    durationMs: Number(r.duration_ms),
    isError: Number(r.is_error) === 1,
  }));
}

/** Cost entries inside a window, oldest first - used to compute when a rolling budget frees up. */
export function spendTimeline(since: Date): { ts: string; costUsd: number }[] {
  const rows = ledgerDb()
    .prepare("SELECT ts, cost_usd FROM spend WHERE ts >= ? ORDER BY ts ASC")
    .all(since.toISOString() as never) as Record<string, unknown>[];
  return rows.map((r) => ({ ts: String(r.ts), costUsd: Number(r.cost_usd) }));
}
