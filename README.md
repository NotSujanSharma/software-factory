# Self-Healing Application Factory

A multi-agent framework that builds applications from a prompt, then keeps them healthy and evolving after deployment.

## What it does

**Build pipeline** (`factory build`): requirements gathering -> architecture + task DAG -> parallel developer agents -> QA loop -> code review loop -> security audit -> acceptance-criteria validation -> deploy (GitHub push + local run) -> evolution analysis. Every gate feeds defects back to developer agents, bounded by configurable iteration limits.

**Runtime self-healing** (`factory sentinel start`): a global error handler vendored into each built app reports runtime errors to the sentinel — server-side (Express middleware + `uncaughtException`/`unhandledRejection`) and, for apps that serve a UI, browser-side (`window.onerror` + `unhandledrejection`, sent via `sendBeacon` so a fatal error still reports as the page dies). Errors are fingerprinted and deduplicated into incidents (same error twice = one incident, never two healing agents). A healing agent claims the incident, clones the repo, reproduces the bug with a failing regression test, fixes the root cause, and opens a GitHub PR with an RCA writeup. When you merge, the sentinel redeploys and resolves the incident; recurrences reopen it with prior-fix context.

**Self-evolution** (`factory evolve`): an evolution agent audits the shipped app (missing features, robustness, security posture) and proposes ranked improvements; approved ones re-enter the pipeline.

## Setup

1. `npm install`
2. Auth for agents: existing Claude Code login is used automatically (or set `ANTHROPIC_API_KEY`).
3. `GITHUB_TOKEN` env var with `repo` scope (optional - without it everything runs local-only and healing pushes local branches instead of PRs). It is never written to disk: remotes store `https://x-access-token@github.com/...` and the token is supplied per-command through `GIT_ASKPASS`.
   If you ran an earlier version, `factory doctor --fix` scrubs tokens out of existing repos - then rotate that token, because it has been sitting in a file.
4. Tune `factory.config.json` (model, iteration limits, concurrency caps, ports, approvals).

## Usage

```bash
npm run factory -- auto "a todo API with express"                # fully unattended: build -> heal -> evolve
npm run factory -- auto --app todo-api                           # take over an existing app unattended
npm run factory -- build "an ecommerce app for handmade goods"   # interactive
npm run factory -- build "a todo API with express" --auto        # no questions
npm run factory -- status <app>      # pipeline progress
npm run factory -- resume <app>      # re-arm a parked pipeline
npm run factory -- apps              # list built apps
npm run factory -- sentinel start    # error ingest + healing scheduler + dashboard (http://localhost:4600)
npm run factory -- demo-error <app>  # plant a realistic bug and trigger it twice (healing e2e demo)
npm run factory -- evolve <app>      # review + implement improvement proposals
npm run factory -- stop <app>        # stop a running app
npm run factory -- doctor            # check the environment before it costs you a build
npm run factory -- cost              # spend ledger + remaining budget headroom
npm run factory -- rotate-key <app>  # issue a new ingest key for an app
npm test                             # framework unit tests
```

Built apps live in `workspace/<name>` - each is its own git repo with `.factory/` holding pipeline state, agent outputs, and logs.

## Fully autonomous mode

`factory auto` runs the whole lifecycle with no human in the loop. It hosts the sentinel in-process (or joins one already running), builds to a deployment, then loops on evolution while healing runs in the background. It never reads stdin.

What it removes from the loop:

- **Token / session limits.** Every agent run goes through a limit-aware wrapper. `You've hit your session limit - resets 8pm (America/Toronto)` is parsed (wall-clock with timezone, `try again in 45 minutes`, or an ISO timestamp), the run sleeps until the reset plus a buffer, then retries the same agent. Waking early is harmless: it re-detects the limit and waits again. Detection is deliberately strict so ordinary agent prose like "added rate limiting" never puts the pipeline to sleep.
- **Parked stages.** A stage that would park as `needs_human` is re-armed and retried by the supervisor, up to `maxStageRetries` (`0` = unlimited). Re-arming resets failed tasks to pending; stages already passed are never redone.
- **Healing PRs.** `autoMergeHealPRs` squash-merges the PR on GitHub, or merges the heal branch into main locally. A conflicted merge is aborted and left alone rather than forced.
- **Parked incidents.** An incident that exhausts `maxHealAttempts` is re-armed after `incidentRetryCooldownMs`, up to `maxIncidentRearms`.
- **Evolution.** Each round implements the `evolutionMaxPerCycle` cheapest proposals, re-runs QA, and restarts the app, every `evolutionIntervalMs`.

`factory auto` sets `FACTORY_AUTONOMOUS=1`, which layers the unattended overrides on top of `factory.config.json` for this process and everything it spawns. It deliberately overrides `approvals` - `autoMergeHealPRs` and `autoImplementEvolution` are both forced on, because an approval gate in an unattended run is only a place to get stuck. Everything else you tune in the file is preserved, **including budgets and the sandbox: unattended mode never widens a spend ceiling or relaxes a guardrail.** Set `autonomous.enabled: true` in the file if you run `factory sentinel start` as a separate long-lived process and want it healing unattended too.

