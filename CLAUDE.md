# Self-Healing Application Factory — working notes for Claude

## Committing (standing instruction)

**Commit whenever you make a significant change.** Do not leave meaningful work
uncommitted in the working tree, and do not wait to be asked.

- Significant = new/changed behavior, a new module or package, a bug fix, a
  refactor that moves code, config/schema changes, docs that describe behavior.
- Not significant = scratch files, a log, a one-line typo in a comment, anything
  under `workspace/` (generated apps are gitignored).
- One logical change per commit; message in imperative mood
  (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`).
- Run `npm run typecheck && npm test` before committing framework code.
- Work on a branch when the change is more than a small fix; `main` is the
  default branch and also the PR base.
- Push only when asked.

## Repo layout

```
packages/stacks        stack definitions, detection, command execution, prompt context
packages/shared        types, config loader, git/GitHub helpers, proc + http utils,
                       spend ledger + budget policy, secrets/redaction, admin token
packages/agents        Claude Agent SDK runner, session-limit handling, role prompts,
                       PreToolUse guard (sandbox + per-run tool ceiling)
packages/orchestrator  pipeline state machine, stages, autonomous supervisor, CLI
packages/sentinel      error ingest server, SQLite incident store, healing scheduler,
                       ingest rate limiter
packages/error-sdk     vendored error handlers (Node, Python, browser) + wire contract
workspace/             generated apps (gitignored; each its own git repo)
```

`sentinel.db`, `factory.db`, `.factory-admin-token`, `workspace/`, `watchdog-*.log`
and `.factory-watchdog.pid` are all gitignored — never commit them. The last two DB
files and the token file hold secrets and spend history.

## Commands

```bash
npm run typecheck                       # tsc --noEmit
npm test                                # tsx --test tests/*.test.ts
npm run factory -- auto "<prompt>"      # unattended build -> heal -> evolve
npm run factory -- sentinel start       # ingest + scheduler + dashboard on :4600
npm run factory -- apps | status <app> | stop <app>
npm run factory -- doctor [--no-probe] [--fix]          # environment preflight
npm run factory -- cost [--app <name>] [--recent <n>]   # spend + budget headroom
npm run factory -- rotate-key <app>     # new ingest key (restart the app after)
```

## Conventions that matter here

- ESM + `.ts` extensions in imports (`node --experimental-strip-types` via tsx).
- Agent JSON contracts are zod schemas in `orchestrator/src/state.ts`; the agent
  writes `.factory/out/<name>.json` and the runner validates + retries once.
- Every gate loop must be bounded and must park as `needs_human` rather than spin.
- Adding a stage means touching `STAGE_ORDER`, the `runPipeline` switch, and
  `StageName` — there is no plugin registry yet.
- Every `runAgent`/`runAgentForJson` call must carry attribution
  (`...agentMeta(ctx, stage)`, or `appId`/`appName`/`stage` directly). Without it
  the run is billed to no app and escapes the per-app and per-stage ceilings.
- Budgets and the sandbox are **on by default** and unattended mode never relaxes
  them. A failure that a human must resolve should carry `permanent` (as
  `BudgetExceededError` does) so the supervisor does not retry it.
- Never write a secret into `.factory/state.json` — it lives in the generated
  app's git repo. Ingest keys are read from the sentinel store at process start.
- Never put a token in a URL. `remoteUrl()` gives the username-only form and
  `gitAuthEnv()` supplies the secret to the git child; `git()`/`gitTry()`/
  `gitClone()` already carry it.
- "Is it listening" is not "is it healthy". Use `verifyHealthy()` for any decision
  with consequences (rollback, deploy verdict); `isReachable()` is boot detection.
- A failure a human must resolve carries `permanent` (`BudgetExceededError`,
  `PreflightError`) so `withStageRetries` parks instead of paying to retry.
- Never hard-code `npm` (or any other ecosystem's tooling) into a stage, a prompt
  or the healer. Commands come from `ctx.stack()` / `resolveStack(dir)` and run via
  `runStackPhase` / `startStackApp`. Prompts get `ctx.stackContext()`.
- Never add `shell: true` to a spawn. `planSpawn()` resolves npm to
  `node npm-cli.js`; anything else is a real executable. A shell means Node
  concatenates args unescaped, which is command injection waiting for its first
  untrusted string.

## Writing files in this repo

Heredocs through the Bash tool have mangled backslash escapes here (`[\\/]`
collapsed to `[\/]`, silently breaking a regex). For files containing regexes or
escape sequences, use the Write/Edit tools, or `String.raw`, or build the pattern
with `new RegExp` from a named string.
