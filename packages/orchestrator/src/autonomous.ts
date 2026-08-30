/**
 * Unattended supervisor.
 *
 * Drives an app from prompt to running deployment and then keeps it alive
 * indefinitely: retrying parked stages, running evolution rounds, and hosting the
 * sentinel so runtime errors get healed. Nothing here ever reads from stdin.
 */
import net from "node:net";
import { commitAll, makeLogger, sleepWithHeartbeat } from "@factory/shared";
import type { WorkItem } from "@factory/shared";
import { formatDuration } from "@factory/agents";
import { rearmState, reopenStages } from "./state.ts";
import { runPipeline } from "./pipeline.ts";
import type { Ctx } from "./stages/context.ts";
import { developmentStage } from "./stages/development.ts";
import { gateStage } from "./stages/gates.ts";
import { evolutionStage } from "./stages/evolution.ts";
import { startApp } from "./stages/deploy.ts";

const log = makeLogger("autonomous");

/** Is something already listening on this port? */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    let settled = false;
    const done = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(inUse);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 1500);
  });
}

/**
 * Host the sentinel in this process unless one is already running. Sharing a
 * store is safe either way - healing claims are CAS-transactional - but running a
 * second scheduler against the same incidents just wastes ticks.
 */
async function ensureSentinel(ctx: Ctx): Promise<void> {
  const port = ctx.cfg.sentinel.port;
  if (await portInUse(port)) {
    log.info(`sentinel already listening on :${port} - using it`);
    return;
  }
  const { startSentinel } = await import("@factory/sentinel");
  startSentinel();
  log.ok(`sentinel started in-process on :${port}`);
}

/**
 * Run `fn` until it succeeds, re-arming the parked pipeline between attempts.
 * Session limits are already absorbed inside the agent runner, so a throw here
 * means the work genuinely did not converge.
 */
async function withStageRetries(ctx: Ctx, label: string, fn: () => Promise<void>): Promise<void> {
  const max = ctx.cfg.autonomous.maxStageRetries;
  const base = ctx.cfg.autonomous.stageRetryDelayMs;

  for (let attempt = 1; max === 0 || attempt <= max; attempt++) {
    try {
      await fn();
      return;
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err).slice(0, 400);
      const budget = max === 0 ? "unlimited" : String(max);
      log.warn(`${label} did not converge (attempt ${attempt}/${budget}): ${msg}`);

      const parked = ctx.state.stages.filter((s) => s.status === "failed" || s.status === "needs_human");
      if (parked.length) log.warn(`re-arming parked stages: ${parked.map((s) => s.name).join(", ")}`);
      rearmState(ctx.state);
      ctx.save();

      const delay = base * attempt;
      log.info(`retrying ${label} in ${formatDuration(delay)}`);
      await sleepWithHeartbeat(delay, (left) => log.info(`${label} retry in ${formatDuration(left)}`));
    }
  }
  throw new Error(`${label} exhausted ${max} retries`);
}

/** One evolution round: analyse, implement the top proposals, re-gate, restart. */
async function evolutionRound(ctx: Ctx, round: number): Promise<number> {
  const cap = Math.max(1, ctx.cfg.autonomous.evolutionMaxPerCycle);
  reopenStages(ctx.state, ["evolution"]);
  ctx.save();

  const { proposals } = await evolutionStage(ctx);
  if (!proposals.length) {
    log.info(`evolution round ${round}: no proposals`);
    return 0;
  }

  // Cheapest first: small wins ship in a round rather than stalling on one big item.
  const order = { small: 0, medium: 1, large: 2 } as const;
  const chosen = [...proposals].sort((a, b) => order[a.effort] - order[b.effort]).slice(0, cap);
  log.info(`evolution round ${round}: implementing ${chosen.map((p) => p.id).join(", ")}`);

  let n = ctx.state.tasks.length;
  for (const p of chosen) {
    ctx.state.tasks.push({
      id: `${p.id}-r${round}-${++n}`,
      title: p.workItem.title,
      description: p.workItem.description,
      dependsOn: [],
      status: "pending",
    } satisfies WorkItem);
  }
  reopenStages(ctx.state, ["development", "qa"]);
  ctx.save();

  await developmentStage(ctx);
  await gateStage(ctx, "qa");
  await commitAll(ctx.appDir, `feat: evolution round ${round} (${chosen.map((p) => p.id).join(", ")})`);

  if (ctx.state.app.port) await startApp(ctx, ctx.state.app.port);
  log.ok(`evolution round ${round} shipped: ${chosen.map((p) => p.id).join(", ")}`);
  return chosen.length;
}

export interface AutonomousOptions {
  extraContext?: string;
  /** Stop once the build reaches a running deployment instead of looping on evolution. */
  buildOnly?: boolean;
}

export async function runAutonomous(ctx: Ctx, opts: AutonomousOptions = {}): Promise<void> {
  const cfg = ctx.cfg;
  log.info(`autonomous mode for ${ctx.state.app.name} - no human input will be requested`);
  log.info(
    `stageRetries=${cfg.autonomous.maxStageRetries || "unlimited"} ` +
      `evolutionCycles=${cfg.autonomous.evolutionCycles || "unlimited"} ` +
      `waitOnLimit=${cfg.autonomous.waitOnLimit} autoMergeHeals=${cfg.approvals.autoMergeHealPRs}`,
  );

  await ensureSentinel(ctx);

  // Anything left parked by a previous run goes back on the board before we start.
  rearmState(ctx.state);
  ctx.save();

  await withStageRetries(ctx, "pipeline", () => runPipeline(ctx, opts.extraContext ?? ""));
  log.ok(`build complete - ${ctx.state.app.name} on http://localhost:${ctx.state.app.port}`);

  if (opts.buildOnly) {
    log.info("buildOnly set - not entering the evolution loop");
    return;
  }

  const maxCycles = cfg.autonomous.evolutionCycles;
  for (let round = 1; maxCycles === 0 || round <= maxCycles; round++) {
    const idle = cfg.autonomous.evolutionIntervalMs;
    log.info(`idling ${formatDuration(idle)} before evolution round ${round} (healing continues in background)`);
    await sleepWithHeartbeat(idle, (left) => log.info(`next evolution round in ${formatDuration(left)}`));

    try {
      await withStageRetries(ctx, `evolution round ${round}`, () => evolutionRound(ctx, round).then(() => undefined));
    } catch (err) {
      // A single bad round must not end the supervisor; the next one re-analyses from scratch.
      log.error(`evolution round ${round} abandoned: ${String(err).slice(0, 300)}`);
    }
  }
  // Evolution is done, but healing is not: stay up so the sentinel keeps working.
  log.ok(`evolution budget exhausted after ${maxCycles} rounds - staying up for healing`);
  for (;;) {
    await sleepWithHeartbeat(60 * 60_000, () => undefined);
    log.info(`supervisor idle - sentinel still healing ${ctx.state.app.name}`);
  }
}
