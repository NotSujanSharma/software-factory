import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

const { probeHealth, verifyHealthy, isReachable } = await import("../packages/shared/src/http.ts");
import type { HealthConfig } from "../packages/shared/src/types.ts";

const cfg = (over: Partial<HealthConfig> = {}): HealthConfig => ({
  paths: ["/health", "/healthz", "/api/health", "/"],
  unhealthyStatusFrom: 500,
  timeoutMs: 6000,
  stableChecks: 2,
  ...over,
});

const servers: http.Server[] = [];

/** Start a server whose responses are decided by `handler`; returns its base URL. */
async function serve(handler: (url: string) => { status: number; body?: string }): Promise<string> {
  const server = http.createServer((req, res) => {
    const { status, body } = handler(req.url ?? "/");
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body ?? JSON.stringify({ status }));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

after(() => {
  for (const s of servers) s.close();
});

test("a working health endpoint is healthy", async () => {
  const url = await serve((p) => (p === "/health" ? { status: 200 } : { status: 404 }));
  const r = await probeHealth(url, cfg());
  assert.equal(r.healthy, true);
  assert.equal(r.path, "/health");
  assert.equal(r.status, 200);
});

test("an app that 500s on every route is UNHEALTHY - the bug this check exists for", async () => {
  const url = await serve(() => ({ status: 500 }));
  const r = await probeHealth(url, cfg());
  assert.equal(r.healthy, false, "a 500 on every route must not read as healthy");
  assert.equal(r.status, 500);
  assert.match(r.detail, /500/);
});

test("a 503 from the health endpoint is unhealthy", async () => {
  const url = await serve((p) => (p === "/health" ? { status: 503 } : { status: 200 }));
  const r = await probeHealth(url, cfg());
  assert.equal(r.healthy, false);
  assert.equal(r.path, "/health");
});

test("a 404 moves on to the next path instead of deciding", async () => {
  // No /health, but the root works - normal for an app that never added one.
  const url = await serve((p) => (p === "/" ? { status: 200 } : { status: 404 }));
  const r = await probeHealth(url, cfg());
  assert.equal(r.healthy, true);
  assert.equal(r.path, "/");
});

test("an API-only app that 404s everywhere still counts as answering", async () => {
  const url = await serve(() => ({ status: 404 }));
  const r = await probeHealth(url, cfg());
  assert.equal(r.healthy, true);
  assert.match(r.detail, /no health endpoint/);
});

test("a 4xx that is not 404 is healthy - the server is answering", async () => {
  const url = await serve(() => ({ status: 401 }));
  const r = await probeHealth(url, cfg());
  assert.equal(r.healthy, true);
  assert.equal(r.status, 401);
});

test("nothing listening is unhealthy", async () => {
  const r = await probeHealth("http://127.0.0.1:1", cfg());
  assert.equal(r.healthy, false);
});

test("unhealthyStatusFrom is configurable", async () => {
  const url = await serve(() => ({ status: 418 }));
  assert.equal((await probeHealth(url, cfg())).healthy, true);
  assert.equal((await probeHealth(url, cfg({ unhealthyStatusFrom: 400 }))).healthy, false);
});

test("verifyHealthy requires consecutive passes", async () => {
  const url = await serve((p) => (p === "/health" ? { status: 200 } : { status: 404 }));
  const r = await verifyHealthy(url, cfg({ stableChecks: 3 }));
  assert.equal(r.healthy, true);
});

test("an app that flaps never accumulates a streak, so it is not healthy", async () => {
  let n = 0;
  // Alternates healthy/broken: a single-probe check would pass this half the time.
  const url = await serve(() => ({ status: ++n % 2 === 0 ? 500 : 200 }));
  const r = await verifyHealthy(url, cfg({ stableChecks: 3, timeoutMs: 4000 }));
  assert.equal(r.healthy, false, "flapping must not read as healthy");
});

test("verifyHealthy reports how far it got when it times out", async () => {
  const r = await verifyHealthy("http://127.0.0.1:1", cfg({ stableChecks: 2, timeoutMs: 2500 }));
  assert.equal(r.healthy, false);
  assert.ok(r.detail.length > 0);
});

test("isReachable only proves something is listening, not that it works", async () => {
  const url = await serve(() => ({ status: 500 }));
  // Deliberate: this is why it must not be used to decide a rollback.
  assert.equal(await isReachable(url + "/", 2000), true);
  assert.equal((await probeHealth(url, cfg())).healthy, false);
});
