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

// ---------- fingerprinting across languages ----------
// Dedup is what stops one bug becoming two healing agents. It has to work for
// whatever the app was written in, not just for V8 stack traces.

const PY_TRACE = [
  "Traceback (most recent call last):",
  '  File "/app/routes/todos.py", line 42, in get_todo',
  "    return items[index]",
  '  File "/usr/lib/python3.12/site-packages/flask/app.py", line 900, in dispatch',
  "    rv = self.handle(req)",
  "IndexError: list index out of range",
].join("\n");

const GO_TRACE = [
  "panic: runtime error: index out of range [3] with length 2",
  "goroutine 7 [running]:",
  "main.getTodo(0xc000188000)",
  "\t/app/handlers/todos.go:58 +0x1d",
  "net/http.HandlerFunc.ServeHTTP(0x0)",
  "\t/usr/local/go/src/net/http/server.go:2136 +0x2f",
].join("\n");

const JVM_TRACE = [
  "java.lang.NullPointerException: Cannot invoke String.length()",
  "\tat com.example.todo.TodoService.rename(TodoService.java:81)",
  "\tat com.example.todo.TodoController.patch(TodoController.java:44)",
  "\tat org.springframework.web.servlet.DispatcherServlet.doDispatch(DispatcherServlet.java:1071)",
].join("\n");

const RUBY_TRACE = [
  "NoMethodError: undefined method `title' for nil:NilClass",
  "\tfrom /app/services/todo_service.rb:27:in `rename'",
  "\tfrom /app/controllers/todos_controller.rb:15:in `update'",
].join("\n");

test("a python traceback yields app frames and skips site-packages", () => {
  const frames = topFrames(PY_TRACE);
  assert.ok(frames.length > 0, "expected python frames");
  assert.equal(frames[0], "get_todo@routes/todos.py");
  assert.ok(!frames.some((f) => f.includes("flask")), `site-packages leaked in: ${frames.join(", ")}`);
});

test("a go panic yields app frames and skips the go runtime", () => {
  const frames = topFrames(GO_TRACE);
  assert.ok(frames.some((f) => f.includes("todos.go")), frames.join(", "));
  assert.ok(!frames.some((f) => f.includes("server.go")), `go runtime leaked in: ${frames.join(", ")}`);
});

test("a jvm trace yields app frames and skips the framework", () => {
  const frames = topFrames(JVM_TRACE);
  assert.ok(frames.some((f) => f.includes("TodoService.java")), frames.join(", "));
  assert.ok(!frames.some((f) => f.includes("DispatcherServlet")), `spring leaked in: ${frames.join(", ")}`);
});

test("a ruby trace yields app frames", () => {
  const frames = topFrames(RUBY_TRACE);
  assert.ok(frames.some((f) => f.includes("todo_service.rb")), frames.join(", "));
});

test("the same non-JS error twice is still one incident", () => {
  const event = { ...makeEvent("list index out of range", PY_TRACE), type: "IndexError" };
  const first = recordEvent(fingerprint(event), event);
  const second = recordEvent(fingerprint(event), event);
  assert.equal(second.id, first.id, "a python error must deduplicate like a JS one");
  assert.equal(second.count, 2);
});

test("different bugs in the same language stay separate incidents", () => {
  const a = { ...makeEvent("index out of range", GO_TRACE), type: "panic" };
  const other = GO_TRACE.replace("todos.go:58", "users.go:12").replace("main.getTodo", "main.getUser");
  const b = { ...makeEvent("index out of range", other), type: "panic" };
  assert.notEqual(fingerprint(a), fingerprint(b), "different frames must fingerprint differently");
});

test("a fix that moves code down a few lines does not look like a new bug", () => {
  const before = { ...makeEvent("boom", PY_TRACE), type: "IndexError" };
  const after = { ...makeEvent("boom", PY_TRACE.replace("line 42", "line 57")), type: "IndexError" };
  assert.equal(fingerprint(before), fingerprint(after), "line numbers must not be part of the fingerprint");
});
