import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { Command } from "commander";
import {
  loadConfig,
  makeLogger,
  workspaceRoot,
  commitAll,
  git,
  gitTry,
  githubToken,
  remoteUrl,
  AUTONOMOUS_ENV,
  budgetReport,
  formatUsd,
  recentSpend,
  spendByApp,
  spendByRole,
  spendByStage,
} from "@factory/shared";
import type { WorkItem } from "@factory/shared";
import { appDirFor, createApp, openApp, runPipeline } from "./pipeline.ts";
import { outPath, clearOut, rearmState, DevReport, EvolutionOut } from "./state.ts";
import { runAutonomous } from "./autonomous.ts";
import { fixLeakedCredentials, preflight, renderChecks, runChecks } from "./preflight.ts";
import { developmentStage } from "./stages/development.ts";
import { gateStage } from "./stages/gates.ts";
import { deployStage, startApp, stopApp } from "./stages/deploy.ts";
import { runAgentForJson } from "@factory/agents";

const log = makeLogger("cli");
const program = new Command();
program.name("factory").description("Self-healing, self-evolving application factory");

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 4).join("-");
}

async function pushMain(appDir: string, repoFull?: string): Promise<void> {
  if (repoFull && githubToken()) {
    await gitTry(appDir, "remote", "set-url", "origin", remoteUrl(`https://github.com/${repoFull}.git`));
    await git(appDir, "push", "origin", "main");
  }
}

program
  .command("build")
  .argument("<prompt...>", "what to build")
  .option("--name <name>", "app name (defaults to a slug of the prompt)")
  .option("--auto", "no interactive questions; agent records assumptions", false)
  .action(async (promptWords: string[], opts: { name?: string; auto: boolean }) => {
    const cfg = loadConfig();
    const prompt = promptWords.join(" ");
    const name = opts.name ?? slug(prompt);
    let extra = "";
    if (!opts.auto) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      extra = await rl.question("Any constraints, preferences or details to add? (enter to skip)\n> ");
      rl.close();
    }
    await preflight(cfg);
    const ctx = await createApp(cfg, name, prompt);
    await runPipeline(ctx, extra.trim());
  });

program
  .command("resume")
  .argument("<app>")
  .action(async (name: string) => {
    const cfg = loadConfig();
    await preflight(cfg);
    const ctx = openApp(cfg, name);
    rearmState(ctx.state);
    ctx.save();
    await runPipeline(ctx);
  });

program
  .command("auto")
  .argument("[prompt...]", "what to build (omit when --app names an existing app)")
  .option("--app <name>", "run against an existing app instead of creating one")
  .option("--name <name>", "app name for a new build (defaults to a slug of the prompt)")
  .option("--build-only", "stop once the app is deployed; skip the evolution loop", false)
  .option("--skip-preflight", "start without checking the environment first", false)
  .description("build, deploy, heal and evolve with no human involvement")
  .action(
    async (promptWords: string[], opts: { app?: string; name?: string; buildOnly: boolean; skipPreflight: boolean }) => {
    // `auto` means autonomous whatever the config file says. Set before loadConfig
    // so every package - and every process spawned from here - sees the same thing.
    process.env[AUTONOMOUS_ENV] = "1";
    const cfg = loadConfig();
    // An unattended run has nobody to notice a bad environment, so this matters
    // most here: it is the difference between failing in a second and failing
    // after eight stages of paid work.
    if (!opts.skipPreflight) await preflight(cfg);

    const prompt = promptWords.join(" ").trim();
    let ctx;
    if (opts.app) {
      ctx = openApp(cfg, opts.app);
    } else {
      if (!prompt) throw new Error("give a prompt to build, or --app <name> to continue an existing one");
      const name = opts.name ?? slug(prompt);
      const dir = appDirFor(cfg, name);
      ctx = fs.existsSync(path.join(dir, ".factory", "state.json"))
        ? openApp(cfg, name)
        : await createApp(cfg, name, prompt);
    }

      await runAutonomous(ctx, { buildOnly: opts.buildOnly });
    },
  );

program
  .command("status")
  .argument("<app>")
  .action((name: string) => {
    const ctx = openApp(loadConfig(), name);
    console.log(`app: ${ctx.state.app.name} (${ctx.state.app.id})`);
    console.log(`prompt: ${ctx.state.app.prompt}`);
    console.log(`repo: ${ctx.state.app.repoUrl ?? "(local only)"}  port: ${ctx.state.app.port ?? "-"}`);
    for (const s of ctx.state.stages) {
      console.log(`  ${s.name.padEnd(13)} ${s.status.padEnd(12)} iter=${s.iterations} ${s.notes ?? ""}`);
    }
    const t = ctx.state.tasks;
    console.log(`tasks: ${t.filter((x) => x.status === "done").length}/${t.length} done`);
  });