**Rollback.** Merging your own fixes without review needs an undo, because a broken app reports no further errors and would never heal itself. After a fix lands, the app is redeployed and health-checked; if it does not answer within `healthCheckMs`, the merge is reverted (or reset, local-only), the app is restarted on the previous release, and the incident reopens with a note telling the next healer that the previous fix was wrong.

**Surviving its own agents.** Agents run shell commands, and a blunt one (`taskkill /IM node.exe`, `pkill -f node`) kills the orchestrator along with the app it meant to stop. The developer, QA and validator prompts now forbid killing by image name, but a prompt is not a guarantee, so `scripts/auto-watchdog.ps1` restarts `factory auto` if its process disappears. It is PowerShell, not Node, so the same command cannot take it out. State lives on disk, so a restart resumes: passed stages are skipped and interrupted work is re-armed.

```powershell
.\scripts\auto-watchdog.ps1 -App todo-api                 # runs in this terminal
.\scripts\auto-watchdog.ps1 -App todo-api -Detached       # survives the terminal closing
.\scripts\auto-watchdog.ps1 -App shop -Prompt "an ecommerce app for handmade goods"
```

Use `-Detached` for anything longer than a coffee break. Without it the watchdog is a child of the shell that started it, so closing the terminal, ending the session, or the machine sleeping takes it down and nothing restarts it. Detached, it writes `watchdog-<app>.log` and its PID to `.factory-watchdog.pid`:

```powershell
Get-Content .\watchdog-todo-api.log -Tail 20 -Wait          # follow it
Stop-Process -Id (Get-Content .factory-watchdog.pid) -Force # stop it
```

It still does not survive a reboot. Register a Scheduled Task with "run whether user is logged on or not" if you need that.

