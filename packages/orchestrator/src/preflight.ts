/**
 * Preflight checks.
 *
 * A build spends real money and real time before it ever reaches the deploy
 * stage. This project has already lost a full unattended run to an expired login
 * that was not discovered until stage eight - and then retried five times,
 * because nothing distinguished "not logged in" from "did not converge".
 *
 * Everything checkable in a second is checked in the first second, and a failure
 * is marked `permanent` so the supervisor parks instead of paying to rediscover it.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  budgetReport,
  checkBudget,
  formatUsd,
  githubToken,
  gitTry,
  hasExecutable,
  hasEmbeddedCredential,
  makeLogger,
  remoteOf,
  run,
  workspaceRoot,
  type FactoryConfig,
} from "@factory/shared";
import { isLimitMessage } from "@factory/agents";
import { describeCommand, loadStack, missingTools } from "@factory/stacks";

const log = makeLogger("preflight");

export type CheckStatus = "pass" | "warn" | "fail";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** What the user should do about it. */
  fix?: string;
}

/** A failure nothing downstream can retry its way out of. */
export class PreflightError extends Error {
  readonly permanent = true;
  readonly failures: CheckResult[];
  constructor(failures: CheckResult[]) {
    super(`preflight failed: ${failures.map((f) => f.name).join(", ")}`);
    this.name = "PreflightError";
    this.failures = failures;
  }
}

const pass = (name: string, detail: string): CheckResult => ({ name, status: "pass", detail });
const warn = (name: string, detail: string, fix?: string): CheckResult => ({ name, status: "warn", detail, fix });
const fail = (name: string, detail: string, fix?: string): CheckResult => ({ name, status: "fail", detail, fix });

function checkNode(): CheckResult {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    return fail("node", `Node ${process.versions.node}; this framework needs >= 22`, "Install Node 22 or newer.");
  }
  return pass("node", `Node ${process.versions.node}`);
}

async function checkCommand(name: string, args: string[]): Promise<CheckResult> {
  try {
    const res = await run(name, args, { timeoutMs: 15_000 });
    if (res.code !== 0) return fail(name, `\`${name} ${args.join(" ")}\` exited ${res.code}`, `Install ${name}.`);
    return pass(name, res.stdout.trim().split("\n")[0] || "available");
  } catch {
    return fail(name, `\`${name}\` is not on PATH`, `Install ${name} and reopen your shell.`);
  }
}

function portFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

async function checkSentinelPort(cfg: FactoryConfig): Promise<CheckResult> {
  const { port } = cfg.sentinel;
  if (await portFree(port, cfg.sentinel.host)) return pass("sentinel port", `:${port} is free`);
  // Something is there. If it answers as our sentinel, that is fine - we join it.
  try {
    const res = await fetch(`http://127.0.0.1:${port}/incidents`, { signal: AbortSignal.timeout(2000) });
    if (res.ok || res.status === 401) return pass("sentinel port", `:${port} already serving a sentinel`);
  } catch {
    /* not ours */
  }
  return fail(
    "sentinel port",
    `:${port} is occupied by something that is not a sentinel`,
    `Free the port, or change sentinel.port in factory.config.json.`,
  );
}

async function checkAppPorts(cfg: FactoryConfig): Promise<CheckResult> {
  const base = cfg.deploy.basePort;
  for (let p = base; p < base + 20; p++) {
    if (await portFree(p)) return pass("app ports", `a free port is available from :${base}`);
  }
  return warn("app ports", `:${base}-${base + 19} are all occupied`, "Change deploy.basePort.");
}

function checkWorkspace(cfg: FactoryConfig): CheckResult {
  const dir = workspaceRoot(cfg);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, ".factory-write-probe");
    fs.writeFileSync(probe, "ok");
    fs.rmSync(probe, { force: true });
    return pass("workspace", `${dir} is writable`);
  } catch (err) {
    return fail("workspace", `${dir} is not writable: ${err}`, "Check permissions or set workspaceDir.");
  }
}

