import express, { type NextFunction, type Request, type Response } from "express";
import {
  budgetReport,
  formatUsd,
  loadConfig,
  makeLogger,
  safeEqual,
  spendByApp,
  adminToken,
} from "@factory/shared";
import type { ErrorEvent } from "@factory/shared";
import {
  countIncidentsSince,
  getIncident,
  ingestKey,
  listIncidents,
  recordEvent,
  setIncident,
  upsertApp,
} from "./db.ts";
import { fingerprint } from "./fingerprint.ts";
import { RateLimiter } from "./ratelimit.ts";
import { startScheduler } from "./scheduler.ts";

const log = makeLogger("sentinel");

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function startSentinel(): void {
  const cfg = loadConfig();
  const app = express();
  const admin = adminToken();
  const exposed = !LOOPBACK.has(cfg.sentinel.host);

  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  const events = new RateLimiter({
    perMinute: cfg.sentinel.rateLimit.eventsPerMinute,
    burst: cfg.sentinel.rateLimit.burst,
  });

  /**
   * Registration and incident control are privileged: an attacker who can register
   * an app chooses the directory a healing agent will clone and run `npm test` in,
   * which is arbitrary code execution on this machine.
   */
  const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
    const given = req.get("x-factory-admin") ?? "";
    if (given && safeEqual(given, admin)) return next();
    log.warn(`rejected unauthenticated ${req.method} ${req.path} from ${req.ip}`);
    res.status(401).json({ error: "admin token required" });
  };

  /** Read paths are open on loopback, authenticated when the port is exposed. */
  const requireReadAuth = (req: Request, res: Response, next: NextFunction): void =>
    exposed ? requireAdmin(req, res, next) : next();

  app.post("/ingest", (req, res) => {
    const e = req.body as Partial<ErrorEvent>;
    if (!e || typeof e.appId !== "string" || typeof e.message !== "string") {
      res.status(400).json({ error: "appId and message are required" });
      return;
    }

    // 1. Authenticate the reporting app. Its key is handed to it at deploy time.
    if (cfg.sentinel.requireKey) {
      const expected = ingestKey(e.appId);
      const given = req.get("x-factory-key") ?? "";
      if (!expected || !given || !safeEqual(given, expected)) {
        log.warn(`rejected ingest for ${e.appId} from ${req.ip}: bad or missing key`);
        res.status(401).json({ error: "invalid ingest key" });
        return;
      }
    }

    // 2. Throttle. A crash loop must not be able to drive the healing scheduler.
    if (!events.allow(e.appId)) {
      const after = events.retryAfter(e.appId);
      res.set("Retry-After", String(after)).status(429).json({ error: "rate limited", retryAfter: after });
      return;
    }

    const event: ErrorEvent = {
      appId: e.appId,
      release: typeof e.release === "string" ? e.release : undefined,
      type: typeof e.type === "string" ? e.type : "Error",
      message: e.message,
      stack: typeof e.stack === "string" ? e.stack : undefined,
      context: typeof e.context === "object" && e.context ? (e.context as Record<string, unknown>) : {},
      timestamp: typeof e.timestamp === "string" ? e.timestamp : new Date().toISOString(),
    };
    const fp = fingerprint(event);

    // 3. Cap distinct new incidents per app. Each new fingerprint can wake a healing
    //    agent, so an app inventing unique errors is an agent - and spend - storm.
    const cap = cfg.sentinel.rateLimit.newIncidentsPerHour;
    const known = listIncidents().some((i) => i.fingerprint === fp);
    if (cap > 0 && !known && countIncidentsSince(event.appId, new Date(Date.now() - 3_600_000)) >= cap) {
      log.warn(`ingest for ${event.appId}: new-incident cap (${cap}/h) reached - dropping ${fp}`);
      res.status(429).json({ error: "new incident cap reached", fingerprint: fp });
      return;
    }

    const incident = recordEvent(fp, event);
    log.info(
      `ingest ${event.appId} ${event.type}: incident #${incident.id} (${incident.status}, count ${incident.count})`,
    );
    res.json({ incidentId: incident.id, status: incident.status, count: incident.count });
  });

  app.post("/apps", requireAdmin, (req, res) => {
    const b = req.body ?? {};
    if (!b.appId || !b.dir || !b.port) {
      res.status(400).json({ error: "appId, dir, port required" });
      return;
    }
    const key = upsertApp(b);
    log.ok(`app registered: ${b.appId} (port ${b.port})`);
    res.json({ ok: true, ingestKey: key });
  });

  app.get("/incidents", requireReadAuth, (_req, res) => {
    res.json(listIncidents());
  });

  app.get("/incidents/:id", requireReadAuth, (req, res) => {
    const inc = getIncident(Number(req.params.id));
    if (!inc) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json(inc);
  });

  /** Manual re-arm of a parked incident. */
  app.post("/incidents/:id/retry", requireAdmin, (req, res) => {
    const inc = getIncident(Number(req.params.id));
    if (!inc) {
      res.status(404).json({ error: "not found" });
      return;
    }
    setIncident(inc.id, { status: "open", last_note: "manually re-armed" });
    res.json({ ok: true });
  });

  app.get("/", requireReadAuth, (_req, res) => {
    const rows = listIncidents()
      .map(
        (i) =>
          `<tr><td>#${i.id}</td><td>${esc(i.appId)}</td><td class="s-${i.status}">${i.status}</td><td>${i.count}</td>` +
          `<td>${esc(i.sampleEvent.type)}: ${esc(i.sampleEvent.message.slice(0, 90))}</td>` +
          `<td>${i.prUrl ? `<a href="${esc(i.prUrl)}">PR</a>` : esc(i.branch ?? "")}</td><td>${esc(i.lastSeen.slice(0, 19))}</td></tr>`,
      )
      .join("");
    const spend = spendByApp()
      .map((g) => `<tr><td>${esc(g.key)}</td><td>${formatUsd(g.costUsd)}</td><td>${g.runs}</td><td>${g.errors}</td></tr>`)
      .join("");
    res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Sentinel</title>
<style>body{font-family:system-ui;margin:2rem;background:#fafafa;color:#111}
table{border-collapse:collapse;width:100%;margin-bottom:2rem}
td,th{border:1px solid #ddd;padding:6px 10px;font-size:14px;text-align:left}th{background:#eee}
pre{background:#eee;padding:10px;border-radius:6px;font-size:13px}
.s-open{color:#b45309}.s-healing{color:#2563eb}.s-pr_open{color:#7c3aed}.s-resolved{color:#16a34a}.s-failed{color:#dc2626}</style>
<h1>Sentinel incidents</h1>
<table><tr><th>id</th><th>app</th><th>status</th><th>count</th><th>error</th><th>fix</th><th>last seen</th></tr>${rows}</table>
<h2>Spend</h2>
<pre>${esc(budgetReport(cfg).join("\n"))}</pre>
<table><tr><th>app</th><th>cost</th><th>runs</th><th>errored</th></tr>${spend}</table>
<p>Auto-refreshes every 10s.</p><script>setTimeout(()=>location.reload(),10000)</script>`);
  });

  app.listen(cfg.sentinel.port, cfg.sentinel.host, () => {
    log.ok(`sentinel listening on http://${cfg.sentinel.host}:${cfg.sentinel.port}`);
    if (exposed) log.warn(`bound to ${cfg.sentinel.host} - every endpoint now requires the admin token`);
    if (!cfg.sentinel.requireKey) log.warn("sentinel.requireKey is off - /ingest accepts unauthenticated events");
  });
  startScheduler();
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
