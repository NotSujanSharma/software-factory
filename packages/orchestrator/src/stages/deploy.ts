import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { runAgentForJson } from "@factory/agents";
import { vendorFilePath, browserFilePath, VENDOR_FILE_NAME, BROWSER_FILE_NAME } from "@factory/error-sdk";
import {
  adminToken,
  commitAll,
  currentSha,
  ensureGithubRepo,
  git,
  gitTry,
  githubToken,
  killTree,
  remoteUrl,
  run,
  scrubRemoteCredentials,
  spawnDetached,
  verifyHealthy,
  waitForHttp,
} from "@factory/shared";
import { outPath, clearOut, DevReport } from "../state.ts";

export { waitForHttp } from "@factory/shared";
import { agentMeta, beginStage, endStage, type Ctx } from "./context.ts";

export async function deployStage(ctx: Ctx): Promise<void> {
  beginStage(ctx, "deploy");
  const { appDir, cfg, state } = ctx;

  // 1. Vendor the global error handlers and have a dev agent wire them in.
  fs.copyFileSync(vendorFilePath(), path.join(appDir, VENDOR_FILE_NAME));
  fs.copyFileSync(browserFilePath(), path.join(appDir, BROWSER_FILE_NAME));
  clearOut(ctx.appDir, "dev-report");
  await runAgentForJson({
    role: "developer",
    prompt: [
      `Work item DEPLOY-WIRE: integrate the global error handler.`,
      `Two files were added to the repo root: ${VENDOR_FILE_NAME} (server) and ${BROWSER_FILE_NAME} (browser).`,
      `In the server entry point:`,
      `1. require ${VENDOR_FILE_NAME} and call init() as early as possible;`,
      `2. if the app uses Express, register expressErrorHandler() AFTER all routes/middleware.`,
      `ONLY if this app serves HTML pages to a browser:`,
      `3. serve ${BROWSER_FILE_NAME} as a static file at /factory-error-sdk.js, and include it in the HTML head as`,
      `   <script src="/factory-error-sdk.js" data-app-id="..."></script> using process.env.FACTORY_APP_ID;`,
      `4. mount the SDK's own proxy for browser reports:`,
      `   app.post("/__factory_error", express.json({ limit: "64kb" }), factoryErrors.browserProxy());`,
      `SECURITY: never render FACTORY_INGEST_KEY or SENTINEL_URL into HTML, a client bundle, or a data- attribute.`,
      `The browser script reports same-origin to /__factory_error and the proxy adds the key server-side.`,
      `If the app is API-only with no HTML, skip steps 3-4 and delete ${BROWSER_FILE_NAME}.`,
      `5. if the app has no health endpoint, add GET /health returning 200 and {"status":"ok"}.`,
      `   The self-healing rollback decides whether a merged fix broke the app by calling it,`,
      `   so it must return 5xx (or fail) when the app cannot serve traffic.`,
      `Do not change any other behavior. Run npm test to confirm nothing broke.`,
      `Write .factory/out/dev-report.json with itemId "DEPLOY-WIRE".`,
    ].join("\n"),
    cwd: appDir,
    outFile: outPath(appDir, "dev-report"),
    parse: (raw) => DevReport.parse(raw),
    logFile: ctx.agentLog("deploy-wire"),
    scope: "deploy:wire",
    ...agentMeta(ctx, "deploy"),
  });
  await commitAll(appDir, "chore: wire factory error sdk for self-healing");

  // 2. Push to GitHub when enabled + token present.
  if (cfg.github.enabled && githubToken()) {
    const repo = await ensureGithubRepo(cfg.github.owner, state.app.name, cfg.github.private);
    state.app.repoUrl = repo.full_name;
    await gitTry(appDir, "remote", "remove", "origin");
    await git(appDir, "remote", "add", "origin", remoteUrl(repo.clone_url));
    // An older run may have left a tokenised URL behind in this repo.
    if (await scrubRemoteCredentials(appDir)) ctx.log.warn("scrubbed a token out of .git/config");
    await git(appDir, "push", "-u", "origin", "main", "--force-with-lease");
    ctx.log.ok(`pushed to ${repo.html_url}`);
  } else {
    ctx.log.warn("GitHub disabled or GITHUB_TOKEN missing - skipping remote push");
  }

  // 3. Register the app so healing can find it, and so it is issued the ingest key
  //    it must present to report errors. This has to happen before the app starts,
  //    because the key is handed to it through its environment.
  const port = state.app.port ?? (await findFreePort(cfg.deploy.basePort));
  state.app.port = port;
  state.app.releaseSha = await currentSha(appDir);
  ctx.save();

  const registration = {
    appId: state.app.id,
    name: state.app.name,
    dir: appDir,
    repoFull: state.app.repoUrl ?? null,
    port,
    startCmd: "npm start",
  };
  try {
    const res = await fetch(`${cfg.sentinel.url}/apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-factory-admin": adminToken() },
      body: JSON.stringify(registration),
    });
    if (!res.ok) throw new Error(`sentinel returned ${res.status}`);
    ctx.log.ok("registered with running sentinel");
  } catch {
    // Fall back to writing the store directly, so deploy order never matters.
    const { upsertApp } = await import("@factory/sentinel");
    upsertApp(registration);
    ctx.log.ok("sentinel offline - registered directly in its store");
  }

  // 4. Start the app locally with healing env wired to the sentinel.
  await startApp(ctx, port);

  endStage(ctx, "deploy", "passed", `running on http://localhost:${port}`);
}

export async function startApp(ctx: Ctx, port: number): Promise<void> {
  const { appDir, cfg, state } = ctx;
  await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: appDir, timeoutMs: 180000 });
  stopApp(appDir);
  // Read the key straight from the sentinel's store at start time. It is never
  // written to pipeline state, which lives in the app's own git repo.
  const { ingestKey } = await import("@factory/sentinel");
  const pid = spawnDetached("npm", ["start"], {
    cwd: appDir,
    env: {
      PORT: String(port),
      FACTORY_APP_ID: state.app.id,
      SENTINEL_URL: cfg.sentinel.url,
      FACTORY_RELEASE: state.app.releaseSha ?? "",
      FACTORY_INGEST_KEY: ingestKey(state.app.id) ?? "",
    },
    logFile: path.join(appDir, ".factory", "app.log"),
  });
  fs.writeFileSync(path.join(appDir, ".factory", "run.json"), JSON.stringify({ pid, port }, null, 2));
  await waitForHttp(`http://localhost:${port}/`, 30000);

  // Listening is not the same as working. Warn rather than fail here - the app may
  // legitimately have no health route yet - but say so plainly, because this is the
  // same check the post-heal rollback depends on.
  const health = await verifyHealthy(`http://localhost:${port}`, ctx.cfg.health);
  if (health.healthy) {
    ctx.log.ok(`app ${state.app.name} running on port ${port} (pid ${pid}); health: ${health.detail}`);
  } else {
    ctx.log.warn(`app ${state.app.name} started on port ${port} (pid ${pid}) but is UNHEALTHY: ${health.detail}`);
  }
}

export function stopApp(appDir: string): void {
  const runFile = path.join(appDir, ".factory", "run.json");
  if (!fs.existsSync(runFile)) return;
  try {
    const { pid } = JSON.parse(fs.readFileSync(runFile, "utf8"));
    if (pid) killTree(pid);
  } catch {
    /* ignore */
  }
  fs.rmSync(runFile, { force: true });
}

export function findFreePort(start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      if (p > start + 200) return reject(new Error("no free port found"));
      const srv = net.createServer();
      srv.once("error", () => tryPort(p + 1));
      srv.once("listening", () => srv.close(() => resolve(p)));
      srv.listen(p, "127.0.0.1");
    };
    tryPort(start);
  });
}
