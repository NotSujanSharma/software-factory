import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { git, gitTry, ensureRepo, commitAll } = await import("../packages/shared/src/git.ts");
const {
  commitWorktree,
  createWorktree,
  mergeWorktree,
  pruneWorktrees,
  removeWorktree,
  worktreeRoot,
} = await import("../packages/shared/src/worktree.ts");

/** A repo shaped like one the factory would have created. */
async function makeRepo(files: Record<string, string> = {}): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-test-"));
  await ensureRepo(dir);
  fs.writeFileSync(path.join(dir, ".gitignore"), ".factory/logs/\n.factory/worktrees/\nnode_modules/\n");
  fs.mkdirSync(path.join(dir, ".factory", "out"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".factory", "state.json"), JSON.stringify({ tasks: [] }));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  await commitAll(dir, "chore: init");
  return dir;
}

const read = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");

/**
 * Write an agent's report into a worktree. Git does not track empty directories,
 * so `.factory/out` does not exist in a fresh checkout - production creates it via
 * clearOut() before every run, and this mirrors that.
 */
function writeReport(dir: string, body: string): void {
  const out = path.join(dir, ".factory", "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "dev-report.json"), body);
}

test("two agents working in parallel both land their work", async () => {
  const repo = await makeRepo({ "src/app.js": "// app\n", "README.md": "# app\n" });

  const a = await createWorktree(repo, "T1");
  const b = await createWorktree(repo, "T2");

  // Each worktree is a real, independent checkout.
  assert.ok(fs.existsSync(path.join(a.dir, "src", "app.js")));
  assert.ok(fs.existsSync(path.join(b.dir, "src", "app.js")));
  assert.notEqual(a.dir, b.dir);

  fs.writeFileSync(path.join(a.dir, "src", "todos.js"), "module.exports = { list: () => [] };\n");
  fs.writeFileSync(path.join(b.dir, "src", "users.js"), "module.exports = { list: () => [] };\n");

  // Neither can see the other's work: that is the entire point.
  assert.equal(fs.existsSync(path.join(a.dir, "src", "users.js")), false);
  assert.equal(fs.existsSync(path.join(b.dir, "src", "todos.js")), false);

  assert.ok(await commitWorktree(a, "feat: T1 todos"));
  assert.ok(await commitWorktree(b, "feat: T2 users"));

  const mergeA = await mergeWorktree(repo, a.branch, "merge: T1");
  const mergeB = await mergeWorktree(repo, b.branch, "merge: T2");
  assert.equal(mergeA.merged, true, mergeA.detail);
  assert.equal(mergeB.merged, true, mergeB.detail);

  // Both agents' files are in the app checkout, and neither clobbered the other.
  assert.ok(fs.existsSync(path.join(repo, "src", "todos.js")), "T1's work should have landed");
  assert.ok(fs.existsSync(path.join(repo, "src", "users.js")), "T2's work should have landed");

  await pruneWorktrees(repo);
});

test("a genuine conflict is reported, not silently resolved", async () => {
  const repo = await makeRepo({ "src/config.js": "module.exports = { port: 3000 };\n" });

  const a = await createWorktree(repo, "T1");
  const b = await createWorktree(repo, "T2");

  // Both agents rewrite the same line - the case that used to lose one of them.
  fs.writeFileSync(path.join(a.dir, "src/config.js"), "module.exports = { port: 4000, db: 'a' };\n");
  fs.writeFileSync(path.join(b.dir, "src/config.js"), "module.exports = { port: 5000, db: 'b' };\n");
  await commitWorktree(a, "feat: T1");
  await commitWorktree(b, "feat: T2");

  const first = await mergeWorktree(repo, a.branch, "merge: T1");
  assert.equal(first.merged, true);

  const second = await mergeWorktree(repo, b.branch, "merge: T2");
  assert.equal(second.merged, false, "the overlapping change must not merge silently");
  assert.deepEqual(second.conflicts, ["src/config.js"]);
  assert.match(second.detail, /conflicts in src\/config\.js/);

  // The failed merge left no half-merged state behind, and the winner survived.
  assert.match(read(repo, "src/config.js"), /port: 4000/);
  assert.ok(!read(repo, "src/config.js").includes("<<<<<<<"), "no conflict markers may be left in the tree");
  assert.equal(await gitTry(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD"), null, "merge must be aborted");
  assert.equal(await git(repo, "status", "--porcelain"), "", "the tree must be clean after an aborted merge");

  await pruneWorktrees(repo);
});

test("factory bookkeeping never enters a worktree commit, so it can never conflict", async () => {
  const repo = await makeRepo({ "src/app.js": "// app\n" });
  const a = await createWorktree(repo, "T1");
  const b = await createWorktree(repo, "T2");

  // Every worktree has a copy of state.json, and the orchestrator rewrites it
  // constantly. If it were committed, every parallel wave would conflict on it
  // rather than on real code.
  fs.writeFileSync(path.join(a.dir, ".factory", "state.json"), JSON.stringify({ tasks: ["a"] }));
  fs.writeFileSync(path.join(b.dir, ".factory", "state.json"), JSON.stringify({ tasks: ["b"] }));
  writeReport(a.dir, '{"done":true}');
  writeReport(b.dir, '{"done":true}');
  fs.writeFileSync(path.join(a.dir, "src/a.js"), "1\n");
  fs.writeFileSync(path.join(b.dir, "src/b.js"), "2\n");

  await commitWorktree(a, "feat: T1");
  await commitWorktree(b, "feat: T2");

  const filesInCommit = await git(repo, "show", "--name-only", "--format=", a.branch);
  assert.ok(filesInCommit.includes("src/a.js"));
  assert.ok(!filesInCommit.includes(".factory"), `bookkeeping leaked into the commit: ${filesInCommit}`);

  assert.equal((await mergeWorktree(repo, a.branch, "m1")).merged, true);
  assert.equal((await mergeWorktree(repo, b.branch, "m2")).merged, true, "state.json must not cause a conflict");

  await pruneWorktrees(repo);
});

test("an agent that changes nothing is reported rather than committed", async () => {
  const repo = await makeRepo({ "src/app.js": "// app\n" });
  const wt = await createWorktree(repo, "T1");
  assert.equal(await commitWorktree(wt, "feat: nothing"), null);

  // Bookkeeping alone is not work either.
  writeReport(wt.dir, '{"done":true}');
  assert.equal(await commitWorktree(wt, "feat: still nothing"), null);

  await pruneWorktrees(repo);
});

test("worktrees are cleaned up, branches included", async () => {
  const repo = await makeRepo({ "src/app.js": "// app\n" });
  const wt = await createWorktree(repo, "T1");
  fs.writeFileSync(path.join(wt.dir, "src/x.js"), "1\n");
  await commitWorktree(wt, "feat: T1");

  assert.ok(fs.existsSync(wt.dir));
  assert.ok((await git(repo, "worktree", "list")).includes("T1"));

  await removeWorktree(wt);
  assert.equal(fs.existsSync(wt.dir), false, "the directory should be gone");
  assert.ok(!(await git(repo, "worktree", "list")).includes("T1"), "git should no longer track it");
  assert.equal(await gitTry(repo, "rev-parse", "-q", "--verify", wt.branch), null, "the branch should be gone");
});

test("leftovers from an interrupted run are cleared before a new one starts", async () => {
  const repo = await makeRepo({ "src/app.js": "// app\n" });
  await createWorktree(repo, "T1");
  await createWorktree(repo, "T2");
  assert.equal(fs.readdirSync(worktreeRoot(repo)).length, 2);

  await pruneWorktrees(repo);
  assert.equal(fs.existsSync(worktreeRoot(repo)), false);
  const list = await git(repo, "worktree", "list");
  assert.equal(list.split("\n").length, 1, `only the main checkout should remain: ${list}`);

  // And a fresh run can reuse the same ids without colliding.
  const again = await createWorktree(repo, "T1");
  assert.ok(fs.existsSync(again.dir));
  await pruneWorktrees(repo);
});

test("recreating a worktree for the same item succeeds after a crash", async () => {
  const repo = await makeRepo({ "src/app.js": "// app\n" });
  const first = await createWorktree(repo, "T1");
  fs.writeFileSync(path.join(first.dir, "src/x.js"), "1\n");
  await commitWorktree(first, "feat: partial work");

  // No cleanup - simulating a crash mid-wave. The retry must not fail on the
  // branch or directory already existing.
  const second = await createWorktree(repo, "T1");
  assert.ok(fs.existsSync(second.dir));
  assert.equal(fs.existsSync(path.join(second.dir, "src/x.js")), false, "a retry should start from a clean base");

  await pruneWorktrees(repo);
});

test("work item ids that are not valid branch names are handled", async () => {
  const repo = await makeRepo({ "src/app.js": "// app\n" });
  for (const id of ["T1: add the API", "feature/thing", "a b c", "..", "T1~2^3"]) {
    const wt = await createWorktree(repo, id);
    assert.ok(fs.existsSync(wt.dir), `worktree for ${JSON.stringify(id)} should exist`);
    assert.match(wt.branch, /^factory\/[A-Za-z0-9._-]+$/, `unsafe branch name from ${JSON.stringify(id)}`);
    await removeWorktree(wt);
  }
  await pruneWorktrees(repo);
});

test("a worktree branches from the current tip, so it sees earlier waves", async () => {
  const repo = await makeRepo({ "src/app.js": "// app\n" });
  fs.writeFileSync(path.join(repo, "src/scaffold.js"), "// from an earlier wave\n");
  await commitAll(repo, "feat: scaffold");

  const wt = await createWorktree(repo, "T2");
  assert.ok(
    fs.existsSync(path.join(wt.dir, "src", "scaffold.js")),
    "a later agent must build on what earlier waves produced",
  );
  await pruneWorktrees(repo);
});

// ---------- wave scheduling ----------

const { selectWave } = await import("../packages/orchestrator/src/stages/development.ts");

type Task = { id: string; status: string; dependsOn: string[]; title: string; description: string };
const task = (id: string, status = "pending", dependsOn: string[] = []): Task =>
  ({ id, status, dependsOn, title: id, description: "" });

test("independent ready items are batched up to the concurrency cap", () => {
  const tasks = [task("T1"), task("T2"), task("T3")] as never[];
  assert.deepEqual(selectWave(tasks, 2, new Set()).map((t) => t.id), ["T1", "T2"]);
  assert.deepEqual(selectWave(tasks, 1, new Set()).map((t) => t.id), ["T1"]);
});

test("an item waits for its dependencies", () => {
  const tasks = [task("T1", "pending"), task("T2", "pending", ["T1"])] as never[];
  assert.deepEqual(selectWave(tasks, 4, new Set()).map((t) => t.id), ["T1"]);

  const afterT1 = [task("T1", "done"), task("T2", "pending", ["T1"])] as never[];
  assert.deepEqual(selectWave(afterT1, 4, new Set()).map((t) => t.id), ["T2"]);
});

test("an item that lost a merge is rebuilt alone, never alongside its rival", () => {
  // The termination guarantee: T2 conflicted with T1, so it is rebuilt by itself
  // in the app checkout, where there is no merge and so no conflict to repeat.
  const tasks = [task("T2"), task("T3")] as never[];
  const wave = selectWave(tasks, 2, new Set(["T2"]));
  assert.deepEqual(wave.map((t) => t.id), ["T2"], "a serial rebuild must be a wave of one");
});

test("two mutually conflicting items cannot loop forever", () => {
  // Both re-queued after conflicting with each other. Each subsequent wave must be
  // a single item, so each one gets a turn in the app checkout and finishes.
  const tasks = [task("T1"), task("T2")] as never[];
  const rebuild = new Set(["T1", "T2"]);
  const wave = selectWave(tasks, 2, rebuild);
  assert.equal(wave.length, 1, "conflicting items must not be re-batched together");
});

test("no ready work yields an empty wave, ending the loop", () => {
  assert.deepEqual(selectWave([], 2, new Set()), []);
  assert.deepEqual(selectWave([task("T1", "done")] as never[], 2, new Set()), []);
  assert.deepEqual(selectWave([task("T1", "failed")] as never[], 2, new Set()), []);
  // A pending item whose dependency failed is not ready, so the loop ends
  // rather than spinning on work that can never start.
  assert.deepEqual(selectWave([task("T1", "failed"), task("T2", "pending", ["T1"])] as never[], 2, new Set()), []);
});

test("a repo built before worktrees existed gets the ignore entry added", async () => {
  const { ensureWorktreesIgnored, WORKTREE_IGNORE } = await import("../packages/shared/src/worktree.ts");
  const repo = await makeRepo({ "src/app.js": "// app\n" });

  // The old ignore file, without the worktree root.
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n.factory/logs/\n");
  ensureWorktreesIgnored(repo);
  assert.match(read(repo, ".gitignore"), /\.factory\/worktrees\//);
  assert.match(read(repo, ".gitignore"), /node_modules\//, "existing entries must be preserved");

  // Idempotent: running it again must not duplicate the line.
  ensureWorktreesIgnored(repo);
  const lines = read(repo, ".gitignore").split("\n").filter((l) => l.trim() === WORKTREE_IGNORE);
  assert.equal(lines.length, 1);

  // And the effect that matters: worktrees stay out of the main tree's commits.
  await commitAll(repo, "chore: ignore worktrees");
  await createWorktree(repo, "T1");
  await commitAll(repo, "chore: after a worktree exists");
  assert.ok(!(await git(repo, "ls-files")).includes("worktrees"), "worktrees must never be tracked");
  await pruneWorktrees(repo);
});
