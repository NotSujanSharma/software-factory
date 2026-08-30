import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { frameworkRoot } from "@factory/shared";
import type { ErrorEvent, Incident, IncidentStatus, RegisteredApp } from "@factory/shared";

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(process.env.SENTINEL_DB ?? path.join(frameworkRoot(), "sentinel.db"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'open',
      count INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      sample_event TEXT NOT NULL,
      pr_url TEXT,
      pr_number INTEGER,
      branch TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_note TEXT
    );
    CREATE TABLE IF NOT EXISTS apps (
      app_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      dir TEXT NOT NULL,
      repo_full TEXT,
      port INTEGER NOT NULL,
      start_cmd TEXT NOT NULL DEFAULT 'npm start'
    );
  `);
  migrate(db);
  return db;
}

/** Additive column migrations for stores created by an earlier version. */
function migrate(d: DatabaseSync): void {
  const cols = (d.prepare("PRAGMA table_info(incidents)").all() as Record<string, unknown>[]).map((r) =>
    String(r.name),
  );
  if (!cols.includes("rearms")) {
    d.exec("ALTER TABLE incidents ADD COLUMN rearms INTEGER NOT NULL DEFAULT 0");
  }
  if (!cols.includes("status_at")) {
    // When the status last changed - the cooldown clock for auto re-arming.
    d.exec("ALTER TABLE incidents ADD COLUMN status_at TEXT");
    d.exec("UPDATE incidents SET status_at = last_seen WHERE status_at IS NULL");
  }
}

function rowToIncident(r: Record<string, unknown>): Incident {
  return {
    id: Number(r.id),
    appId: String(r.app_id),
    fingerprint: String(r.fingerprint),
    status: String(r.status) as IncidentStatus,
    count: Number(r.count),
    firstSeen: String(r.first_seen),
    lastSeen: String(r.last_seen),
    sampleEvent: JSON.parse(String(r.sample_event)) as ErrorEvent,
    prUrl: (r.pr_url as string) ?? undefined,
    prNumber: r.pr_number == null ? undefined : Number(r.pr_number),
    branch: (r.branch as string) ?? undefined,
    attempts: Number(r.attempts),
    rearms: Number(r.rearms ?? 0),
    lastNote: (r.last_note as string) ?? undefined,
  };
}

/** Upsert an error event into its incident (dedup by fingerprint). Returns the incident. */
export function recordEvent(fingerprint: string, event: ErrorEvent): Incident {
  const d = getDb();
  const now = new Date().toISOString();
  const existing = d.prepare("SELECT * FROM incidents WHERE fingerprint = ?").get(fingerprint) as
    | Record<string, unknown>
    | undefined;
  if (!existing) {
    d.prepare(
      "INSERT INTO incidents (app_id, fingerprint, status, count, first_seen, last_seen, sample_event) VALUES (?, ?, 'open', 1, ?, ?, ?)",
    ).run(event.appId, fingerprint, now, now, JSON.stringify(event));
  } else if (existing.status === "resolved" || existing.status === "failed") {
    // Recurrence after a fix (or a failed heal): reopen with fresh context.
    d.prepare(
      "UPDATE incidents SET status = 'open', count = count + 1, last_seen = ?, sample_event = ?, last_note = ? WHERE id = ?",
    ).run(
      now,
      JSON.stringify(event),
      `reopened: recurred after status=${existing.status}${existing.pr_url ? ` (previous fix: ${existing.pr_url})` : ""}`,
      Number(existing.id),
    );
  } else {
    // open / healing / pr_open: just count the occurrence - never spawn a duplicate.
    d.prepare("UPDATE incidents SET count = count + 1, last_seen = ? WHERE id = ?").run(now, Number(existing.id));
  }
  const row = d.prepare("SELECT * FROM incidents WHERE fingerprint = ?").get(fingerprint) as Record<string, unknown>;
  return rowToIncident(row);
}

/** Atomically claim an open incident for healing. Returns true if this caller won the claim. */
export function claimIncident(id: number): boolean {
  const res = getDb().prepare("UPDATE incidents SET status = 'healing', attempts = attempts + 1 WHERE id = ? AND status = 'open'").run(id);
  return Number(res.changes) === 1;
}

export function setIncident(
  id: number,
  fields: Partial<Record<"status" | "pr_url" | "pr_number" | "branch" | "last_note" | "attempts" | "rearms", unknown>>,
): void {
  const patch: Record<string, unknown> = { ...fields };
  // Any status change restarts the cooldown clock used for auto re-arming.
  if ("status" in patch) patch.status_at = new Date().toISOString();
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  getDb().prepare(`UPDATE incidents SET ${sets} WHERE id = ?`).run(...keys.map((k) => patch[k] as never), id);
}

/** ISO time the incident's status last changed (falls back to last_seen for old rows). */
export function statusChangedAt(id: number): string | null {
  const r = getDb().prepare("SELECT status_at, last_seen FROM incidents WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  return (r.status_at as string) ?? (r.last_seen as string) ?? null;
}

export function listIncidents(status?: IncidentStatus): Incident[] {
  const d = getDb();
  const rows = status
    ? d.prepare("SELECT * FROM incidents WHERE status = ? ORDER BY last_seen DESC").all(status)
    : d.prepare("SELECT * FROM incidents ORDER BY last_seen DESC").all();
  return (rows as Record<string, unknown>[]).map(rowToIncident);
}

export function getIncident(id: number): Incident | null {
  const row = getDb().prepare("SELECT * FROM incidents WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  return row ? rowToIncident(row) : null;
}

export function upsertApp(app: RegisteredApp & { repoFull?: string | null }): void {
  getDb()
    .prepare(
      "INSERT INTO apps (app_id, name, dir, repo_full, port, start_cmd) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(app_id) DO UPDATE SET name=excluded.name, dir=excluded.dir, repo_full=excluded.repo_full, port=excluded.port, start_cmd=excluded.start_cmd",
    )
    .run(app.appId, app.name, app.dir, app.repoFull ?? app.repoUrl ?? null, app.port, app.startCmd);
}

export interface AppRow {
  appId: string;
  name: string;
  dir: string;
  repoFull: string | null;
  port: number;
  startCmd: string;
}

export function getApp(appId: string): AppRow | null {
  const r = getDb().prepare("SELECT * FROM apps WHERE app_id = ?").get(appId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    appId: String(r.app_id),
    name: String(r.name),
    dir: String(r.dir),
    repoFull: (r.repo_full as string) ?? null,
    port: Number(r.port),
    startCmd: String(r.start_cmd),
  };
}
