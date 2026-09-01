import { test } from "node:test";
import assert from "node:assert/strict";

import { isLimitMessage, parseLimitReset, planLimitWait, formatDuration } from "../packages/agents/src/limits.ts";
import { rearmState, newState, STAGE_ORDER } from "../packages/orchestrator/src/state.ts";
import { loadConfig, AUTONOMOUS_ENV, DEFAULT_CONFIG } from "../packages/shared/src/config.ts";
import type { AppMeta, PipelineState } from "../packages/shared/src/types.ts";

const WAIT_OPTS = { bufferMs: 60_000, maxWaitMs: 6 * 3_600_000, fallbackMs: 600_000 };

// ---------- limit detection ----------

test("detects the real session-limit message", () => {
  assert.ok(isLimitMessage("You've hit your session limit - resets 8pm (America/Toronto)"));
  assert.ok(isLimitMessage("Claude usage limit reached. Your limit will reset at 3am."));
  assert.ok(isLimitMessage('{"type":"error","error":{"type":"rate_limit_error"}}'));
  assert.ok(isLimitMessage("429 Too Many Requests"));
});

test("does not mistake ordinary agent prose for a limit", () => {
  // A false positive would put the whole pipeline to sleep, so these must not match.
  assert.equal(isLimitMessage("Added rate limiting to the /api/todos endpoint."), false);
  assert.equal(isLimitMessage("The counter resets 5 times per day in this test."), false);
  assert.equal(isLimitMessage("Implemented pagination with a default limit of 20."), false);
  assert.equal(isLimitMessage(""), false);
  assert.equal(isLimitMessage(undefined), false);
});

// ---------- reset-time parsing ----------

test("parses a wall-clock reset time in a named timezone", () => {
  // 2026-08-29T18:00Z is 14:00 in Toronto (EDT), so 8pm the same day is 4h away.
  const now = new Date("2026-08-29T18:00:00Z");
  const reset = parseLimitReset("You've hit your session limit - resets 8pm (America/Toronto)", now);
  assert.ok(reset, "expected a reset time");
  assert.equal(reset!.toISOString(), "2026-08-30T00:00:00.000Z");
});

test("rolls a reset time that already passed today to tomorrow", () => {
  // 03:00Z is 23:00 the previous day in Toronto, so "resets 8pm" is next-day 8pm.
  const now = new Date("2026-08-30T03:00:00Z");
  const reset = parseLimitReset("session limit reached, resets 8pm (America/Toronto)", now);
  assert.ok(reset);
  assert.ok(reset!.getTime() > now.getTime(), "reset must be in the future");
  assert.equal(reset!.toISOString(), "2026-08-31T00:00:00.000Z");
});

test("parses relative and absolute reset forms", () => {
  const now = new Date("2026-08-29T18:00:00Z");
  assert.equal(
    parseLimitReset("rate_limit_error: try again in 45 minutes", now)!.toISOString(),
    "2026-08-29T18:45:00.000Z",
  );
  assert.equal(
    parseLimitReset("usage limit reached; resets at 2026-08-30T01:30:00Z", now)!.toISOString(),
    "2026-08-30T01:30:00.000Z",
  );
});

test("handles am/pm and midnight correctly", () => {
  const now = new Date("2026-08-29T10:00:00Z"); // 06:00 Toronto
  assert.equal(parseLimitReset("limit resets 12am (America/Toronto)", now)!.toISOString(), "2026-08-30T04:00:00.000Z");
  assert.equal(parseLimitReset("limit resets 12pm (America/Toronto)", now)!.toISOString(), "2026-08-29T16:00:00.000Z");
});

test("returns null when there is no parseable time", () => {
  assert.equal(parseLimitReset("You've hit your session limit", new Date()), null);
});

// ---------- wait planning ----------

test("plans a wait that clears the reset time plus a buffer", () => {
  // 21:00Z is 17:00 in Toronto, so 8pm local is exactly 3h out.
  const now = new Date("2026-08-29T21:00:00Z");
  const plan = planLimitWait("session limit - resets 8pm (America/Toronto)", WAIT_OPTS, now);
  assert.equal(plan.ms, 3 * 3_600_000 + WAIT_OPTS.bufferMs);
  assert.equal(plan.until.toISOString(), "2026-08-30T00:01:00.000Z");
  assert.match(plan.reason, /resets/);
});

test("falls back to a backoff when no reset time is given", () => {
  const plan = planLimitWait("You've hit your session limit", WAIT_OPTS, new Date());
  assert.equal(plan.ms, WAIT_OPTS.fallbackMs);
  assert.match(plan.reason, /fallback/);
});

