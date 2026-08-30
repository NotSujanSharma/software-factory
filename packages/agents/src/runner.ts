import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { loadConfig, makeLogger, sleepWithHeartbeat, type Logger } from "@factory/shared";
import { formatDuration, isLimitMessage, planLimitWait } from "./limits.ts";

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
}

const promptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prompts");

function rolePrompt(role: Role): string {
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
}

/** One pass of the agent loop. Throws whatever the SDK throws. */
async function runAgentOnce(
  opts: RunAgentOptions,
  model: string,
  log: Logger,
  record: (line: string) => void,
): Promise<AgentRunResult> {
  let result: AgentRunResult = { text: "", costUsd: 0, turns: 0, isError: true };

  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      model: opts.model ?? model,
      systemPrompt: { type: "preset", preset: "claude_code", append: rolePrompt(opts.role) },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      maxTurns: opts.maxTurns ?? 80,
    },
  });

  for await (const message of q) {
    if (message.type === "assistant") {
      for (const block of message.message.content ?? []) {
        if (block.type === "text" && block.text.trim()) {
          const line = block.text.trim();
          record(`[assistant] ${line}`);
          log.agent(line.length > 200 ? line.slice(0, 200) + "\u2026" : line);
        } else if (block.type === "tool_use") {
          const input = JSON.stringify(block.input ?? {});
          record(`[tool] ${block.name} ${input}`);
          log.info(`tool: ${block.name} ${input.length > 140 ? input.slice(0, 140) + "\u2026" : input}`);
        }
      }
    } else if (message.type === "result") {
      result = {
        text: message.subtype === "success" ? message.result : `[${message.subtype}]`,
        costUsd: (message as { total_cost_usd?: number }).total_cost_usd ?? 0,
        turns: (message as { num_turns?: number }).num_turns ?? 0,
        isError: message.is_error,
      };
      record(`[result] ${result.text}`);
    }
  }
  return result;
}

/**
 * Run one agent to completion inside `cwd` with full tool access (scoped by cwd).
 * Role system prompts are appended to the Claude Code preset.
 *
 * A session/usage limit is not a failure: the run sleeps until the limit resets
 * and retries, so an unattended pipeline survives running out of tokens.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentRunResult> {
  const cfg = loadConfig();
  const log = makeLogger(opts.scope ?? `agent:${opts.role}`);
  const record = (line: string) => {
    if (opts.logFile) fs.appendFileSync(opts.logFile, line + "\n");
  };

  const waitOpts = {
    bufferMs: cfg.autonomous.limitBufferMs,
    maxWaitMs: cfg.autonomous.maxLimitWaitMs,
    fallbackMs: cfg.autonomous.limitFallbackMs,
  };

  log.agent(`starting (cwd=${opts.cwd})`);

  for (let attempt = 1; ; attempt++) {
    let result: AgentRunResult | null = null;
    let limitText: string | null = null;

    try {
      result = await runAgentOnce(opts, cfg.model, log, record);
      if (isLimitMessage(result.text)) limitText = result.text;
    } catch (err) {
      const msg = String(err instanceof Error ? err.message : err);
      if (!isLimitMessage(msg)) throw err;
      limitText = msg;
    }

    if (!limitText) {
      const done = result!;
      log[done.isError ? "error" : "ok"](
        `finished: turns=${done.turns} cost=$${done.costUsd.toFixed(3)} error=${done.isError}`,
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