program
  .command("apps")
  .action(() => {
    const cfg = loadConfig();
    const ws = workspaceRoot(cfg);
    if (!fs.existsSync(ws)) return console.log("(no apps)");
    for (const d of fs.readdirSync(ws)) {
      if (fs.existsSync(path.join(ws, d, ".factory", "state.json"))) console.log(d);
    }
  });

program
  .command("stop")
  .argument("<app>")
  .action((name: string) => {
    const cfg = loadConfig();
    stopApp(appDirFor(cfg, name));
    log.ok(`${name} stopped`);
  });

program
  .command("sentinel")
  .argument("<action>", "start")
  .option("--skip-preflight", "start without checking the environment first", false)
  .action(async (action: string, opts: { skipPreflight: boolean }) => {
    if (action !== "start") throw new Error("only: sentinel start");
    // The sentinel runs healing agents, so it needs the same environment a build does.
    if (!opts.skipPreflight) await preflight(loadConfig());
    const { startSentinel } = await import("@factory/sentinel");
    startSentinel();
  });

program
  .command("evolve")
  .argument("<app>")
  .option("--all", "implement all proposals without asking", false)
  .action(async (name: string, opts: { all: boolean }) => {
    const cfg = loadConfig();
    const ctx = openApp(cfg, name);
    const evoFile = outPath(ctx.appDir, "evolution");
    if (!fs.existsSync(evoFile)) throw new Error("no evolution proposals yet - run the pipeline first");
    const { proposals } = EvolutionOut.parse(JSON.parse(fs.readFileSync(evoFile, "utf8")));
    if (!proposals.length) return log.info("no proposals recorded");

    for (const p of proposals) console.log(`  [${p.id}] (${p.effort}) ${p.title} - ${p.value}`);
    let chosen = proposals;
    if (!opts.all && !cfg.approvals.autoImplementEvolution) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question("Which proposals to implement? (comma-separated ids, or none)\n> ");
      rl.close();
      if (!answer.trim() || answer.trim().toLowerCase() === "none") return;
      const ids = answer.split(",").map((s) => s.trim().toUpperCase());
      chosen = proposals.filter((p) => ids.includes(p.id.toUpperCase()));
    }
    if (!chosen.length) return;

    let n = ctx.state.tasks.length;
    for (const p of chosen) {
      ctx.state.tasks.push({
        id: `${p.id}-${++n}`,
        title: p.workItem.title,
        description: p.workItem.description,
        dependsOn: [],
        status: "pending",
      } satisfies WorkItem);
    }
    ctx.save();
    await developmentStage(ctx);
    await gateStage(ctx, "qa");
    await pushMain(ctx.appDir, ctx.state.app.repoUrl);
    if (ctx.state.app.port) await startApp(ctx, ctx.state.app.port);
    log.ok(`evolution items shipped: ${chosen.map((p) => p.id).join(", ")}`);
  });

program
  .command("doctor")
  .option("--no-probe", "skip the live agent-auth check (it costs a fraction of a cent)")
  .option("--fix", "scrub tokens out of any repo config still holding one", false)
  .description("check the environment before it costs you a build")
  .action(async (opts: { probe: boolean; fix: boolean }) => {
    const cfg = loadConfig();
    if (opts.fix) {
      const fixed = await fixLeakedCredentials(cfg);
      if (fixed.length) log.ok(`scrubbed tokens from: ${fixed.join(", ")} - now rotate that token`);
    }
    const results = await runChecks(cfg, { probe: opts.probe });
    console.log(renderChecks(results));

    const failed = results.filter((r) => r.status === "fail").length;
    const warned = results.filter((r) => r.status === "warn").length;
    console.log("");
    if (failed) {
      log.error(`${failed} check(s) failed, ${warned} warning(s) - a build would not get far`);
      process.exitCode = 1;
    } else if (warned) {
      log.warn(`all critical checks passed, ${warned} warning(s)`);
    } else {
      log.ok("all checks passed");
    }
  });

