import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FACTORY_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-test-")), "ledger.db");

const { recordSpend, spendForApp, spendForStage, spendForScope, spendSince, spendTotal, spendByRole } = await import(
  "../packages/shared/src/ledger.ts"
);
const { checkBudget, dailyResetAt, BudgetExceededError, formatUsd } = await import(
  "../packages/shared/src/budget.ts"
);
const { loadConfig } = await import("../packages/shared/src/config.ts");
import type { FactoryConfig } from "../packages/shared/src/types.ts";

const base = loadConfig();
const cfg = (over: Partial<FactoryConfig["budget"]>): FactoryConfig => ({
  ...base,
  budget: { ...base.budget, ...over },
});

const spend = (costUsd: number, over: Record<string, unknown> = {}) =>
  recordSpend({
    appId: "app-1",
    appName: "demo",
    role: "developer",
    stage: "development",
    scope: "dev:T1",
    model: "claude-opus-5",
    costUsd,
    turns: 3,
    toolCalls: 7,
    durationMs: 1000,
    isError: false,
    ...over,
  });

test("the ledger attributes spend by app, stage and scope", () => {
  spend(1.5);
  spend(2.5, { stage: "qa", scope: "qa" });
  spend(4, { appId: "app-2", appName: "other", scope: "dev:T9" });

  assert.equal(spendTotal(), 8);
  assert.equal(spendForApp("app-1"), 4);
  assert.equal(spendForApp("app-2"), 4);
  assert.equal(spendForStage("app-1", "qa"), 2.5);
  assert.equal(spendForScope("dev:T1"), 1.5);
});

test("spend rolls up by role", () => {
  const roles = spendByRole("app-1");
  assert.equal(roles.length, 1);
  assert.equal(roles[0].key, "developer");
  assert.equal(roles[0].runs, 2);
});

test("a run inside every ceiling is allowed", () => {
  const d = checkBudget(cfg({ dailyUsd: 100, perAppUsd: 100, perStageUsd: 100, totalUsd: 0 }), {
    appId: "app-1",
    stage: "development",
  });
  assert.equal(d.allowed, true);
});

test("disabled budgets allow everything", () => {
  const d = checkBudget(cfg({ enabled: false, dailyUsd: 0.01, totalUsd: 0.01 }), { appId: "app-1" });
  assert.equal(d.allowed, true);
});

test("the per-app ceiling is permanent - waiting cannot fix it", () => {
  const d = checkBudget(cfg({ perAppUsd: 1, dailyUsd: 0, totalUsd: 0 }), { appId: "app-1" });
  assert.equal(d.allowed, false);
  if (d.allowed) return;
  assert.equal(d.kind, "app");
  assert.equal(d.recoverable, false);
  assert.equal(d.resetAt, undefined);
  assert.match(d.message, /per-app budget exhausted/);
});

test("the per-stage ceiling only counts that stage", () => {
  const tight = cfg({ perStageUsd: 2, dailyUsd: 0, perAppUsd: 0, totalUsd: 0 });
  // development has $1.50 against a $2 ceiling; qa has $2.50 against the same.
  assert.equal(checkBudget(tight, { appId: "app-1", stage: "development" }).allowed, true);
  assert.equal(checkBudget(tight, { appId: "app-1", stage: "qa" }).allowed, false);
});

test("the per-incident ceiling applies only to heal scopes", () => {
  spend(6, { scope: "heal:42", stage: "heal" });
  const tight = cfg({ perIncidentUsd: 5, dailyUsd: 0, perAppUsd: 0, perStageUsd: 0, totalUsd: 0 });
  assert.equal(checkBudget(tight, { appId: "app-1", scope: "heal:42" }).allowed, false);
  assert.equal(checkBudget(tight, { appId: "app-1", scope: "heal:43" }).allowed, true);
  assert.equal(checkBudget(tight, { appId: "app-1", scope: "dev:T1" }).allowed, true);
});

test("the rolling window is recoverable and carries a reset time", () => {
  const d = checkBudget(cfg({ dailyUsd: 1, dailyWindowHours: 24, perAppUsd: 0, totalUsd: 0 }));
  assert.equal(d.allowed, false);
  if (d.allowed) return;
  assert.equal(d.kind, "daily");
  assert.equal(d.recoverable, true);
  assert.ok(d.resetAt instanceof Date);
  // Everything was just spent, so the window cannot clear until nearly a full one passes.
  const hoursAway = (d.resetAt!.getTime() - Date.now()) / 3_600_000;
  assert.ok(hoursAway > 23 && hoursAway <= 24.1, `expected ~24h, got ${hoursAway}`);
});

test("the total ceiling outranks the window, and is permanent", () => {
  const d = checkBudget(cfg({ totalUsd: 1, dailyUsd: 1 }));
  assert.equal(d.allowed, false);
  if (d.allowed) return;
  assert.equal(d.kind, "total");
  assert.equal(d.recoverable, false);
});

test("dailyResetAt waits for real headroom, not for a single cent to age out", () => {
  const b = { ...base.budget, dailyUsd: 20, dailyWindowHours: 24 };
  const now = new Date();
  const at = dailyResetAt(b, now, 0.2);
  assert.ok(at instanceof Date);
  // With everything spent recently, the wait must be substantial rather than seconds.
  assert.ok(at!.getTime() - now.getTime() > 60_000);
});

test("dailyResetAt is undefined when the window holds no spend", () => {
  const future = new Date(Date.now() + 48 * 3_600_000);
  assert.equal(dailyResetAt({ ...base.budget, dailyWindowHours: 1 }, future), undefined);
});

test("BudgetExceededError is marked permanent so retry logic leaves it alone", () => {
  const d = checkBudget(cfg({ perAppUsd: 1, dailyUsd: 0, totalUsd: 0 }), { appId: "app-1" });
  assert.equal(d.allowed, false);
  if (d.allowed) return;
  const err = new BudgetExceededError(d);
  assert.equal(err.permanent, true);
  assert.equal(err.kind, "app");
  assert.ok(err instanceof Error);
});

test("spendSince only counts the window", () => {
  assert.equal(spendSince(new Date(Date.now() + 1000)), 0);
  assert.ok(spendSince(new Date(Date.now() - 3_600_000)) > 0);
});

test("formatUsd keeps small amounts legible", () => {
  assert.equal(formatUsd(0.5), "$0.500");
  assert.equal(formatUsd(12.3456), "$12.35");
});
