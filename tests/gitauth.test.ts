import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const {
  GIT_TOKEN_ENV,
  GIT_USERNAME,
  ensureAskpass,
  gitAuthEnv,
  hasEmbeddedCredential,
  remoteUrl,
} = await import("../packages/shared/src/gitauth.ts");
const { renderChecks, PreflightError } = await import("../packages/orchestrator/src/preflight.ts");

const TOKEN = "ghp_testtokentesttokentesttoken1234";

function withToken<T>(fn: () => T): T {
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = TOKEN;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
}

test("a remote URL carries the username but never the token", () => {
  withToken(() => {
    const url = remoteUrl("https://github.com/me/app.git");
    assert.equal(url, `https://${GIT_USERNAME}@github.com/me/app.git`);
    assert.ok(!url.includes(TOKEN), "the token must never reach .git/config");
  });
});

test("an already-tokenised URL is rewritten rather than doubled up", () => {
  withToken(() => {
    const dirty = `https://x-access-token:${TOKEN}@github.com/me/app.git`;
    const clean = remoteUrl(dirty);
    assert.equal(clean, `https://${GIT_USERNAME}@github.com/me/app.git`);
    assert.ok(!clean.includes(TOKEN));
  });
});

test("without a token the URL is left exactly as it was", () => {
  const prev = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    assert.equal(remoteUrl("https://github.com/me/app.git"), "https://github.com/me/app.git");
  } finally {
    if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
  }
});

test("embedded credentials are detected, so old repos can be scrubbed", () => {
  assert.equal(hasEmbeddedCredential(`https://x-access-token:${TOKEN}@github.com/me/app.git`), true);
  assert.equal(hasEmbeddedCredential("https://user:pass@github.com/me/app.git"), true);
  assert.equal(hasEmbeddedCredential("https://x-access-token@github.com/me/app.git"), false);
  assert.equal(hasEmbeddedCredential("https://github.com/me/app.git"), false);
  assert.equal(hasEmbeddedCredential("git@github.com:me/app.git"), false);
});

test("the askpass helper on disk contains no secret - only a variable reference", () => {
  withToken(() => {
    const file = ensureAskpass();
    const body = fs.readFileSync(file, "utf8");
    assert.ok(!body.includes(TOKEN), "the helper script must not contain the token");
    assert.ok(body.includes(GIT_TOKEN_ENV), "the helper must read the token from the environment");
  });
});

test("the token travels in the git child environment, nowhere else", () => {
  withToken(() => {
    const env = gitAuthEnv();
    assert.equal(env[GIT_TOKEN_ENV], TOKEN);
    assert.ok(env.GIT_ASKPASS, "askpass must be pointed at the helper");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0", "an unattended run must never block on a prompt");
  });
});

test("no token means no auth environment at all", () => {
  const prev = process.env.GITHUB_TOKEN;
  const prevGh = process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  try {
    assert.deepEqual(gitAuthEnv(), {});
  } finally {
    if (prev !== undefined) process.env.GITHUB_TOKEN = prev;
    if (prevGh !== undefined) process.env.GH_TOKEN = prevGh;
  }
});

// ---------- preflight ----------

test("a preflight failure is permanent, so the supervisor will not retry it", () => {
  const err = new PreflightError([
    { name: "agent auth", status: "fail", detail: "not logged in", fix: "run /login" },
  ]);
  assert.equal(err.permanent, true);
  assert.match(err.message, /agent auth/);
  assert.ok(err instanceof Error);
});

test("check output shows the fix for anything that is not passing", () => {
  const out = renderChecks([
    { name: "node", status: "pass", detail: "Node 22" },
    { name: "agent auth", status: "fail", detail: "not logged in", fix: "run claude /login" },
    { name: "github", status: "warn", detail: "no token", fix: "set GITHUB_TOKEN" },
  ]);
  assert.match(out, /FAIL.*agent auth/);
  assert.match(out, /run claude \/login/);
  assert.match(out, /set GITHUB_TOKEN/);
  // A passing check needs no advice attached to it.
  assert.ok(!/Node 22\n\s+->/.test(out));
});