async function checkDisk(cfg: FactoryConfig): Promise<CheckResult> {
  try {
    const st = await fs.promises.statfs(workspaceRoot(cfg));
    const freeGb = (Number(st.bsize) * Number(st.bavail)) / 1024 ** 3;
    if (freeGb < 1) return fail("disk", `${freeGb.toFixed(1)} GB free`, "Free up space; builds install node_modules.");
    if (freeGb < 5) return warn("disk", `${freeGb.toFixed(1)} GB free`, "Each built app installs its own node_modules.");
    return pass("disk", `${freeGb.toFixed(1)} GB free`);
  } catch {
    return pass("disk", "not measurable on this platform");
  }
}

/**
 * Can npm actually install into a fresh project?
 *
 * Every deploy and every heal runs `npm install`, so a broken npm environment is a
 * hard blocker - but it only shows up deep inside a stage that has already cost
 * money. A trivial install in a temp directory costs about a second and catches a
 * bad registry, a dead proxy, a corrupted cache, or config that a nested npm
 * refuses (an `allow-scripts` entry in `.npmrc` used to fail exactly this way).
 */
async function checkNpmInstall(): Promise<CheckResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-npm-probe-"));
  try {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "factory-npm-probe", version: "1.0.0", private: true }),
    );
    const res = await run("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, timeoutMs: 120_000 });
    if (res.code !== 0) {
      const reason = (res.stderr || res.stdout).trim().split("\n").slice(0, 2).join(" ").slice(0, 200);
      return fail("npm install", reason || `exited ${res.code}`, "Every deploy and heal needs this to work.");
    }
    return pass("npm install", "works in a clean project");
  } catch (err) {
    return fail("npm install", String(err).slice(0, 200));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function checkGitIdentity(): Promise<CheckResult> {
  const name = await gitTry(process.cwd(), "config", "user.name");
  const email = await gitTry(process.cwd(), "config", "user.email");
  if (!name || !email) {
    // Each generated repo gets a local identity anyway, so this is not fatal.
    return warn("git identity", "no global user.name/user.email", "git config --global user.name/user.email");
  }
  return pass("git identity", `${name} <${email}>`);
}

async function checkGithub(cfg: FactoryConfig): Promise<CheckResult[]> {
  if (!cfg.github.enabled) return [pass("github", "disabled in config; running local-only")];
  const token = githubToken();
  if (!token) {
    return [
      warn(
        "github",
        "GITHUB_TOKEN is not set",
        "Everything still works locally; healing pushes branches instead of opening PRs.",
      ),
    ];
  }
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) {
      return [fail("github", "GITHUB_TOKEN is rejected (401)", "Issue a new token with `repo` scope.")];
    }
    if (!res.ok) return [warn("github", `GitHub returned ${res.status}`)];
    const user = (await res.json()) as { login: string };

    // Classic tokens advertise scopes; fine-grained ones do not, so absence is not an error.
    const scopes = res.headers.get("x-oauth-scopes");
    const results = [pass("github", `authenticated as ${user.login}`)];
    if (scopes !== null && scopes !== "" && !/\brepo\b/.test(scopes)) {
      results.push(fail("github scopes", `token lacks \`repo\` scope (has: ${scopes})`, "Reissue with `repo`."));
    }
    return results;
  } catch (err) {
    return [warn("github", `could not reach GitHub: ${err}`, "Check your network; the build will run local-only.")];
  }
}

/** Any repo still carrying a token in `.git/config` from an older version. */
async function checkLeakedCredentials(cfg: FactoryConfig): Promise<CheckResult> {
  const ws = workspaceRoot(cfg);
  if (!fs.existsSync(ws)) return pass("credential hygiene", "no apps yet");
  const leaked: string[] = [];
  for (const entry of fs.readdirSync(ws)) {
    const dir = path.join(ws, entry);
    if (!fs.existsSync(path.join(dir, ".git"))) continue;
    const url = await remoteOf(dir);
    if (url && hasEmbeddedCredential(url)) leaked.push(entry);
  }
  if (leaked.length) {
    return fail(
      "credential hygiene",
      `a token is stored in .git/config for: ${leaked.join(", ")}`,
      "Run `factory doctor --fix` to scrub them, then rotate that token - it has been on disk.",
    );
  }
  return pass("credential hygiene", "no tokens stored in any repo config");
}

