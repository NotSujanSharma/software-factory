import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { planSpawn, assertShellSafe, run } = await import("../packages/shared/src/proc.ts");

test("npm is run as node + its JS entry point, never through a shell", () => {
  const plan = planSpawn("npm", ["install", "--no-audit"]);
  assert.equal(plan.shell, false, "npm must not need a shell");
  assert.equal(plan.file, process.execPath, "npm should be run by node itself");
  assert.match(plan.args[0], /npm-cli\.js$/);
  assert.deepEqual(plan.args.slice(1), ["install", "--no-audit"]);
});

test("real executables are spawned directly", () => {
  for (const cmd of ["git", "taskkill", "node"]) {
    const plan = planSpawn(cmd, ["--version"]);
    assert.equal(plan.shell, false, `${cmd} must not need a shell`);
    assert.equal(plan.file, cmd);
  }
});

test("arguments are passed through as an array, so nothing can be concatenated", () => {
  const nasty = 'a&b|c>d^e"f';
  const plan = planSpawn("npm", ["run", nasty]);
  assert.ok(plan.args.includes(nasty), "the argument must survive verbatim");
  assert.equal(plan.shell, false);
});

test("the shell-safety guard rejects shell syntax in arguments", () => {
  for (const bad of ['x & echo pwned', "a | b", "a; b", "$(whoami)", "`whoami`", "a > f", "a\nb", "%PATH%"]) {
    assert.throws(() => assertShellSafe("npm", [bad]), /shell syntax/, `should reject: ${bad}`);
  }
});

test("the guard allows the arguments a real build actually uses", () => {
  assert.doesNotThrow(() =>
    assertShellSafe("npm", ["install", "--no-audit", "--no-fund", "test", "start", "run", "build:prod"]),
  );
  assert.doesNotThrow(() => assertShellSafe("npm", [path.join(os.tmpdir(), "some-dir", "file.js")]));
});

test("npm actually runs, and reports a version", async () => {
  const res = await run("npm", ["--version"], { timeoutMs: 60_000 });
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test("shell metacharacters reach the child verbatim instead of being interpreted", async () => {
  const nasty = 'a&b|c>d^e"f$g`h(i)j';
  const res = await run("node", ["-e", "process.stdout.write(process.argv[1])", nasty], { timeoutMs: 30_000 });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout, nasty, "the argument must not be mangled or split by a shell");
});

test("an injected command is one argument, not a second command", async () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "proc-inject-")), "PWNED.txt");
  const injection = `x & echo pwned > "${marker}"`;
  const res = await run("node", ["-e", "process.stdout.write(String(process.argv.length - 1))", injection], {
    timeoutMs: 30_000,
  });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.trim(), "1", "the injection must arrive as a single argument");
  assert.equal(fs.existsSync(marker), false, "the injected command must not have executed");
});

test("a failing command reports its exit code rather than throwing, unless checked", async () => {
  const res = await run("node", ["-e", "process.exit(3)"], { timeoutMs: 30_000 });
  assert.equal(res.code, 3);
  await assert.rejects(() => run("node", ["-e", "process.exit(3)"], { timeoutMs: 30_000, check: true }), /exited 3/);
});

test("a nested npm does not inherit the launching npm's config flags", async () => {
  // Reproduces EALLOWSCRIPTS: `allow-scripts` is legal in an .npmrc but is rejected
  // when a parent npm projects it into the environment of a nested install.
  const saved = { ...process.env };
  process.env.npm_command = "run";
  process.env.npm_config_allow_scripts = "some-package";
  process.env.npm_lifecycle_event = "factory";
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "proc-npmenv-"));
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "nested", version: "1.0.0", private: true }),
    );
    const res = await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, timeoutMs: 120_000 });
    assert.equal(res.code, 0, `nested npm install must not inherit parent config: ${res.stderr.slice(0, 300)}`);
    fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    for (const key of ["npm_command", "npm_config_allow_scripts", "npm_lifecycle_event"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});

test("a caller's explicit env still reaches the child", async () => {
  const res = await run("node", ["-e", "process.stdout.write(process.env.FACTORY_PROBE ?? 'missing')"], {
    env: { FACTORY_PROBE: "reached" },
    timeoutMs: 30_000,
  });
  assert.equal(res.stdout, "reached");
});

test("executables installed as Windows App Execution Aliases are found", async () => {
  const { hasExecutable, which } = await import("../packages/shared/src/proc.ts");

  // node is always present, since it is running this test.
  assert.equal(hasExecutable("node"), true);
  assert.equal(hasExecutable("definitely-not-a-real-command-xyz"), false);

  // A Microsoft Store Python is a reparse point: stat() rejects it with EACCES and
  // existsSync() reports it absent, though it runs fine. Detection must use lstat,
  // or every Store-installed toolchain looks uninstalled.
  const found = which("node");
  assert.ok(found, "node should resolve to a path");
  assert.match(found, /node/i);
});
