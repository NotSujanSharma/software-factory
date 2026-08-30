import express from "express";
import { loadConfig, makeLogger } from "@factory/shared";
import type { ErrorEvent } from "@factory/shared";
import { getIncident, listIncidents, recordEvent, setIncident, upsertApp } from "./db.ts";
import { fingerprint } from "./fingerprint.ts";
import { startScheduler } from "./scheduler.ts";

const log = makeLogger("sentinel");

export function startSentinel(): void {
  const cfg = loadConfig();
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.post("/ingest", (req, res) => {
    const e = req.body as Partial<ErrorEvent>;
    if (!e || typeof e.appId !== "string" || typeof e.message !== "string") {
      res.status(400).json({ error: "appId and message are required" });
      return;
    }
    const event: ErrorEvent = {
      appId: e.appId,
      release: typeof e.release === "string" ? e.release : undefined,
      type: typeof e.type === "string" ? e.type : "Error",
      message: e.message,
      stack: typeof e.stack === "string" ? e.stack : undefined,
      context: typeof e.context === "object" && e.context ? e.context as Record<string, unknown> : {},
      timestamp: typeof e.timestamp === "string" ? e.timestamp : new Date().toISOString(),
    };
    const fp = fingerprint(event);
    const incident = recordEvent(fp, event);
    log.info(`ingest ${event.appId} ${event.type}: incident #${incident.id} (${incident.status}, count ${incident.count})`);
    res.json({ incidentId: incident.id, status: incident.status, count: incident.count });
  });

  app.post("/apps", (req, res) => {
    const b = req.body ?? {};
    if (!b.appId || !b.dir || !b.port) {
      res.status(400).json({ error: "appId, dir, port required" });
      return;
    }
    upsertApp(b);
    log.ok(`app registered: ${b.appId} (port ${b.port})`);
    res.json({ ok: true });
  });

  app.get("/incidents", (_req, res) => {
    res.json(listIncidents());
  });

  app.get("/incidents/:id", (req, res) => {
    const inc = getIncident(Number(req.params.id));
    if (!inc) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(inc);
  });

  /** Manual re-arm of a parked incident. */
  app.post("/incidents/:id/retry", (req, res) => {
    const inc = getIncident(Number(req.params.id));
    if (!inc) {
      res.status(404).json({ error: "not found" });
      return;
    }
    setIncident(inc.id, { status: "open", last_note: "manually re-armed" });
    res.json({ ok: true });
  });

  app.get("/", (_req, res) => {
    const rows = listIncidents()
      .map(
        (i) =>
          `<tr><td>#${i.id}</td><td>${i.appId}</td><td class="s-${i.status}">${i.status}</td><td>${i.count}</td>` +
          `<td>${esc(i.sampleEvent.type)}: ${esc(i.sampleEvent.message.slice(0, 90))}</td>` +
          `<td>${i.prUrl ? `<a href="${i.prUrl}">PR</a>` : (i.branch ?? "")}</td><td>${i.lastSeen.slice(0, 19)}</td></tr>`,
      )
      .join("");
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Sentinel</title>
<style>body{font-family:system-ui;margin:2rem;background:#fafafa}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #ddd;padding:6px 10px;font-size:14px;text-align:left}th{background:#eee}
.s-open{color:#b45309}.s-healing{color:#2563eb}.s-pr_open{color:#7c3aed}.s-resolved{color:#16a34a}.s-failed{color:#dc2626}</style>
<h1>Sentinel incidents</h1>
<table><tr><th>id</th><th>app</th><th>status</th><th>count</th><th>error</th><th>fix</th><th>last seen</th></tr>${rows}</table>
<p>Auto-refreshes every 10s.</p><script>setTimeout(()=>location.reload(),10000)</script>`);
  });

  app.listen(cfg.sentinel.port, () => {
    log.ok(`sentinel listening on http://localhost:${cfg.sentinel.port}`);
  });
  startScheduler();
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
