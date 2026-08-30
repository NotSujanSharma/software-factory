/**
 * Working out which stack an app uses, and running its commands.
 *
 * Resolution order: what the architect declared, then what the files on disk say,
 * then Node as the historical default. Detection matters for taking over an app
 * the factory did not build, and for repos written before stacks existed.
 */
import fs from "node:fs";
import path from "node:path";
import {
  hasExecutable,
  makeLogger,
  run,
  spawnDetached,
  type FactoryConfig,
  type RunResult,
} from "@factory/shared";
import { STACKS, stackById } from "./definitions.ts";
import { AppStackSchema, type AppStack, type Command, type StackDefinition } from "./types.ts";

const log = makeLogger("stack");

export function stackPath(appDir: string): string {
  return path.join(appDir, ".factory", "stack.json");
}

/** Turn a built-in template into a concrete stack record. */
export function fromDefinition(def: StackDefinition, over: Partial<AppStack> = {}): AppStack {
  return AppStackSchema.parse({
    id: def.id,
    label: def.label,
    language: def.language,
    commands: def.commands,
    portEnv: def.portEnv,
    errorSdk: def.errorSdk,
    requires: def.requires,
    ignore: def.ignore,
    ...over,
  });
}

export function loadStack(appDir: string): AppStack | null {
  try {
    return AppStackSchema.parse(JSON.parse(fs.readFileSync(stackPath(appDir), "utf8")));
  } catch {
    return null;
  }
}

export function saveStack(appDir: string, stack: AppStack): void {
  const file = stackPath(appDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stack, null, 2) + "\n");
}

/** Does a manifest pattern (possibly `*.csproj`) match anything in the directory? */
function manifestPresent(appDir: string, pattern: string): boolean {
  if (!pattern.includes("*")) return fs.existsSync(path.join(appDir, pattern));
  const suffix = pattern.replace(/^\*/, "");
  try {
    return fs.readdirSync(appDir).some((f) => f.endsWith(suffix));
  } catch {
    return false;
  }
}

/** Infer the stack from the files present. Returns null when nothing matches. */
export function detectStack(appDir: string): StackDefinition | null {
  // `static` last: an index.html sits alongside plenty of real backends.
  const ordered = [...STACKS].sort((a, b) => (a.id === "static" ? 1 : b.id === "static" ? -1 : 0));
  for (const def of ordered) {
    if (def.manifests.some((m) => manifestPresent(appDir, m))) return def;
  }
  return null;
}

/**
 * The stack to use for this app: declared, else detected, else Node.
 * Never throws - a missing stack file must not stop a pipeline that can still run.
 */
export function resolveStack(appDir: string): AppStack {
  const declared = loadStack(appDir);
  if (declared) return declared;

  const detected = detectStack(appDir);
  if (detected) {
    log.info(`no stack.json in ${appDir}; detected ${detected.label}`);
    return fromDefinition(detected);
  }
  return fromDefinition(stackById("node")!);
}

// ---------- running stack commands ----------

/** Substitute `${PORT}` (and the stack's own port variable) into command arguments. */
export function withPort(command: Command, stack: AppStack, port: number): Command {
  const value = String(port);
  return command.map((arg) =>
    arg.replaceAll("${PORT}", value).replaceAll(`\${${stack.portEnv}}`, value).replaceAll("$PORT", value),
  );
}

/**
 * Refuse a command that should never run.
 *
 * Stack commands are chosen by an agent but executed by the orchestrator, outside
 * the guard that constrains the agent's own tool use. They are argv arrays, so
 * there is no quoting to get wrong, but "start the app" must still not be able to
 * mean "shut down the machine".
 */
export function assertCommandAllowed(cfg: FactoryConfig, phase: string, command: Command): void {
  if (!command.length || command.some((a) => typeof a !== "string" || a.length === 0)) {
    throw new Error(`stack ${phase} command is empty or malformed`);
  }
  const joined = command.join(" ");
  for (const pattern of cfg.sandbox.denyCommands) {
    if (new RegExp(pattern, "i").test(joined)) {
      throw new Error(`stack ${phase} command is not allowed (matches ${pattern}): ${joined}`);
    }
  }
}

export interface StackRunOptions {
  cwd: string;
  port?: number;
  env?: Record<string, string>;
  timeoutMs?: number;
  check?: boolean;
}

/**
 * Run one phase of the stack. Returns null when the stack has no such command,
 * which is normal - plenty of ecosystems need no build, and some need no install.
 */
export async function runStackPhase(
  cfg: FactoryConfig,
  stack: AppStack,
  phase: "install" | "build" | "test" | "lint",
  opts: StackRunOptions,
): Promise<RunResult | null> {
  const command = stack.commands[phase];
  if (!command?.length) return null;
  assertCommandAllowed(cfg, phase, command);

  const argv = opts.port ? withPort(command, stack, opts.port) : command;
  const env = { ...opts.env, ...(opts.port ? { [stack.portEnv]: String(opts.port) } : {}) };
  return run(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env,
    timeoutMs: opts.timeoutMs,
    check: opts.check,
  });
}

/** Start the app as a detached process on `port`. Returns its pid. */
export function startStackApp(
  cfg: FactoryConfig,
  stack: AppStack,
  opts: { cwd: string; port: number; env?: Record<string, string>; logFile?: string },
): number {
  assertCommandAllowed(cfg, "start", stack.commands.start);
  const argv = withPort(stack.commands.start, stack, opts.port);
  return spawnDetached(argv[0], argv.slice(1), {
    cwd: opts.cwd,
    env: { ...opts.env, [stack.portEnv]: String(opts.port) },
    logFile: opts.logFile,
  });
}

/** Human-readable form, for logs and the app registry. */
export function describeCommand(command: Command | undefined): string {
  return command?.length ? command.join(" ") : "(none)";
}

/**
 * Executables this stack needs that are not installed.
 *
 * Checked immediately after the architect chooses, because discovering that `go`
 * is missing belongs at second thirty, not after a developer agent has written a
 * Go service that can never be built.
 */
export function missingTools(stack: AppStack): string[] {
  return stack.requires.filter((tool) => !hasExecutable(tool));
}

/** Which built-in stacks this machine could actually build right now. */
export function availableStacks(): { id: string; label: string; ok: boolean; missing: string[] }[] {
  return STACKS.map((def) => {
    const missing = def.requires.filter((tool) => !hasExecutable(tool));
    return { id: def.id, label: def.label, ok: missing.length === 0, missing };
  });
}

/** The catalogue an architect sees, annotated with what this machine can build. */
export function availableStackCatalogue(): string {
  return availableStacks()
    .map((s) => {
      const def = STACKS.find((d) => d.id === s.id)!;
      const status = s.ok ? "available" : `NOT INSTALLED (missing: ${s.missing.join(", ")})`;
      return `- \`${s.id}\` - ${def.label} (${def.language}) - ${status}`;
    })
    .join("\n");
}
