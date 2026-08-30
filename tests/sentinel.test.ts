import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.SENTINEL_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sentinel-test-")), "test.db");

const { fingerprint, normalizeMessage, topFrames } = await import("../packages/sentinel/src/fingerprint.ts");
const { recordEvent, claimIncident, getIncident, setIncident } = await import("../packages/sentinel/src/db.ts");

const makeEvent = (msg: string, stack?: string) => ({
  appId: "app-1",
  type: "TypeError",
  message: msg,
  stack,
  context: {},
  timestamp: new Date().toISOString(),
});

test("normalizeMessage templates volatile parts", () => {
  assert.equal(
    normalizeMessage("Cannot read id 12345 of 'order-abc'"),
    "Cannot read id <n> of <str>",
  );
});

test("topFrames skips node internals and node_modules, drops line numbers", () => {
  const stack = [
    "TypeError: boom",
    String.raw`    at getOrder (C:\apps\shop\routes\orders.js:42:11)`,
    String.raw`    at Layer.handle (C:\apps\shop\node_modules\express\lib\router\layer.js:95:5)`,
    "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
  ].join("\n");
  assert.deepEqual(topFrames(stack), ["getOrder@routes/orders.js"]);
});

test("same error twice -> one incident, count 2", () => {
  const stack = "TypeError: x\n    at f (C:/a/b/svc.js:10:5)";
  const e1 = makeEvent("Cannot read properties of undefined (reading 'name') at row 101", stack);
  const e2 = makeEvent("Cannot read properties of undefined (reading 'name') at row 999", "TypeError: x\n    at f (C:/a/b/svc.js:12:9)");
  const fp1 = fingerprint(e1);
  const fp2 = fingerprint(e2);
  assert.equal(fp1, fp2, "volatile row number and moved line must not change the fingerprint");
  const i1 = recordEvent(fp1, e1);
  const i2 = recordEvent(fp2, e2);
  assert.equal(i1.id, i2.id);
  assert.equal(i2.count, 2);
  assert.equal(i2.status, "open");
});

test("claim is exclusive: only one winner, no duplicate healing agents", () => {
  const e = makeEvent("boom unique-claim-test", "Error: y\n    at g (C:/a/b/claim.js:1:1)");
  const inc = recordEvent(fingerprint(e), e);
  const results = [claimIncident(inc.id), claimIncident(inc.id), claimIncident(inc.id)];
  assert.deepEqual(results, [true, false, false]);
  assert.equal(getIncident(inc.id)!.status, "healing");
});

test("recurrence after resolved reopens the same incident with prior-fix context", () => {
  const e = makeEvent("boom reopen-test", "Error: z\n    at h (C:/a/b/reopen.js:1:1)");
  const fp = fingerprint(e);
  const inc = recordEvent(fp, e);
  setIncident(inc.id, { status: "resolved", pr_url: "https://github.com/x/y/pull/1" });
  const again = recordEvent(fp, e);
  assert.equal(again.id, inc.id);
  assert.equal(again.status, "open");
  assert.match(again.lastNote ?? "", /recurred/);
  assert.match(again.lastNote ?? "", /pull\/1/);
});

test("new events on an incident already pr_open only bump the count", () => {
  const e = makeEvent("boom propen-test", "Error: w\n    at k (C:/a/b/pr.js:1:1)");
  const fp = fingerprint(e);
  const inc = recordEvent(fp, e);
  setIncident(inc.id, { status: "pr_open" });
  const again = recordEvent(fp, e);
  assert.equal(again.status, "pr_open");
  assert.equal(again.count, 2);
});

test("app registration round-trips (deploy's offline fallback path)", async () => {
  const { upsertApp, getApp } = await import("../packages/sentinel/src/db.ts");
  upsertApp({ appId: "app-x", name: "shop", dir: "C:/ws/shop", repoFull: "me/shop", port: 5100, startCmd: "npm start" });
  assert.equal(getApp("app-x")!.repoFull, "me/shop");
  // re-deploy on a new port must update, not duplicate
  upsertApp({ appId: "app-x", name: "shop", dir: "C:/ws/shop", repoFull: null, port: 5101, startCmd: "npm start" });
  assert.equal(getApp("app-x")!.port, 5101);
  assert.equal(getApp("app-x")!.repoFull, null);
});
