/**
 * Budget policy.
 *
 * Dollar ceilings are checked *before* an agent run, because cost is only known
 * once a run completes. One run can therefore overshoot by its own cost; the turn
 * and tool-call ceilings in `BudgetConfig` are what bound that overshoot.
 *
 * The rolling daily window is the only ceiling that can recover on its own, so it
 * is the only one an unattended supervisor is allowed to sleep on. A lifetime
 * ceiling (per app, per incident, total) can never free up without a human raising
 * it, so hitting one parks the work instead of hanging forever.
 */
import type { BudgetConfig, FactoryConfig } from "./types.ts";
import {
  spendForApp,
  spendForScope,
  spendForStage,
  spendSince,
  spendTimeline,
  spendTotal,
} from "./ledger.ts";

export type BudgetKind = "daily" | "app" | "stage" | "incident" | "total";

export interface BudgetAttribution {
  appId?: string;
  stage?: string;
  /** Free-form scope; `heal:<id>` activates the per-incident ceiling. */
  scope?: string;
}

export type BudgetDecision =
  | { allowed: true }
  | {
      allowed: false;
      kind: BudgetKind;
      ceiling: number;
      spent: number;
      /** True only for the rolling window, which frees up as spend ages out. */
      recoverable: boolean;
      /** When the window will have room again. Only set when recoverable. */
      resetAt?: Date;
      message: string;
    };

/** Thrown when a run is refused and waiting cannot help. */
export class BudgetExceededError extends Error {
  readonly kind: BudgetKind;
  readonly ceiling: number;
  readonly spent: number;
  /** Marks this as a permanent failure so retry logic does not treat it as flaky. */
  readonly permanent = true;

  constructor(d: Extract<BudgetDecision, { allowed: false }>) {
    super(d.message);
    this.name = "BudgetExceededError";
    this.kind = d.kind;
    this.ceiling = d.ceiling;
    this.spent = d.spent;
  }
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

function windowStart(b: BudgetConfig, now: Date): Date {
  return new Date(now.getTime() - Math.max(1, b.dailyWindowHours) * 3_600_000);
}

/**
 * When the rolling window will have usable room again.
 *
 * Waking the instant a single cent ages out would just sleep again, so this finds
 * the moment enough spend has aged out to leave `headroom` of the ceiling free.
 */
export function dailyResetAt(b: BudgetConfig, now: Date, headroom = 0.2): Date | undefined {
  const entries = spendTimeline(windowStart(b, now));
  if (!entries.length) return undefined;

  const total = entries.reduce((s, e) => s + e.costUsd, 0);
  const target = b.dailyUsd * (1 - headroom);
  const windowMs = Math.max(1, b.dailyWindowHours) * 3_600_000;

  // Drop entries oldest-first until what remains fits under the target; the last
  // one dropped decides when the window has room.
  let remaining = total;
  for (const e of entries) {
    remaining -= e.costUsd;
    if (remaining <= target) return new Date(Date.parse(e.ts) + windowMs);
  }
  return new Date(Date.parse(entries[entries.length - 1].ts) + windowMs);
}

/** Would another agent run be within every configured ceiling? */
export function checkBudget(cfg: FactoryConfig, at: BudgetAttribution = {}, now = new Date()): BudgetDecision {
  const b = cfg.budget;
  if (!b.enabled) return { allowed: true };

  const deny = (
    kind: BudgetKind,
    ceiling: number,
    spent: number,
    label: string,
    recoverable = false,
    resetAt?: Date,
  ): BudgetDecision => ({
    allowed: false,
    kind,
    ceiling,
    spent,
    recoverable,
    resetAt,
    message:
      `${label} budget exhausted: spent ${formatUsd(spent)} of ${formatUsd(ceiling)}` +
      (recoverable && resetAt ? `; frees up at ${resetAt.toISOString()}` : ""),
  });

  if (b.totalUsd > 0) {
    const spent = spendTotal();
    if (spent >= b.totalUsd) return deny("total", b.totalUsd, spent, "total");
  }

  if (b.dailyUsd > 0) {
    const spent = spendSince(windowStart(b, now));
    if (spent >= b.dailyUsd) {
      return deny("daily", b.dailyUsd, spent, `${b.dailyWindowHours}h`, true, dailyResetAt(b, now));
    }
  }

  if (b.perAppUsd > 0 && at.appId) {
    const spent = spendForApp(at.appId);
    if (spent >= b.perAppUsd) return deny("app", b.perAppUsd, spent, "per-app");
  }

  if (b.perStageUsd > 0 && at.appId && at.stage) {
    const spent = spendForStage(at.appId, at.stage);
    if (spent >= b.perStageUsd) return deny("stage", b.perStageUsd, spent, `stage ${at.stage}`);
  }

  if (b.perIncidentUsd > 0 && at.scope?.startsWith("heal:")) {
    const spent = spendForScope(at.scope);
    if (spent >= b.perIncidentUsd) return deny("incident", b.perIncidentUsd, spent, at.scope);
  }

  return { allowed: true };
}

/** Remaining headroom under each active ceiling, for status output. */
export function budgetReport(cfg: FactoryConfig, appId?: string, now = new Date()): string[] {
  const b = cfg.budget;
  if (!b.enabled) return ["budgets: disabled"];
  const lines: string[] = [];
  const line = (label: string, spent: number, ceiling: number) =>
    lines.push(
      `${label.padEnd(16)} ${formatUsd(spent).padStart(9)} / ${
        ceiling > 0 ? formatUsd(ceiling) : "unlimited"
      }${ceiling > 0 ? `  (${Math.min(100, (spent / ceiling) * 100).toFixed(0)}%)` : ""}`,
    );

  line(`last ${b.dailyWindowHours}h`, spendSince(windowStart(b, now)), b.dailyUsd);
  line("total", spendTotal(), b.totalUsd);
  if (appId) line("this app", spendForApp(appId), b.perAppUsd);
  return lines;
}
