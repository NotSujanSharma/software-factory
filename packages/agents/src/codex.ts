import { spawn } from "node:child_process";
import readline from "node:readline";
import { redact, which, type Logger } from "@factory/shared";
import type { Guard } from "./guard.ts";

export interface CodexRunResult {
  text: string;
  /** Codex CLI does not currently report a monetary total in its JSONL events. */
  costUsd: number;
  turns: number;
  isError: boolean;
  denials: string[];
}

interface CodexOptions {
  prompt: string;
  cwd: string;
  model: string;
  maxTurns: number;
  rolePrompt: string;
  guard: Guard;
  log: Logger;
  record: (line: string) => void;
}

/**
 * Run Codex without requiring Claude Code or an OpenAI SDK dependency.
 *
 * `codex exec --json` is deliberately used instead of scraping human-facing
 * terminal output. The CLI owns the local coding tools and sandbox; this adapter
 * translates its JSONL events into the factory's existing transcript format.
 * The guard is still used for accounting and to stop after a denied command is
 * observed, although Codex's sandbox is the primary enforcement boundary because
 * its internal tool calls do not pass through Claude's PreToolUse hook.
 */
export function runCodexAgent(opts: CodexOptions): Promise<CodexRunResult> {
  return new Promise((resolve, reject) => {
    const codex = which("codex") ?? "codex";
    const child = spawn(
      codex,
      [
        "exec",
        "--json",
        "--sandbox",
        "workspace-write",
        "--approve-for-me",
        "--ephemeral",
        "--cd",
        opts.cwd,
        "-m",
        opts.model,
        `${opts.rolePrompt}\n\n${opts.prompt}\n\nStop after at most ${opts.maxTurns} reasoning turns and write the requested output file.`,
      ],
      { cwd: opts.cwd, env: process.env, shell: false, windowsHide: true },
    );

    let finalText = "";
    let turns = 0;
    let errorText = "";
    let stopped = false;

    const record = (line: string) => {
      const safe = redact(line);
      opts.record(safe);
      opts.log.agent(safe.length > 240 ? safe.slice(0, 240) + "…" : safe);
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        record(`[codex] ${line}`);
        return;
      }

      record(`[codex] ${JSON.stringify(event)}`);
      if (event.type === "turn.completed") turns++;

      const item = event.item;
      if (!item) return;
      if (item.type === "agent_message" && typeof item.text === "string") {
        finalText = item.text;
      }
      if (item.type === "command_execution" && typeof item.command === "string") {
        const decision = opts.guard.check("Bash", { command: item.command });
        if (!decision.allow && !stopped) {
          stopped = true;
          errorText = decision.reason ?? "Codex command denied by the factory guard";
          child.kill("SIGTERM");
        }
      }
      if (item.type === "file_change" && typeof item.path === "string") {
        const decision = opts.guard.check("Write", { file_path: item.path });
        if (!decision.allow && !stopped) {
          stopped = true;
          errorText = decision.reason ?? "Codex file change denied by the factory guard";
          child.kill("SIGTERM");
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = redact(String(chunk));
      errorText += text;
      opts.record(`[codex:stderr] ${text.trim()}`);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      rl.close();
      const failed = stopped || code !== 0;
      const text = finalText || errorText.trim() || (failed ? `[codex exited ${code}]` : "");
      resolve({
        text,
        costUsd: 0,
        turns,
        isError: failed,
        denials: opts.guard.denials,
      });
    });
  });
}
