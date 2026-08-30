import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { runAgentForJson } from "@factory/agents";
import { CONTRACT_FILE_NAME, sdkFor, vendorInto } from "@factory/error-sdk";
import { describeCommand, runStackPhase, startStackApp } from "@factory/stacks";
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
  scrubRemoteCredentials,
  verifyHealthy,
  waitForHttp,
} from "@factory/shared";
import { outPath, clearOut, DevReport } from "../state.ts";

export { waitForHttp } from "@factory/shared";
import { agentMeta, beginStage, endStage, type Ctx } from "./context.ts";

/**
 * Does this app serve HTML to a browser? Only then is the browser-side error
 * handler worth wiring, and only then does the key-exposure question arise.
 */
function servesHtml(appDir: string): boolean {
  const hints = ["public", "static", "views", "templates", "src/pages", "index.html"];
  return hints.some((h) => fs.existsSync(path.join(appDir, h)));
}

export async function deployStage(ctx: Ctx): Promise<void> {
  beginStage(ctx, "deploy");
  const { appDir, cfg, state } = ctx;
  const stack = ctx.stack();

  // 1. Vendor whatever error reporting this stack can use, and have a dev agent
  //    wire it in. Node and Python get a real SDK; every other language gets the
  //    wire contract and writes the integration itself, which is the only approach
  //    that scales past two ecosystems.
  const sdk = sdkFor(stack.errorSdk, servesHtml(appDir));
  const written = vendorInto(appDir, sdk);
  ctx.log.info(`vendored for ${stack.label}: ${written.join(", ")}`);

  clearOut(ctx.appDir, "dev-report");
  const { data: wireReport } = await runAgentForJson({
    role: "developer",
    prompt: [
      `Work item DEPLOY-WIRE: integrate runtime error reporting so this app can heal itself.`,
      ``,
      ctx.stackContext(),
      ``,
      `These files were added to the repo root: ${written.join(", ")}.`,
      ``,
      ...sdk.instructions,
      ``,
      `The app reads its port from ${stack.portEnv}, and the factory sets FACTORY_APP_ID,`,
      `SENTINEL_URL, FACTORY_INGEST_KEY and FACTORY_RELEASE in its environment.`,
      ``,
      `SECURITY: never render FACTORY_INGEST_KEY or SENTINEL_URL into HTML, a client bundle,`,
      `a template, or a log. Browser errors must be posted same-origin to your own server,`,
      `which adds the key and forwards them.`,
      ``,
      `Also expose GET /health returning 200 with a small JSON body, if the app has no health`,
      `endpoint already. The self-healing rollback decides whether a merged fix broke the app`,
      `by calling it, so it must fail or return 5xx when the app cannot serve traffic.`,
      ``,
      `VERIFY before you finish: start the app, trigger one real error, and confirm the`,
      `sentinel accepted it (HTTP 200 with an incidentId). Remove anything you added only in`,
      `order to trigger it. Report the outcome as "sdkVerified" in your dev report.`,
      ``,
      `Do not change any other behavior. Run \`${describeCommand(stack.commands.test)}\` to confirm nothing broke.`,
      `Write .factory/out/dev-report.json with itemId "DEPLOY-WIRE".`,
    ].join("\n"),
    cwd: appDir,
    outFile: outPath(appDir, "dev-report"),
    parse: (raw) => DevReport.parse(raw),
    logFile: ctx.agentLog("deploy-wire"),
    scope: "deploy:wire",
    ...agentMeta(ctx, "deploy"),
  });
  if (wireReport.sdkVerified === false) {
    ctx.log.warn("error reporting was NOT verified end to end - healing may never trigger for this app");
  }

  // The contract is reference material for the agent, not part of the app.
  fs.rmSync(path.join(appDir, CONTRACT_FILE_NAME), { force: true });
  await commitAll(appDir, "chore: wire factory error reporting for self-healing");

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
    startCmd: describeCommand(stack.commands.start),
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

  endStage(ctx, "deploy", "passed", `running on http://localhost:${port} (${stack.label})`);
}

export async function startApp(ctx: Ctx, port: number): Promise<void> {
  const { appDir, cfg, state } = ctx;
  const stack = ctx.stack();

  // Install and build through the stack's own commands: npm, pip, go mod, cargo,
  // bundler - whatever this app actually is.
  const install = await runStackPhase(cfg, stack, "install", { cwd: appDir, port, timeoutMs: 300_000 });
  if (install && install.code !== 0) {
    ctx.log.warn(
      `install failed (${describeCommand(stack.commands.install)}): ${(install.stderr || install.stdout).slice(-400)}`,
    );
  }
  const build = await runStackPhase(cfg, stack, "build", { cwd: appDir, port, timeoutMs: 600_000 });
  if (build && build.code !== 0) {
    throw new Error(
      `build failed (${describeCommand(stack.commands.build)}):\n${(build.stderr || build.stdout).slice(-1500)}`,
    );
  }

  stopApp(appDir);
  // Read the key straight from the sentinel's store at start time. It is never
  // written to pipeline state, which lives in the app's own git repo.
  const { ingestKey } = await import("@factory/sentinel");
  const pid = startStackApp(cfg, stack, {
    cwd: appDir,
    port,
    env: {
      FACTORY_APP_ID: state.app.id,
      SENTINEL_URL: cfg.sentinel.url,
      FACTORY_RELEASE: state.app.releaseSha ?? "",
      FACTORY_INGEST_KEY: ingestKey(state.app.id) ?? "",
    },
    logFile: path.join(appDir, ".factory", "app.log"),
  });
  fs.writeFileSync(path.join(appDir, ".factory", "run.json"), JSON.stringify({ pid, port }, null, 2));
  // Compiled and JVM stacks take noticeably longer to come up than node does.
  await waitForHttp(`http://localhost:${port}/`, 60_000);

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