**What this costs you.** Spend is now metered and capped - see [Cost control](#cost-control). The remaining unbounded dimension is time: `evolutionCycles: 0` runs forever, within budget. The healer's `npm test` gate and the post-deploy health check are still the only things standing between a bad agent and your main branch, so keep `rollbackOnUnhealthy` on.

## Cost control

Every agent run is metered into a spend ledger (`factory.db`), and every run is
gated against your ceilings before it starts. A fresh clone ships conservative
defaults on purpose: nobody's first experiment should end in a surprise bill.

```bash
npm run factory -- cost                  # headroom, then a breakdown by app and role
npm run factory -- cost --app todo-api   # per-stage breakdown for one app
npm run factory -- cost --recent 20      # the last 20 runs, with turns and tool calls
```

| ceiling | scope | when it is hit |
| --- | --- | --- |
| `dailyUsd` | everything, rolling `dailyWindowHours` | **recoverable** - the run sleeps until spend ages out of the window |
| `perAppUsd` | one app, for its whole life | permanent - parks for a human |
| `perStageUsd` | one stage, across its retries | permanent - parks for a human |
| `perIncidentUsd` | healing one incident, across attempts | permanent - parks for a human |
| `totalUsd` | all spend ever recorded (`0` = off) | permanent - the last-resort kill switch |

The rolling window is the only ceiling that can free up on its own, so it is the
only one an unattended run is allowed to sleep on - and it computes a real wake
time from when enough spend ages out, instead of waking every minute to check.
Set `budget.onDailyExhausted` to `"park"` if you would rather it stop and tell you.
Every other ceiling needs a human to raise it, so hitting one throws a
`BudgetExceededError`, which the supervisor recognises as permanent and does
**not** burn five retries rediscovering.

Dollar ceilings are checked *before* a run, because the SDK only reports cost once
a run ends. A single run can therefore overshoot by its own cost; `maxTurnsPerRun`
and `maxToolCallsPerRun` are what bound that overshoot.

**Model routing** is the largest single lever. Per-role overrides fall back to
`model`, so the expensive model can stay where judgement matters while the
mechanical roles run cheaper:

```json
"models": {
  "architect": "claude-opus-5",
  "security": "claude-opus-5",
  "developer": "claude-sonnet-5",
  "qa": "claude-sonnet-5",
  "healer": "claude-sonnet-5"
}
```

## Agent sandboxing

Agents run with permissions bypassed, so a `PreToolUse` guard is the only thing
between them and the rest of the machine. It costs one in-process function call
per tool use, and it refuses:

- **Killing processes by name** (`taskkill /IM`, `pkill`, `killall`,
  `Stop-Process -Name`). This is the failure this project actually hit: every part
  of the factory is a `node` process, so an agent stopping "the app" that way takes
  the orchestrator and the sentinel with it. Killing by PID stays allowed.
- **File tools resolving outside the working directory**, and shell commands
  reaching into the factory's own installation - its source, config and databases -
  from an app that merely happens to live inside that tree.
- **Machine-level destruction**: `rm -rf /`, `mkfs`, `format`, `shutdown`,
  `Restart-Computer`, `npm publish`, force-pushes.
- **Fetch-and-execute pipelines** (`curl ... | sh`, `iwr ... | iex`).
- **Running away**: `maxToolCallsPerRun` ends a run that will not stop.

Be clear about what this is: **a guardrail, not a jail.** A determined agent can
defeat a regex, and the Bash path check is a heuristic rather than a proof. What it
buys is that the known catastrophic moves stop being possible instead of merely
being discouraged by a prompt. Real isolation needs a container, and that is still
worth doing.

Patterns added in `sandbox.denyCommands` are **added to** the built-in list, never
substituted for it: adding one project rule must not silently drop fifteen safety
rules.

## Error-ingest security

The sentinel decides which directory a healing agent clones and runs `npm test`
inside. Reaching that endpoint has to be a privilege, not a default.

- **Loopback by default.** `sentinel.host` is `127.0.0.1`. Point it elsewhere and
  every endpoint, reads included, starts demanding the admin token.
- **Per-app ingest keys.** Each app is issued one at registration and receives it
  through `FACTORY_INGEST_KEY` in its environment. It is never written to pipeline
  state, which lives in the app's own git repo. Rotate with
  `npm run factory -- rotate-key <app>`, then restart the app.
- **Browser errors never carry the key.** Anything shipped to a page is public, so
  the browser script reports same-origin to `/__factory_error` and the app's own
  server adds the key when forwarding. `browserProxy()` in the vendored SDK does
  that for you.
- **Registration and incident control require the admin token** (`x-factory-admin`),
  kept in `.factory-admin-token` or pinned via `FACTORY_ADMIN_TOKEN`.
- **Rate limits.** A per-app token bucket (`eventsPerMinute` / `burst`) absorbs a
  genuine burst of simultaneous crashes, and `newIncidentsPerHour` caps distinct new
  fingerprints - the one that really matters, because each new fingerprint can wake
  a healing agent.
- **Credentials are redacted** from agent logs, which record every tool call
  verbatim.

## Preflight

A build spends real money before it reaches the deploy stage, so everything
checkable in a second is checked in the first second. `build`, `resume`, `auto`
and `sentinel start` all run preflight automatically; `--skip-preflight` opts out.

```bash
npm run factory -- doctor              # full check, including a live agent-auth probe
npm run factory -- doctor --no-probe   # skip the probe (it costs a fraction of a cent)
npm run factory -- doctor --fix        # scrub tokens out of any repo config holding one
```

It checks Node and git and npm, workspace writability and free disk, GitHub token
validity and scopes, port availability, config coherence, remaining budget, and
whether any repo is still storing a credential. A **failure aborts**; a warning is
printed and the run continues, because a missing GitHub token is a smaller world
rather than a broken one.

The check that earns its keep is the last one: it runs a one-word agent query and
reads the answer. That is the only honest way to know the agents can authenticate,
and this project has already lost a full unattended run to finding out at stage
eight that the session had logged out - then retrying it five times, because
nothing distinguished "not logged in" from "did not converge". A failed preflight
is now marked `permanent`, and the supervisor does not retry those.

## Health checks

The post-heal rollback is only as good as its definition of healthy, and "answered
an HTTP request" is not one. An app returning 500 to every route is listening
perfectly and completely broken - and since a dead app reports no further errors,
nothing would ever heal it. So:

- Paths in `health.paths` are probed in order. A 404 moves on, because an API-only
  app legitimately has no route at `/`; a status at or above
  `health.unhealthyStatusFrom` (500) is a failure.
- `health.stableChecks` consecutive passes, a second apart, are required. One
  successful probe would let an app that boots, answers once and dies pass.
- If every path 404s, the server is still answering, which is the best evidence
  available without a health endpoint. The deploy stage asks the app to expose
  `GET /health`, so there usually is one.

`isReachable()` still exists for boot detection only - it answers "is anything
listening", which is a different question and must never decide a rollback.

## Guarantees & guardrails

- One incident per error fingerprint; healing claims are CAS-transactional - duplicate agents for the same error are impossible.
- Global healing concurrency cap + per-incident attempt limit (`maxHealAttempts`), then the incident parks as `failed` for a human.
- Healing PRs and evolution features require human approval by default (`approvals` in config).
- Every gate loop is bounded; a stage that cannot converge parks as `needs_human` with a report instead of looping forever.
- Every agent run is metered, and gated against a spend ceiling before it starts.
- Every agent tool call passes a guard that refuses the known-catastrophic moves.
- `/ingest` is authenticated per app and rate limited; registration needs the admin token.
- No credential is ever written to disk: remotes carry a username, never a token.
- The environment is checked before a run spends anything, and a failed check is
  permanent rather than retried.

## Layout

```
packages/shared        types, config, git/GitHub helpers, process utils
packages/agents        agent runner (Claude Agent SDK) + role prompts
packages/orchestrator  pipeline state machine, stages, autonomous supervisor, factory CLI
packages/sentinel      error ingest server, incident store, healing scheduler
packages/error-sdk     vendored global error handlers (server + browser) for built apps
sentinel.db            incidents and app registrations
factory.db             the spend ledger
workspace/             the applications the factory builds
```
