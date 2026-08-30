/**
 * Tool-use guard.
 *
 * Every agent tool call passes through here before it runs. This is a guardrail,
 * not a jail: a determined agent can defeat a regex, and real isolation needs a
 * container. What it does buy, for the price of one in-process function call, is
 * that the known-catastrophic moves stop being possible rather than merely being
 * discouraged by a prompt:
 *
 *   - killing processes by name, which takes down the orchestrator and sentinel
 *     along with the app the agent meant to stop;
 *   - reaching out of the working directory into the factory's own source,
 *     config, or databases;
 *   - fetch-and-execute pipelines;
 *   - running away: a per-run tool-call ceiling bounds one agent's blast radius
 *     and, with it, the cost of a single run.
 */
import path from "node:path";
import type { FactoryConfig } from "@factory/shared";
import { frameworkRoot } from "@factory/shared";

export interface GuardDecision {
  allow: boolean;
  reason?: string;
}

export interface Guard {
  /** Evaluate one tool call. */
  check(toolName: string, input: Record<string, unknown>): GuardDecision;
  /** Tool calls seen so far this run. */
  readonly calls: number;
  /** Denials recorded this run, for logging and the run summary. */
  readonly denials: string[];
}

/** Tools whose primary path argument must stay inside the working directory. */
const PATH_ARGS: Record<string, string[]> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["path"],
  Grep: ["path"],
};

/**
 * Absolute-looking paths in a shell command, quoted or bare.
 *
 * `SEP` is spelled as a class of the two separator characters rather than an
 * inline escape: this repo lives under a path with spaces and backslashes, and the
 * quoting is easy to get subtly wrong.
 */
const SEP = "[\\\\/]";
const ABSOLUTE = new RegExp(`^(?:[A-Za-z]:${SEP}|/)`);
const CANDIDATE = new RegExp(`(?:"([^"]+)"|'([^']+)'|((?:[A-Za-z]:${SEP}|/)[^\\s"';|&]+))`, "g");

function absolutePathsIn(command: string): string[] {
  const out: string[] = [];
  for (const m of command.matchAll(CANDIDATE)) {
    const candidate = m[1] ?? m[2] ?? m[3];
    if (candidate && ABSOLUTE.test(candidate)) out.push(candidate);
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** `curl … | sh` and friends. */
const REMOTE_EXEC =
  /(?:curl|wget|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|d|k)?sh\b|\|\s*(?:iex|Invoke-Expression)\b/i;

export function makeGuard(cfg: FactoryConfig, workdir: string): Guard {
  const sb = cfg.sandbox;
  const maxCalls = cfg.budget.maxToolCallsPerRun;
  const root = path.resolve(workdir);
  const framework = frameworkRoot();
  const allowed = [root, ...sb.allowPaths.map((p) => path.resolve(p))];
  const denyRes = sb.denyCommands.map((src) => new RegExp(src, "i"));

  let calls = 0;
  const denials: string[] = [];

  const deny = (reason: string): GuardDecision => {
    denials.push(reason);
    return { allow: false, reason };
  };

  /** Allowed if inside the workdir or an explicitly allowed path. */
  const pathAllowed = (p: string): boolean => allowed.some((a) => isInside(path.resolve(root, p), a));

  return {
    get calls() {
      return calls;
    },
    get denials() {
      return denials;
    },
    check(toolName, input) {
      calls++;
      if (maxCalls > 0 && calls > maxCalls) {
        return deny(
          `tool-call ceiling reached (${maxCalls} per run). Stop working and write your output file now.`,
        );
      }
      if (!sb.enabled) return { allow: true };

      // 1. File tools: the path argument must stay in bounds. This check is exact.
      for (const arg of PATH_ARGS[toolName] ?? []) {
        const value = input[arg];
        if (typeof value !== "string" || !value) continue;
        if (sb.confineToWorkdir && !pathAllowed(value)) {
          return deny(`${toolName} path "${value}" is outside the working directory ${root}`);
        }
      }

      // 2. Shell commands.
      if (toolName === "Bash" || toolName === "BashOutput") {
        const command = String(input.command ?? "");
        if (!command) return { allow: true };

        for (const re of denyRes) {
          if (re.test(command)) {
            return deny(
              `command matches a denied pattern (${re.source}). ` +
                `If you are stopping a process, kill it by PID, never by name.`,
            );
          }
        }

        if (sb.blockRemoteExec && REMOTE_EXEC.test(command)) {
          return deny("fetch-and-execute pipelines are not allowed; download, inspect, then run.");
        }

        // Reaching into the factory's own tree - source, config, databases - is
        // never legitimate for an agent working on a generated app. Paths under
        // the working directory are fine even though it sits inside that tree.
        if (sb.confineToWorkdir) {
          for (const p of absolutePathsIn(command)) {
            const resolved = path.resolve(root, p);
            if (isInside(resolved, framework) && !pathAllowed(resolved)) {
              return deny(
                `command references "${p}", which is inside the factory's own installation ` +
                  `but outside your working directory. Work only within ${root}.`,
              );
            }
          }
        }
      }

      return { allow: true };
    },
  };
}
