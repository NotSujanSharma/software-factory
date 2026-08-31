import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import {
  BudgetExceededError,
  checkBudget,
  formatUsd,
  loadConfig,
  makeLogger,
  recordSpend,
  redact,
  sleepWithHeartbeat,
  type FactoryConfig,
  type Logger,
} from "@factory/shared";
import { formatDuration, isLimitMessage, planLimitWait } from "./limits.ts";
import { makeGuard, type Guard } from "./guard.ts";
import { runCodexAgent } from "./codex.ts";

export type Role =
  | "requirements"
  | "architect"
  | "developer"
  | "qa"
  | "reviewer"
  | "security"
  | "validator"
  | "healer"
  | "evolution";

export interface AgentRunResult {
  text: string;
  costUsd: number;
  turns: number;
  isError: boolean;
  /** Tool calls the guard refused during this run. */
  denials: string[];
}

const promptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prompts");

export function rolePrompt(role: Role): string {
  return fs.readFileSync(path.join(promptsDir, `${role}.md`), "utf8");
}

export interface RunAgentOptions {
  role: Role;
  prompt: string;
  cwd: string;
  model?: string;
  maxTurns?: number;
  logFile?: string;
  scope?: string;
  /** Attribution for the spend ledger and the per-app / per-stage budgets. */
  appId?: string;
  appName?: string;
  stage?: string;
}

/** The model this role runs on: explicit override, then per-role route, then the default. */
export function modelFor(cfg: FactoryConfig, role: Role, override?: string): string {
  return override ?? cfg.models[role] ?? cfg.model;
}

/** One pass of the agent loop. Throws whatever the SDK throws. */
async function runAgentOnce(
  opts: RunAgentOptions,
  model: string,
  cfg: FactoryConfig,
  log: Logger,
  record: (line: string) => void,
  guard: Guard,
): Promise<AgentRunResult> {
  if (cfg.provider === "codex") {
    return runCodexAgent({
      prompt: opts.prompt,
      cwd: opts.cwd,
      model,
      maxTurns: opts.maxTurns ?? cfg.budget.maxTurnsPerRun,
      rolePrompt: rolePrompt(opts.role),
      guard,
      log,
      record,
    });
  }

  let result: AgentRunResult = { text: "", costUsd: 0, turns: 0, isError: true, denials: [] };

  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      model,
      systemPrompt: { type: "preset", preset: "claude_code", append: rolePrompt(opts.role) },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      maxTurns: opts.maxTurns ?? cfg.budget.maxTurnsPerRun,
      // Permissions are bypassed above, so this hook is the only thing standing
      // between an agent and the rest of the machine.
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input) => {
                const i = input as PreToolUseHookInput;
                const decision = guard.check(i.tool_name, (i.tool_input ?? {}) as Record<string, unknown>);
                if (decision.allow) return { continue: true };
                record(`[denied] ${i.tool_name}: ${decision.reason}`);
                log.warn(`guard denied ${i.tool_name}: ${decision.reason}`);
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason: decision.reason ?? "denied by the factory guard",
                  },
                };
              },
            ],
          },
        ],
      },
    },
  });

  for await (const message of q) {
    if (message.type === "assistant") {
      for (const block of message.message.content ?? []) {
        if (block.type === "text" && block.text.trim()) {
          const line = redact(block.text.trim());
          record(`[assistant] ${line}`);
          log.agent(line.length > 200 ? line.slice(0, 200) + "…" : line);
        } else if (block.type === "tool_use") {
          const input = redact(JSON.stringify(block.input ?? {}));
          record(`[tool] ${block.name} ${input}`);
          log.info(`tool: ${block.name} ${input.length > 140 ? input.slice(0, 140) + "…" : input}`);
        }
      }
    } else if (message.type === "result") {
      result = {
        text: message.subtype === "success" ? message.result : `[${message.subtype}]`,
        costUsd: (message as { total_cost_usd?: number }).total_cost_usd ?? 0,
        turns: (message as { num_turns?: number }).num_turns ?? 0,
        isError: message.is_error,
        denials: guard.denials,
      };
      record(`[result] ${redact(result.text)}`);
    }
  }
  return result;
}

/**
 * Refuse - or defer - a run that would breach a budget.
 *
 * The rolling window is the only ceiling that recovers on its own, so it is the
 * only one worth sleeping on, and sleeping on it is what keeps an unattended run
 * hands-free instead of parking until someone notices. Every other ceiling needs a
 * human to raise it, so hitting one is a permanent failure and says so.
 */