function checkConfig(cfg: FactoryConfig): CheckResult[] {
  const out: CheckResult[] = [];
  if (cfg.provider !== "claude" && cfg.provider !== "codex") {
    out.push(fail("config", `unknown agent provider: ${String(cfg.provider)}`, "Use provider `claude` or `codex`."));
  }
  if (!cfg.model?.trim()) out.push(fail("config", "model is empty", "Set `model` in factory.config.json."));

  const b = cfg.budget;
  if (b.enabled) {
    if (b.perStageUsd > 0 && b.perAppUsd > 0 && b.perStageUsd > b.perAppUsd) {
      out.push(warn("config", `perStageUsd (${b.perStageUsd}) exceeds perAppUsd (${b.perAppUsd})`, "The app ceiling wins."));
    }
  }
  if (!cfg.sandbox.enabled) {
    out.push(warn("config", "sandbox is disabled", "Agents can run any command, including ones that kill the factory."));
  }
  if (!cfg.sentinel.requireKey) {
    out.push(warn("config", "sentinel.requireKey is off", "Anything that can reach the port can trigger healing."));
  }
  if (out.length === 0) out.push(pass("config", "coherent"));
  return out;
}

function checkBudgetHeadroom(cfg: FactoryConfig): CheckResult {
  if (!cfg.budget.enabled) return warn("budget", "budgets are disabled", "Spend is unbounded.");
  const decision = checkBudget(cfg);
  if (decision.allowed) return pass("budget", budgetReport(cfg)[0]?.trim() ?? "headroom available");
  return decision.recoverable
    ? warn("budget", decision.message, "The run will sleep until the window frees up.")
    : fail("budget", decision.message, `Raise the ceiling in factory.config.json, or clear the ledger.`);
}

/**
 * The only honest way to know the agents can run: ask one to say a word.
 *
 * Costs a fraction of a cent and a couple of seconds, against a build that costs
 * dollars and hours before it would otherwise find out.
 */
export async function probeAgentAuth(cfg: FactoryConfig): Promise<CheckResult> {
  if (cfg.provider === "codex") {
    if (!hasExecutable("codex")) {
      return fail("agent auth", "Codex CLI is not installed or not on PATH", "Install Codex CLI and authenticate it, or set provider to claude.");
    }
    try {
      const result = await run(
        "codex",
        ["exec", "--json", "--ephemeral", "--sandbox", "read-only", "-m", cfg.model, "Reply with exactly: ok"],
        { timeoutMs: 30_000 },
      );
      const text = `${result.stdout}\n${result.stderr}`;
      if (result.code !== 0 || /not logged in|login|unauthorized|invalid.*api.?key|authentication/i.test(text)) {
        return fail("agent auth", `Codex probe failed: ${text.trim().slice(0, 160)}`, "Install/authenticate Codex, or set provider to claude.");
      }
      return pass("agent auth", `Codex agents can run on ${cfg.model}`);
    } catch (err) {
      return fail("agent auth", String(err).slice(0, 200), "Install/authenticate Codex, or set provider to claude.");
    }
  }

  try {
    let text = "";
    let isError = false;
    const q = query({
      prompt: "Reply with exactly: ok",
      options: {
        model: cfg.model,
        maxTurns: 1,
        allowedTools: [],
        settingSources: [],
        permissionMode: "bypassPermissions",
      },
    });
    for await (const message of q) {
      if (message.type === "result") {
        isError = message.is_error;
        text = message.subtype === "success" ? message.result : `[${message.subtype}]`;
      }
    }

    if (isLimitMessage(text)) {
      return warn("agent auth", "authenticated, but a usage limit is active", "Runs will sleep until it resets.");
    }
    if (isError || /not logged in|\/login|unauthorized|invalid.*api.?key|authentication/i.test(text)) {
      return fail("agent auth", `agent run failed: ${text.slice(0, 160)}`, "Run `claude` and `/login`, or set ANTHROPIC_API_KEY.");
    }
    return pass("agent auth", `agents can run on ${cfg.model}`);
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err);
    if (isLimitMessage(msg)) {
      return warn("agent auth", "authenticated, but a usage limit is active", "Runs will sleep until it resets.");
    }
    return fail("agent auth", msg.slice(0, 200), "Run `claude` and `/login`, or set ANTHROPIC_API_KEY.");
  }
}

