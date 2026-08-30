import fs from "node:fs";
import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command and capture output. Rejects on non-zero exit only when `check` is set. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; check?: boolean } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      shell: process.platform === "win32" && cmd !== "git", // npm needs the .cmd shim; git must NOT use shell (arg quoting)
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
  const out = opts.logFile ? fs.openSync(opts.logFile, "a") : "ignore";
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    shell: process.platform === "win32" && cmd !== "git",
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
