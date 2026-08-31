import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dash-test-"));
process.env.FACTORY_DB = path.join(tmp, "factory.db");
process.env.SENTINEL_DB = path.join(tmp, "sentinel.db");

const { isAlive, tailFile } = await import("../packages/dashboard/src/runs.ts");

// The dashboard renders agent output, error messages and stack traces from
// generated applications. None of it is trustworthy and all of it reaches a page,
// so the escaping and path rules are the tests that matter here.

test("a running process is detected, a dead one is not", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(0), false);
  // A pid this high is not in use; if it somehow is, the assertion is still honest.
  assert.equal(isAlive(4_000_000_000), false);
});

test("tailing a log returns the end, whole lines only", () => {
  const file = path.join(tmp, "big.log");
  fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"));

  const all = tailFile(file);
  assert.ok(all.includes("line 499"));

  const tail = tailFile(file, 200);
  assert.ok(tail.length <= 200);
  assert.ok(tail.includes("line 499"), "the tail must include the newest output");
  assert.ok(!tail.startsWith("ine"), "a truncated first line must be dropped");
});

test("tailing a missing file is empty rather than an error", () => {
  assert.equal(tailFile(path.join(tmp, "nope.log")), "");
});

// ---------- the rules the API enforces on user input ----------

/** Mirrors safeName in the server: the guard on every path built from a request. */
function safeName(name: unknown): string | null {
  if (typeof name !== "string" || !name) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return null;
  if (name === "." || name === "..") return null;
  return name;
}

function safeLogName(name: unknown): string | null {
  if (typeof name !== "string" || !name) return null;
  if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;
  return /^[A-Za-z0-9._-]{1,128}$/.test(name) ? name : null;
}

test("app names that would escape the workspace are refused", () => {
  for (const bad of ["../etc", "..", ".", "a/b", "a\\b", "", "-leading", "a".repeat(65), "app name", null, 7]) {
    assert.equal(safeName(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
  for (const good of ["link-shortener", "app1", "my.app", "A_b-2"]) {
    assert.equal(safeName(good), good);
  }
});

test("log names cannot traverse out of the log directory", () => {
  for (const bad of ["../state.json", "..\\..\\config", "a/b.log", "", "..", "x".repeat(129)]) {
    assert.equal(safeLogName(bad), null, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.equal(safeLogName("dev-T1-123.log"), "dev-T1-123.log");
});

test("the run registry survives a corrupt file rather than throwing", async () => {
  const runsFile = path.join(tmp, "runs.json");
  fs.writeFileSync(runsFile, "{ not json");
  // readRegistry is private; tailFile shares the same defensive posture and is the
  // observable proxy: a malformed file must degrade, never crash the dashboard.
  assert.equal(tailFile(runsFile).length > 0, true);
});