async function gateOnBudget(cfg: FactoryConfig, opts: RunAgentOptions, log: Logger): Promise<void> {
  for (;;) {
    const decision = checkBudget(cfg, { appId: opts.appId, stage: opts.stage, scope: opts.scope });
    if (decision.allowed) return;

    if (!decision.recoverable || cfg.budget.onDailyExhausted !== "wait" || !decision.resetAt) {
      log.error(decision.message);
      throw new BudgetExceededError(decision);
    }

    const waitMs = Math.max(60_000, decision.resetAt.getTime() - Date.now());
    log.warn(
      `${decision.message} - sleeping ${formatDuration(waitMs)} until the window frees up ` +
        `(set budget.onDailyExhausted to "park" to fail instead)`,
    );
    await sleepWithHeartbeat(waitMs, (left) => log.info(`budget wait: ${formatDuration(left)} remaining`));
  }
}

/**
 * Run one agent to completion inside `cwd`, with tool access mediated by the guard.
 * Role system prompts are appended to the Claude Code preset.
 *
 * Two conditions are absorbed rather than treated as failures: a session/usage
 * limit (sleep until it resets, then retry) and an exhausted rolling budget (sleep
 * until spend ages out of the window). Every attempt is written to the ledger.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const cfg = loadConfig();
  const log = makeLogger(opts.scope ?? `agent:${opts.role}`);
  const record = (line: string) => {
    if (opts.logFile) fs.appendFileSync(opts.logFile, redact(line) + "\n");
  };
  const model = modelFor(cfg, opts.role, opts.model);

  const waitOpts = {
    bufferMs: cfg.autonomous.limitBufferMs,
    maxWaitMs: cfg.autonomous.maxLimitWaitMs,
    fallbackMs: cfg.autonomous.limitFallbackMs,
  };

  log.agent(`starting on ${model} (cwd=${opts.cwd})`);

  for (let attempt = 1; ; attempt++) {
    await gateOnBudget(cfg, opts, log);

    const guard = makeGuard(cfg, opts.cwd);
    const startedAt = Date.now();
    let result: AgentRunResult | null = null;
    let limitText: string | null = null;
    let threw: unknown = null;

    try {
      result = await runAgentOnce(opts, model, cfg, log, record, guard);
      if (isLimitMessage(result.text)) limitText = result.text;
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (isLimitMessage(msg)) limitText = msg;
      else threw = err;
    }

    // Book what this attempt cost before deciding what happens next, so a run that
    // throws or goes to sleep still lands in the ledger.
    recordSpend({
      appId: opts.appId ?? "",
      appName: opts.appName,
      role: opts.role,
      stage: opts.stage,
      scope: opts.scope ?? opts.role,
      model,
      costUsd: result?.costUsd ?? 0,
      turns: result?.turns ?? 0,
      toolCalls: guard.calls,
      durationMs: Date.now() - startedAt,
      isError: result ? result.isError : true,
    });

    if (threw) throw threw;

    if (!limitText) {
      const done = result!;
      const denied = done.denials.length ? ` denied=${done.denials.length}` : "";
      log[done.isError ? "error" : "ok"](
        `finished: turns=${done.turns} tools=${guard.calls} cost=${formatUsd(done.costUsd)} ` +
          `error=${done.isError}${denied}`,
      );
      return done;
    }

    if (!cfg.autonomous.waitOnLimit) {
      if (result) return result;
      throw new Error(limitText);
    }

    const plan = planLimitWait(limitText, waitOpts);
    record(`[limit] ${limitText}`);
    record(`[limit] sleeping ${formatDuration(plan.ms)} until ${plan.until.toISOString()} (${plan.reason})`);
    log.warn(
      `usage limit hit (attempt ${attempt}) - sleeping ${formatDuration(plan.ms)} until ${plan.until.toISOString()}; ${plan.reason}`,
    );
    await sleepWithHeartbeat(plan.ms, (left) => log.info(`limit wait: ${formatDuration(left)} remaining`));
    log.info(`limit wait over - retrying ${opts.role} agent`);
  }
}

/**
 * Run an agent whose contract is to write a JSON file; read + validate it afterwards.
 * Retries once with the validation error appended if parsing fails.
 */
export async function runAgentForJson<T>(
  opts: RunAgentOptions & { outFile: string; parse: (raw: unknown) => T },
): Promise<{ data: T; run: AgentRunResult }> {
  const attempt = async (prompt: string) => runAgent({ ...opts, prompt });
  let run = await attempt(opts.prompt);
  for (let i = 0; i < 2; i++) {
    try {
      const raw = JSON.parse(fs.readFileSync(opts.outFile, "utf8"));
      return { data: opts.parse(raw), run };
    } catch (err) {
      if (i === 1) throw new Error(`Agent output invalid after retry (${opts.outFile}): ${err}`);
      run = await attempt(
        `${opts.prompt}\n\nPREVIOUS ATTEMPT FAILED: the output file ${opts.outFile} was missing or invalid: ${err}.\nWrite a corrected version of that JSON file now. Fix only the output file unless the error demands more.`,
      );
    }
  }
  throw new Error("unreachable");
}
