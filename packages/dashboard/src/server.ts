/**
 * The control API behind the dashboard.
 *
 * Loopback by default. On loopback every endpoint is open, because anything that
 * can reach it can already run the CLI - the dashboard grants no privilege a local
 * shell does not already have. Bind it to a real interface and every request needs
 * the admin token, because "start a build" spends money and runs agents.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  adminToken,
  frameworkRoot,
  loadConfig,
  makeLogger,
  safeEqual,
  workspaceRoot,
} from "@factory/shared";
import { getIncident, setIncident } from "@factory/sentinel";
import { rearmState, stopApp } from "@factory/orchestrator";
import { appDetail, healthOf, listApps, overview, readAppLog, readDoc, readLog, readOut, spendOverview } from "./data.ts";
import { listRuns, RunConflictError, runLog, startRun, stopRun, type RunMode } from "./runs.ts";

const log = makeLogger("dashboard");
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** A name that is safe to use as a directory. Rejects traversal outright. */
function safeName(name: unknown): string | null {
  if (typeof name !== "string" || !name) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return null;
  if (name === "." || name === "..") return null;
  return name;
}

/** A log filename, constrained to the app's own log directory. */
function safeLogName(name: unknown): string | null {
  if (typeof name !== "string" || !name) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  return /^[A-Za-z0-9._-]{1,128}$/.test(name) ? name : null;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")
      .filter(Boolean)
      .slice(0, 4)
      .join("-") || "app"
  );
}

export interface DashboardOptions {
  port?: number;
  host?: string;
}