program
  .command("cost")
  .option("--app <name>", "break the report down for one app")
  .option("--recent <n>", "also list the N most recent agent runs", "0")
  .description("spend ledger and remaining budget headroom")
  .action((opts: { app?: string; recent: string }) => {
    const cfg = loadConfig();
    const appId = opts.app ? openApp(cfg, opts.app).state.app.id : undefined;

    console.log("budgets");
    for (const line of budgetReport(cfg, appId)) console.log(`  ${line}`);

    const table = (title: string, rows: { key: string; costUsd: number; runs: number; errors: number }[]) => {
      if (!rows.length) return;
      console.log("");
      console.log(title);
      for (const r of rows) {
        console.log(
          `  ${r.key.padEnd(16)} ${formatUsd(r.costUsd).padStart(9)}  ${String(r.runs).padStart(3)} runs` +
            (r.errors ? `  ${r.errors} errored` : ""),
        );
      }
    };

    if (appId) {
      table("by stage", spendByStage(appId));
      table("by role", spendByRole(appId));
    } else {
      table("by app", spendByApp());
      table("by role", spendByRole());
    }

    const n = Number(opts.recent);
    if (n > 0) {
      console.log("");
      console.log("recent runs");
      for (const r of recentSpend(n)) {
        console.log(
          `  ${r.ts.slice(0, 19)}  ${(r.appName ?? "-").padEnd(12)} ${r.role.padEnd(12)} ` +
            `${formatUsd(r.costUsd).padStart(9)}  turns=${r.turns} tools=${r.toolCalls}${r.isError ? "  ERROR" : ""}`,
        );
      }
    }
  });

program
  .command("rotate-key")
  .argument("<app>")
  .description("issue a new ingest key; the app must be restarted to pick it up")
  .action(async (name: string) => {
    const ctx = openApp(loadConfig(), name);
    const { rotateIngestKey } = await import("@factory/sentinel");
    rotateIngestKey(ctx.state.app.id);
    log.ok(`ingest key rotated for ${name} - restart it so it picks the new one up`);
  });

program
  .command("demo-error")
  .argument("<app>")
  .description("plant a realistic bug, redeploy, and trigger it twice (e2e healing demo)")
  .action(async (name: string) => {
    const cfg = loadConfig();
    const ctx = openApp(cfg, name);
    if (!ctx.state.app.port) throw new Error("app has no port - run the deploy stage first");

    clearOut(ctx.appDir, "dev-report");
    const { data } = await runAgentForJson({
      role: "developer",
      prompt: [
        "Work item DEMO-BUG: introduce ONE realistic regression bug for a self-healing demo.",
        "Pick an existing endpoint handler and weaken it the way a rushed commit would (remove a null/undefined check, mis-handle a missing field, index into possibly-empty data) so that ONE specific HTTP request causes an unhandled exception at runtime.",
        "Do NOT modify or delete tests, and the existing npm test suite must still pass (the bug must live in a path the tests do not cover).",
        'Write .factory/out/dev-report.json including "crashRepro": {"method": "GET or POST", "path": "/exact/path?with=args", "body": <json or null>} describing the exact request that triggers the crash.',
      ].join("\n"),
      cwd: ctx.appDir,
      outFile: outPath(ctx.appDir, "dev-report"),
      parse: (raw) => DevReport.parse(raw),
      logFile: ctx.agentLog("demo-bug"),
      scope: "demo-bug",
      appId: ctx.state.app.id,
      appName: ctx.state.app.name,
    });
    if (!data.crashRepro) throw new Error("dev agent did not provide crashRepro");
    await commitAll(ctx.appDir, "chore: (demo) simulated regression for self-healing test");
    await pushMain(ctx.appDir, ctx.state.app.repoUrl);
    await startApp(ctx, ctx.state.app.port);

    const url = `http://localhost:${ctx.state.app.port}${data.crashRepro.path}`;
    log.info(`triggering ${data.crashRepro.method} ${url} (twice, to prove dedup)`);
    for (let i = 0; i < 2; i++) {
      try {
        await fetch(url, {
          method: data.crashRepro.method,
          headers: { "Content-Type": "application/json" },
          body: data.crashRepro.body ? JSON.stringify(data.crashRepro.body) : undefined,
        });
      } catch { /* connection reset on crash is fine */ }
      await new Promise((r) => setTimeout(r, 1200));
    }
    log.ok("done - check the sentinel dashboard for exactly ONE incident");
  });

program.parseAsync().catch((err) => {
  log.error(String(err instanceof Error ? err.message : err));
  process.exitCode = 1;
});