/**
 * Does the machine have what this app is written in?
 *
 * Only meaningful once an app exists and has declared a stack; a fresh build has
 * not chosen one yet, and the architect is shown what is installed before it does.
 */
function checkAppStack(appDir?: string): CheckResult[] {
  if (!appDir) return [];
  const stack = loadStack(appDir);
  if (!stack) return [];

  const missing = missingTools(stack);
  if (missing.length) {
    return [
      fail(
        "app toolchain",
        `${stack.label} needs ${missing.join(", ")}, which are not installed`,
        `Install them, or the app cannot be built, tested, run or healed.`,
      ),
    ];
  }
  return [pass("app toolchain", `${stack.label}; start: ${describeCommand(stack.commands.start)}`)];
}

export interface PreflightOptions {
  /** Spend a fraction of a cent proving the agents can actually authenticate. */
  probe?: boolean;
  /** Rewrite any remote still holding a token. */
  fix?: boolean;
  /** An existing app whose declared stack should also be checked. */
  appDir?: string;
}

export async function runChecks(cfg: FactoryConfig, opts: PreflightOptions = {}): Promise<CheckResult[]> {
  if (opts.fix) await fixLeakedCredentials(cfg);

  const results: CheckResult[] = [
    checkNode(),
    await checkCommand("git", ["--version"]),
    await checkCommand("npm", ["--version"]),
    await checkNpmInstall(),
    checkWorkspace(cfg),
    await checkDisk(cfg),
    await checkGitIdentity(),
    ...(await checkGithub(cfg)),
    await checkLeakedCredentials(cfg),
    await checkSentinelPort(cfg),
    await checkAppPorts(cfg),
    ...checkConfig(cfg),
    ...checkAppStack(opts.appDir),
    checkBudgetHeadroom(cfg),
  ];
  if (opts.probe !== false) results.push(await probeAgentAuth(cfg));
  return results;
}

/** Scrub tokens out of every generated repo's config. */
export async function fixLeakedCredentials(cfg: FactoryConfig): Promise<string[]> {
  const { scrubRemoteCredentials } = await import("@factory/shared");
  const ws = workspaceRoot(cfg);
  if (!fs.existsSync(ws)) return [];
  const fixed: string[] = [];
  for (const entry of fs.readdirSync(ws)) {
    const dir = path.join(ws, entry);
    if (!fs.existsSync(path.join(dir, ".git"))) continue;
    if (await scrubRemoteCredentials(dir)) fixed.push(entry);
  }
  return fixed;
}

export function renderChecks(results: CheckResult[]): string {
  const icon = { pass: "  ok  ", warn: " warn ", fail: " FAIL " } as const;
  return results
    .map((r) => {
      const head = `[${icon[r.status]}] ${r.name.padEnd(20)} ${r.detail}`;
      return r.fix && r.status !== "pass" ? `${head}\n${" ".repeat(11)}-> ${r.fix}` : head;
    })
    .join("\n");
}

/**
 * Run the checks and refuse to continue on a hard failure. Warnings are logged
 * and the run proceeds - a missing GitHub token is a smaller world, not a broken one.
 */
export async function preflight(cfg: FactoryConfig, opts: PreflightOptions = {}): Promise<CheckResult[]> {
  const results = await runChecks(cfg, opts);
  const failures = results.filter((r) => r.status === "fail");
  const warnings = results.filter((r) => r.status === "warn");

  if (failures.length || warnings.length) {
    log.info("preflight:");
    console.log(renderChecks(results.filter((r) => r.status !== "pass")));
  } else {
    log.ok(`preflight: ${results.length} checks passed`);
  }

  if (failures.length) throw new PreflightError(failures);
  return results;
}

export { formatUsd };
