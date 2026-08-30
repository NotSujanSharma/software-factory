import { run, type RunResult } from "./proc.ts";
import { gitAuthEnv, hasEmbeddedCredential, remoteUrl } from "./gitauth.ts";

/**
 * Every git call carries the askpass environment. It costs nothing for local
 * operations and means a push or fetch simply works without a credential ever
 * being written into `.git/config`.
 */
function gitRun(args: string[], cwd?: string, check = false): Promise<RunResult> {
  return run("git", args, { cwd, check, env: gitAuthEnv() });
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await gitRun(args, cwd, true);
  return res.stdout.trim();
}

/** git that tolerates failure; returns null on non-zero exit. */
export async function gitTry(cwd: string, ...args: string[]): Promise<string | null> {
  const res = await gitRun(args, cwd);
  return res.code === 0 ? res.stdout.trim() : null;
}

/** Clone into a directory that does not exist yet (so there is no cwd to run in). */
export async function gitClone(source: string, dest: string, timeoutMs = 120_000): Promise<void> {
  await run("git", ["clone", source, dest], { check: true, timeoutMs, env: gitAuthEnv() });
}

export async function ensureRepo(dir: string): Promise<void> {
  const inside = await gitTry(dir, "rev-parse", "--is-inside-work-tree");
  if (inside !== "true") {
    await git(dir, "init", "-b", "main");
    await git(dir, "config", "user.email", "factory@self-healing.local");
    await git(dir, "config", "user.name", "Factory Bot");
  }
}

export async function commitAll(dir: string, message: string): Promise<string | null> {
  await git(dir, "add", "-A");
  const status = await git(dir, "status", "--porcelain");
  if (!status) return null;
  await git(dir, "commit", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

export async function currentSha(dir: string): Promise<string> {
  return git(dir, "rev-parse", "HEAD");
}

export async function currentBranch(dir: string): Promise<string> {
  return git(dir, "rev-parse", "--abbrev-ref", "HEAD");
}

/** Is `ref` an ancestor of main (i.e. merged)? */
export async function isMergedIntoMain(dir: string, ref: string): Promise<boolean> {
  const res = await run("git", ["merge-base", "--is-ancestor", ref, "main"], { cwd: dir });
  return res.code === 0;
}

/** The configured URL for a remote, or null when it has none. */
export async function remoteOf(dir: string, name = "origin"): Promise<string | null> {
  return gitTry(dir, "remote", "get-url", name);
}

/**
 * Rewrite a remote that still carries an embedded token, left behind by an older
 * version of this framework. Returns true when something was actually scrubbed.
 */
export async function scrubRemoteCredentials(dir: string, name = "origin"): Promise<boolean> {
  const url = await remoteOf(dir, name);
  if (!url || !hasEmbeddedCredential(url)) return false;
  await gitTry(dir, "remote", "set-url", name, remoteUrl(url));
  return true;
}