test("caps an absurd wait and says it will re-check", () => {
  const now = new Date("2026-08-29T18:00:00Z");
  const plan = planLimitWait("usage limit reached; resets at 2027-01-01T00:00:00Z", WAIT_OPTS, now);
  assert.equal(plan.ms, WAIT_OPTS.maxWaitMs);
  assert.match(plan.reason, /capped/);
});

test("never returns a non-positive wait", () => {
  const now = new Date("2026-08-29T18:00:00Z");
  const plan = planLimitWait("usage limit reached; resets at 2020-01-01T00:00:00Z", WAIT_OPTS, now);
  assert.ok(plan.ms >= 1000);
});

test("formatDuration is readable", () => {
  assert.equal(formatDuration(4 * 3_600_000 + 60_000), "4h 01m");
  assert.equal(formatDuration(90_000), "1m 30s");
  assert.equal(formatDuration(5_000), "5s");
});

// ---------- autonomous config override ----------

test("the autonomous env var removes every approval gate, in-process and for children", () => {
  const previous = process.env[AUTONOMOUS_ENV];
  try {
    delete process.env[AUTONOMOUS_ENV];
    const off = loadConfig();
    assert.equal(off.autonomous.enabled, false, "config file must stay the default for normal runs");
    assert.equal(off.approvals.autoMergeHealPRs, false);

    process.env[AUTONOMOUS_ENV] = "1";
    const on = loadConfig();
    assert.equal(on.autonomous.enabled, true);
    assert.equal(on.autonomous.waitOnLimit, true);
    assert.equal(on.approvals.autoMergeHealPRs, true);
    assert.equal(on.approvals.autoImplementEvolution, true);

    // Tuning from factory.config.json must survive the override.
    assert.equal(on.autonomous.evolutionMaxPerCycle, off.autonomous.evolutionMaxPerCycle);
    assert.equal(on.autonomous.maxStageRetries, off.autonomous.maxStageRetries);
    assert.equal(on.model, off.model);
  } finally {
    if (previous === undefined) delete process.env[AUTONOMOUS_ENV];
    else process.env[AUTONOMOUS_ENV] = previous;
  }
});

test("agent provider defaults to Claude and accepts Codex configuration", () => {
  // The shipped default, not whatever this checkout happens to be set to:
  // asserting the live config file meant the suite failed for anyone who had
  // legitimately switched the factory over to Codex.
  assert.equal(DEFAULT_CONFIG.provider, "claude");
  assert.ok(["claude", "codex"].includes(loadConfig().provider));
});

test("a pipeline environment snapshot overrides later config reads", () => {
  const oldProvider = process.env.FACTORY_AGENT_PROVIDER;
  const oldModel = process.env.FACTORY_AGENT_MODEL;
  process.env.FACTORY_AGENT_PROVIDER = "codex";
  process.env.FACTORY_AGENT_MODEL = "gpt-5.3-codex";
  try {
    const cfg = loadConfig();
    assert.equal(cfg.provider, "codex");
    assert.equal(cfg.model, "gpt-5.3-codex");
  } finally {
    if (oldProvider === undefined) delete process.env.FACTORY_AGENT_PROVIDER;
    else process.env.FACTORY_AGENT_PROVIDER = oldProvider;
    if (oldModel === undefined) delete process.env.FACTORY_AGENT_MODEL;
    else process.env.FACTORY_AGENT_MODEL = oldModel;
  }
});

// ---------- pipeline re-arming ----------

function stateWith(): PipelineState {
  const app: AppMeta = { id: "a-1", name: "a", prompt: "p", dir: "C:/ws/a" };
  return newState(app);
}

test("rearmState puts parked stages and failed tasks back on the board", () => {
  const s = stateWith();
  s.stages[0].status = "passed";
  s.stages[1].status = "needs_human";
  s.stages[2].status = "failed";
  s.stages[3].status = "running";
  s.tasks = [
    { id: "T1", title: "a", description: "", dependsOn: [], status: "done" },
    { id: "T2", title: "b", description: "", dependsOn: [], status: "failed" },
    { id: "T3", title: "c", description: "", dependsOn: [], status: "in_progress" },
  ];

  rearmState(s);

  assert.equal(s.stages[0].status, "passed", "completed work must not be redone");
  assert.equal(s.stages[1].status, "pending");
  assert.equal(s.stages[2].status, "pending");
  assert.equal(s.stages[3].status, "pending");
  assert.equal(s.tasks[0].status, "done");
  assert.equal(s.tasks[1].status, "pending", "a failed task must be retryable - this is what broke resume");
  assert.equal(s.tasks[2].status, "pending");
});

test("rearmState is idempotent and covers every stage name", () => {
  const s = stateWith();
  for (const rec of s.stages) rec.status = "failed";
  rearmState(s);
  rearmState(s);
  assert.equal(s.stages.length, STAGE_ORDER.length);
  assert.ok(s.stages.every((x) => x.status === "pending"));
});