export function startDashboard(opts: DashboardOptions = {}): void {
  const cfg = loadConfig();
  const port = opts.port ?? cfg.dashboard.port;
  const host = opts.host ?? cfg.dashboard.host;
  const exposed = !LOOPBACK.has(host);
  const token = adminToken();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "64kb" }));

  const auth = (req: Request, res: Response, next: NextFunction): void => {
    if (!exposed) return next();
    const given = req.get("x-factory-admin") ?? String(req.query.token ?? "");
    if (given && safeEqual(given, token)) return next();
    res.status(401).json({ error: "admin token required" });
  };

  const appDir = (name: string) => path.join(workspaceRoot(cfg), name);

  /** Resolve `:app` once, rejecting anything that is not a real app. */
  const withApp = (req: Request, res: Response): string | null => {
    const name = safeName(req.params.app);
    if (!name || !fs.existsSync(path.join(appDir(name), ".factory", "state.json"))) {
      res.status(404).json({ error: "no such app" });
      return null;
    }
    return name;
  };

  const wrap = (fn: (req: Request, res: Response) => unknown) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (err) {
      // A run that is already going is the caller's answer, not a server fault.
      const status = err instanceof RunConflictError ? 409 : 500;
      if (status === 500) log.error(`${req.method} ${req.path}: ${err}`);
      res.status(status).json({ error: String(err instanceof Error ? err.message : err).slice(0, 500) });
    }
  };

  // ---------- read ----------

  app.get("/api/overview", auth, wrap((_req, res) => res.json(overview())));
  app.get("/api/apps", auth, wrap((_req, res) => res.json(listApps())));

  app.get(
    "/api/apps/:app",
    auth,
    wrap((req, res) => {
      const name = withApp(req, res);
      if (!name) return;
      res.json(appDetail(name));
    }),
  );

  app.get(
    "/api/apps/:app/health",
    auth,
    wrap(async (req, res) => {
      const name = withApp(req, res);
      if (!name) return;
      const summary = listApps().find((a) => a.name === name);
      res.json((summary && (await healthOf(summary))) ?? { healthy: false, detail: "not running" });
    }),
  );

  app.get(
    "/api/apps/:app/logs/:name",
    auth,
    wrap((req, res) => {
      const name = withApp(req, res);
      if (!name) return;
      const file = safeLogName(req.params.name);
      if (!file) {
        res.status(400).json({ error: "bad log name" });
        return;
      }
      res.type("text/plain").send(readLog(appDir(name), file));
    }),
  );

  app.get(
    "/api/apps/:app/applog",
    auth,
    wrap((req, res) => {
      const name = withApp(req, res);
      if (!name) return;
      res.type("text/plain").send(readAppLog(appDir(name)));
    }),
  );

  app.get(
    "/api/apps/:app/doc/:name",
    auth,
    wrap((req, res) => {
      const name = withApp(req, res);
      if (!name) return;
      const doc = readDoc(appDir(name), String(req.params.name));
      if (doc === null) {
        res.status(404).json({ error: "no such document" });
        return;
      }
      res.type("text/plain").send(doc);
    }),
  );

  /** One agent's JSON contract, for the stage drawer. */
  app.get(
    "/api/apps/:app/out/:name",
    auth,
    wrap((req, res) => {
      const name = withApp(req, res);
      if (!name) return;
      const out = safeLogName(req.params.name);
      if (!out) {
        res.status(400).json({ error: "bad output name" });
        return;
      }
      const body = readOut(appDir(name), out);
      if (body === null) {
        res.status(404).json({ error: "no such output" });
        return;
      }
      res.type("text/plain").send(body);
    }),
  );

  /** One incident in full. The overview only carries the most recent handful. */
  app.get(
    "/api/incidents/:id",
    auth,
    wrap((req, res) => {
      const incident = getIncident(Number(req.params.id));
      if (!incident) {
        res.status(404).json({ error: "no such incident" });
        return;
      }
      res.json(incident);
    }),
  );

  app.get("/api/runs", auth, wrap((_req, res) => res.json(listRuns())));

  app.get(
    "/api/runs/:id/log",
    auth,
    wrap((req, res) => {
      const id = safeLogName(req.params.id);
      if (!id) {
        res.status(400).json({ error: "bad run id" });
        return;
      }
      res.type("text/plain").send(runLog(id));
    }),
  );

  app.get("/api/cost", auth, wrap((_req, res) => res.json(spendOverview())));

  app.get("/api/config", auth, wrap((_req, res) => {
    const cfg = loadConfig();
    res.json({ provider: cfg.provider, model: cfg.model });
  }));

  /** Update only the agent selection. Existing child runs use their startup snapshot. */
  app.post("/api/config", auth, wrap((req, res) => {
    const provider = req.body?.provider;
    const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
    if (provider !== "claude" && provider !== "codex") {
      res.status(400).json({ error: "provider must be claude or codex" });
      return;
    }
    if (!model || model.length > 128 || /[\u0000-\u001f\u007f]/.test(model)) {
      res.status(400).json({ error: "model must be 1-128 characters without control characters" });
      return;
    }
    const file = path.join(frameworkRoot(), "factory.config.json");
    const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    current.provider = provider;
    current.model = model;
    fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
    res.json({ provider, model });
  }));

  // ---------- act ----------

  /**
   * Start a pipeline. This is the endpoint that spends money, which is why the
   * whole API is loopback-only unless a token is configured.
   */
  app.post(
    "/api/builds",
    auth,
    wrap((req, res) => {
      const body = req.body ?? {};
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const mode: RunMode = ["auto", "build", "resume", "evolve"].includes(body.mode) ? body.mode : "auto";

      // Length first: a 4000-character prompt would otherwise be rejected as a bad
      // derived name, which tells the user nothing useful about what went wrong.
      if (prompt.length > 4000) {
        res.status(400).json({ error: "prompt is too long (4000 characters max)" });
        return;
      }
      if (body.name !== undefined && body.name !== "" && !safeName(body.name)) {
        res.status(400).json({ error: "app name must be letters, digits, dot, dash or underscore" });
        return;
      }

      const name = safeName(body.name) ?? (prompt ? safeName(slug(prompt)) : null);
      if (!name) {
        res.status(400).json({ error: "a prompt or an app name is required" });
        return;
      }
      if ((mode === "auto" || mode === "build") && !prompt && !fs.existsSync(path.join(appDir(name), ".factory"))) {
        res.status(400).json({ error: "a new app needs a prompt" });
        return;
      }

      const run = startRun({ app: name, mode, prompt: prompt || undefined, buildOnly: Boolean(body.buildOnly) });
      res.json(run);
    }),
  );

  app.post(
    "/api/runs/:id/stop",
    auth,
    wrap((req, res) => {
      const id = safeLogName(req.params.id);
      if (!id) {
        res.status(400).json({ error: "bad run id" });
        return;
      }
      res.json({ stopped: stopRun(id) });
    }),
  );

  /** Stop the deployed app process (not the pipeline). */
  app.post(
    "/api/apps/:app/stop",
    auth,
    wrap((req, res) => {
      const name = withApp(req, res);
      if (!name) return;
      stopApp(appDir(name));
      res.json({ ok: true });
    }),
  );

  /** Put a parked pipeline back on the board without starting a run. */
  app.post(
    "/api/apps/:app/rearm",
    auth,
    wrap((req, res) => {
      const name = withApp(req, res);
      if (!name) return;
      const stateFile = path.join(appDir(name), ".factory", "state.json");
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      rearmState(state);
      state.updatedAt = new Date().toISOString();
      fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
      res.json({ ok: true });
    }),
  );

  app.post(
    "/api/incidents/:id/retry",
    auth,
    wrap((req, res) => {
      const incident = getIncident(Number(req.params.id));
      if (!incident) {
        res.status(404).json({ error: "no such incident" });
        return;
      }
      setIncident(incident.id, { status: "open", attempts: 0, last_note: "re-armed from the dashboard" });
      res.json({ ok: true });
    }),
  );

  // ---------- live updates ----------

  /**
   * Server-sent events carrying the same overview the page loads with.
   *
   * Polled server-side rather than driven by file watching: pipeline state is
   * written by several processes across two SQLite stores, and a 2s snapshot is
   * both simpler and less likely to miss a change than watching a dozen files.
   */
  app.get("/api/stream", auth, (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let last = "";
    const send = () => {
      try {
        const payload = JSON.stringify(overview());
        // Only push when something actually changed; an idle factory should not
        // repaint a dashboard every two seconds.
        if (payload !== last) {
          last = payload;
          res.write(`event: overview\ndata: ${payload}\n\n`);
        } else {
          res.write(": keep-alive\n\n");
        }
      } catch (err) {
        log.warn(`stream: ${err}`);
      }
    };

    send();
    const timer = setInterval(send, 2000);
    req.on("close", () => clearInterval(timer));
  });

  // ---------- static ----------

  app.use(express.static(publicDir, { index: "index.html", maxAge: 0 }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

  app.listen(port, host, () => {
    log.ok(`dashboard on http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
    if (exposed) log.warn(`bound to ${host} - every request needs the admin token (${path.basename(".factory-admin-token")})`);
  });
}
