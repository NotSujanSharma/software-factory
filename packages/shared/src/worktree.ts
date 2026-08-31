/**
 * Git worktrees for parallel agents.
 *
 * Two developer agents editing one checkout is a race with no referee: they
 * overwrite each other's files, and `commitAll` then commits whatever mixture
 * survived. It is worse outside JavaScript, where a lockfile written by two
 * processes at once (`Cargo.lock`, `go.sum`, `poetry.lock`) is corrupt rather
 * than merely wrong.
 *
 * So each agent gets its own worktree on its own branch: a real directory with a
 * real checkout, sharing the object database. They cannot see each other's edits,
 * and the results are merged back one at a time, where a genuine overlap surfaces
 * as a merge conflict instead of silent data loss.
 *
 * Factory bookkeeping (`.factory/`) is deliberately excluded from worktree
 * commits. It is tracked in the app repo, every worktree has a copy, and the
 * orchestrator rewrites it constantly - so committing it would make every
 * parallel wave conflict on state.json rather than on the code.
 */
import fs from "node:fs";
import path from "node:path";
import { git, gitTry } from "./git.ts";
import { makeLogger } from "./log.ts";

const log = makeLogger("worktree");

/** Everything a worktree needs to be used and cleaned up. */
export interface Worktree {
  /** Absolute path to the checkout. */
  dir: string;
  /** Branch this worktree is on. */
  branch: string;
  /** The repository it belongs to. */
  repoDir: string;
}

/** Where worktrees live: inside the repo, so one `rm -rf` cleans everything up. */
export function worktreeRoot(repoDir: string): string {
  return path.join(repoDir, ".factory", "worktrees");
}

export const WORKTREE_IGNORE = ".factory/worktrees/";

/**
 * Make sure the repo ignores the worktree root.
 *
 * Worktrees live inside the repo, so without this the main checkout's `git add -A`
 * picks each one up as a nested repository. New apps get the entry at creation;
 * this exists for apps built before worktrees did.
 */
export function ensureWorktreesIgnored(repoDir: string): void {
  const file = path.join(repoDir, ".gitignore");
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    /* no .gitignore yet */
  }
  if (current.split("\n").some((line) => line.trim() === WORKTREE_IGNORE)) return;
  fs.writeFileSync(file, (current.endsWith("\n") || !current ? current : current + "\n") + WORKTREE_IGNORE + "\n");
  log.info(`added ${WORKTREE_IGNORE} to .gitignore`);
}

/** Git refuses a branch name with spaces, `~`, `:` and friends. */
function safeBranchSegment(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 60) || "item"
  );
}

/**
 * Create a worktree branched from `base` (default HEAD).
 *
 * The branch and directory are derived from `id`, and any leftovers from a
 * previous attempt are cleared first, so a retried wave does not fail on a name
 * that already exists.
 */
export async function createWorktree(repoDir: string, id: string, base = "HEAD"): Promise<Worktree> {
  const slug = safeBranchSegment(id);
  const branch = `factory/${slug}`;
  const dir = path.join(worktreeRoot(repoDir), slug);

  await removeWorktree({ dir, branch, repoDir }, { force: true });

  fs.mkdirSync(worktreeRoot(repoDir), { recursive: true });
  await git(repoDir, "worktree", "add", "--force", "-B", branch, dir, base);
  log.info(`worktree ${branch} at ${dir}`);
  return { dir, branch, repoDir };
}

/** Remove a worktree and its branch. Never throws: cleanup must not fail a build. */
export async function removeWorktree(wt: Worktree, opts: { force?: boolean; keepBranch?: boolean } = {}): Promise<void> {
  const args = ["worktree", "remove", ...(opts.force ? ["--force"] : []), wt.dir];
  await gitTry(wt.repoDir, ...args);

  // `worktree remove` refuses a directory it does not know about; make sure it is gone.
  if (fs.existsSync(wt.dir)) {
    try {
      fs.rmSync(wt.dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* a process may still hold it; prune below will tidy the metadata */
    }
  }
  await gitTry(wt.repoDir, "worktree", "prune");
  if (!opts.keepBranch) await gitTry(wt.repoDir, "branch", "-D", wt.branch);
}

/**
 * Commit everything an agent produced in its worktree, minus factory bookkeeping.
 * Returns the new sha, or null when the agent changed nothing.
 */
export async function commitWorktree(wt: Worktree, message: string): Promise<string | null> {
  // `:(exclude).factory` keeps state.json, agent output and logs out of the commit,
  // so a merge can only ever conflict on real application code.
  await git(wt.dir, "add", "-A", "--", ".", ":(exclude).factory");
  const staged = await git(wt.dir, "diff", "--cached", "--name-only");
  if (!staged.trim()) return null;
  await git(wt.dir, "commit", "-m", message);
  return git(wt.dir, "rev-parse", "HEAD");
}

export interface MergeResult {
  branch: string;
  merged: boolean;
  /** Files git could not reconcile, when the merge failed. */
  conflicts: string[];
  detail: string;
}

/**
 * Merge a worktree branch into the current branch of `repoDir`.
 *
 * A conflict is left un-merged and reported rather than resolved: two agents
 * genuinely edited the same lines, and guessing which one was right is how an
 * automated system quietly destroys work. The caller re-queues that item so it is
 * rebuilt serially against the merged result.
 */
export async function mergeWorktree(repoDir: string, branch: string, message: string): Promise<MergeResult> {
  const before = await gitTry(repoDir, "rev-parse", "HEAD");
  const merged = await gitTry(repoDir, "merge", "--no-ff", "-m", message, branch);
  if (merged !== null) {
    const after = await gitTry(repoDir, "rev-parse", "HEAD");
    return {
      branch,
      merged: true,
      conflicts: [],
      detail: before === after ? "already up to date" : "merged",
    };
  }

  const conflicts = (await gitTry(repoDir, "diff", "--name-only", "--diff-filter=U")) ?? "";
  const files = conflicts.split("\n").map((f) => f.trim()).filter(Boolean);
  await gitTry(repoDir, "merge", "--abort");
  return {
    branch,
    merged: false,
    conflicts: files,
    detail: files.length ? `conflicts in ${files.join(", ")}` : "merge failed",
  };
}

/** Remove every worktree this framework created, e.g. after an interrupted run. */
export async function pruneWorktrees(repoDir: string): Promise<void> {
  const root = worktreeRoot(repoDir);
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root)) {
      await removeWorktree({ dir: path.join(root, entry), branch: `factory/${entry}`, repoDir }, { force: true });
    }
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort */
    }
  }
  await gitTry(repoDir, "worktree", "prune");
}
