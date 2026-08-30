/**
 * Process helpers.
 *
 * Nothing here spawns through a shell.
 *
 * The reason it used to is Windows: `npm` is `npm.cmd`, a batch file, and
 * `CreateProcess` cannot execute one. Node's historic answer was `shell: true`,
 * which concatenates the argument array into a single command line **without
 * escaping anything** - the behaviour Node now warns about as DEP0190, and which
 * turns any argument containing `&`, `|` or `^` into command injection. Today
 * every argument is internal, but "no untrusted string ever reaches this" is a
 * property that quietly stops being true.
 *
 * So `npm` is resolved to the JavaScript file behind the shim and run as
 * `node .../npm-cli.js ...`. Node is a real executable, the argument array is
 * passed straight through, and there is no command line for anything to escape
 * out of. Everything else (git, taskkill) is already a real executable.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Commands that are shell shims on Windows and JavaScript underneath. */
const JS_SHIMS: Record<string, string[]> = {
  npm: ["node_modules/npm/bin/npm-cli.js"],
  npx: ["node_modules/npm/bin/npx-cli.js"],
};

const resolved = new Map<string, string | null>();

/** Find `cmd` on PATH, honouring PATHEXT on Windows. */
export function which(cmd: string): string | null {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of ["", ...exts]) {
      const candidate = path.join(dir, cmd + ext);
      try {
        // lstat, not stat: a Windows App Execution Alias - how the Microsoft Store
        // installs Python - is a reparse point that stat() rejects with EACCES and
        // existsSync() reports as absent, even though it runs perfectly well.
        const st = fs.lstatSync(candidate);
        if (st.isFile() || st.isSymbolicLink()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

/** Is this executable available on PATH? */
export function hasExecutable(cmd: string): boolean {
  return which(cmd) !== null;
}

/**
 * Locate the JS entry point behind a shim, so it can be run by node directly.
 * Returns null when it cannot be found, and the caller falls back.
 */
function findJsEntry(cmd: string): string | null {
  if (resolved.has(cmd)) return resolved.get(cmd) ?? null;

  const found = locateJsEntry(cmd);
  resolved.set(cmd, found);
  return found;
}

function locateJsEntry(cmd: string): string | null {
  const relatives = JS_SHIMS[cmd];
  if (!relatives) return null;

  // Most accurate: when running under an npm script, npm names its own entry point.
  const execpath = process.env.npm_execpath;
  if (cmd === "npm" && execpath?.endsWith(".js") && fs.existsSync(execpath)) return execpath;

  // Otherwise look beside the shim on PATH, then beside node itself.
  const onPath = which(cmd);
  const roots = [...(onPath ? [path.dirname(onPath)] : []), path.dirname(process.execPath)];

  for (const root of roots) {
    for (const rel of relatives) {
      const candidate = path.join(root, ...rel.split("/"));
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Environment for a child process.
 *
 * When npm runs a script it exports its own fully-resolved config as `npm_config_*`
 * variables, and a nested npm reads those back as if they had been passed on the
 * command line. Settings that are perfectly legal in an `.npmrc` are then rejected
 * as CLI flags - `allow-scripts` in a user's `.npmrc` makes every nested
 * `npm install` fail with EALLOWSCRIPTS - and the failure depends on how the
 * orchestrator happened to be launched, which is a miserable thing to debug.
 *
 * So an npm we spawn starts from a clean slate and reads its own `.npmrc` files,
 * exactly as it would if a person had run it. Only npm's own projection is
 * removed, and only when npm is what launched us: variables a user deliberately
 * exported in their shell are left alone.
 */
function childEnv(cmd: string, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  const launchedByNpm = Boolean(
    process.env.npm_lifecycle_event ?? process.env.npm_command ?? process.env.npm_config_user_agent,
  );
  if (JS_SHIMS[cmd] && launchedByNpm) {
    for (const key of Object.keys(env)) {
      if (/^npm_(config|lifecycle|package|command)/i.test(key)) delete env[key];
    }
  }
  return { ...env, ...extra };
}

/** Characters that would be interpreted rather than passed through by a shell. */
const SHELL_UNSAFE = /[&|;<>^$`"'(){}\[\]!*?\r\n%]/;

/**
 * Guard for the fallback path only. If a shell is ever unavoidable, an argument
 * carrying shell syntax is refused rather than concatenated into a command line.
 */
export function assertShellSafe(cmd: string, args: string[]): void {
  for (const arg of args) {
    if (SHELL_UNSAFE.test(arg)) {
      throw new Error(
        `refusing to run ${cmd} through a shell with an argument containing shell syntax: ${JSON.stringify(arg)}`,
      );
    }
  }
}

export interface SpawnPlan {
  file: string;
  args: string[];
  /** True only when nothing better was found; the caller must validate arguments. */
  shell: boolean;
}

/** How a command should actually be spawned. Exported for testing. */
export function planSpawn(cmd: string, args: string[]): SpawnPlan {
  const entry = findJsEntry(cmd);
  if (entry) return { file: process.execPath, args: [entry, ...args], shell: false };

  // Not a known shim, or its JS was not found. On Windows a `.cmd` still cannot be
  // executed directly, so fall back to a shell - and validate before doing so.
  const needsShell = process.platform === "win32" && JS_SHIMS[cmd] !== undefined;
  if (needsShell) assertShellSafe(cmd, args);
  return { file: cmd, args, shell: needsShell };
}

/** Run a command and capture output. Rejects on non-zero exit only when `check` is set. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; check?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let plan: SpawnPlan;
    try {
      plan = planSpawn(cmd, args);
    } catch (err) {
      reject(err);
      return;
    }

    const child = spawn(plan.file, plan.args, {
      cwd: opts.cwd,
      env: childEnv(cmd, opts.env),
      shell: plan.shell,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killTree(child.pid ?? 0);
          stderr += `\n[timed out after ${opts.timeoutMs}ms]`;
        }, opts.timeoutMs)
      : null;
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      const result = { code: code ?? -1, stdout, stderr };
      if (opts.check && result.code !== 0) {
        reject(new Error(`${cmd} ${args.join(" ")} exited ${result.code}\n${stderr || stdout}`));
      } else {
        resolve(result);
      }
    });
  });
}

/** Spawn a long-running process (e.g. `npm start`) writing to a log file; returns pid. */
export function spawnDetached(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; logFile?: string },
): number {
  const plan = planSpawn(cmd, args);
  const out = opts.logFile ? fs.openSync(opts.logFile, "a") : "ignore";
  const child = spawn(plan.file, plan.args, {
    cwd: opts.cwd,
    env: childEnv(cmd, opts.env),
    shell: plan.shell,
    detached: process.platform !== "win32",
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();
  return child.pid ?? 0;
}

/** Kill a process tree (Windows-safe). */
export function killTree(pid: number): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      process.kill(-pid, "SIGTERM");
    }
  } catch {
    /* already gone */
  }
}
