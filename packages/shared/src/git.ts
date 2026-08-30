import { run } from "./proc.ts";

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const res = await run("git", args, { cwd, check: true });
  return res.stdout.trim();
}

/** git that tolerates failure; returns null on non-zero exit. */
export async function gitTry(cwd: string, ...args: string[]): Promise<string | null> {
  const res = await run("git", args, { cwd });
  return res.code === 0 ? res.stdout.trim() : null;
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
