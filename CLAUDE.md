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
packages/shared        types, config loader, git/GitHub helpers, proc + http utils
packages/agents        Claude Agent SDK runner, session-limit handling, role prompts
packages/orchestrator  pipeline state machine, stages, autonomous supervisor, CLI
packages/sentinel      error ingest server, SQLite incident store, healing scheduler
packages/error-sdk     vendored global error handlers injected into built apps
workspace/             generated apps (gitignored; each its own git repo)
```

`sentinel.db`, `workspace/`, `watchdog-*.log` and `.factory-watchdog.pid` are all
gitignored — never commit them.

## Commands

```bash
npm run typecheck                       # tsc --noEmit
npm test                                # tsx --test tests/*.test.ts
npm run factory -- auto "<prompt>"      # unattended build -> heal -> evolve
npm run factory -- sentinel start       # ingest + scheduler + dashboard on :4600
npm run factory -- apps | status <app> | stop <app>
```

## Conventions that matter here

- ESM + `.ts` extensions in imports (`node --experimental-strip-types` via tsx).
- Agent JSON contracts are zod schemas in `orchestrator/src/state.ts`; the agent
  writes `.factory/out/<name>.json` and the runner validates + retries once.
- Every gate loop must be bounded and must park as `needs_human` rather than spin.
- Adding a stage means touching `STAGE_ORDER`, the `runPipeline` switch, and
  `StageName` — there is no plugin registry yet.
