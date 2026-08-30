# Self-Healing Application Factory

A multi-agent framework that builds applications from a prompt, then keeps them healthy and evolving after deployment.

## What it does

**Build pipeline** (`factory build`): requirements gathering -> architecture + task DAG -> parallel developer agents -> QA loop -> code review loop -> security audit -> acceptance-criteria validation -> deploy (GitHub push + local run) -> evolution analysis. Every gate feeds defects back to developer agents, bounded by configurable iteration limits.

**Runtime self-healing** (`factory sentinel start`): a global error handler vendored into each built app reports runtime errors to the sentinel — server-side (Express middleware + `uncaughtException`/`unhandledRejection`) and, for apps that serve a UI, browser-side (`window.onerror` + `unhandledrejection`, sent via `sendBeacon` so a fatal error still reports as the page dies). Errors are fingerprinted and deduplicated into incidents (same error twice = one incident, never two healing agents). A healing agent claims the incident, clones the repo, reproduces the bug with a failing regression test, fixes the root cause, and opens a GitHub PR with an RCA writeup. When you merge, the sentinel redeploys and resolves the incident; recurrences reopen it with prior-fix context.

**Self-evolution** (`factory evolve`): an evolution agent audits the shipped app (missing features, robustness, security posture) and proposes ranked improvements; approved ones re-enter the pipeline.

## Setup

1. `npm install`
2. Auth for agents: existing Claude Code login is used automatically (or set `ANTHROPIC_API_KEY`).
3. `GITHUB_TOKEN` env var with `repo` scope (optional - without it everything runs local-only and healing pushes local branches instead of PRs).
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
npm test                             # framework unit tests (fingerprint dedup, claim exclusivity)
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

`factory auto` sets `FACTORY_AUTONOMOUS=1`, which layers the unattended overrides on top of `factory.config.json` for this process and everything it spawns. Your tuning in the config file is preserved. Set `autonomous.enabled: true` in the file if you run `factory sentinel start` as a separate long-lived process and want it healing unattended too.

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

**What this costs you.** Unattended means unattended: nothing stops a stubborn stage from consuming tokens across retries, and `evolutionCycles: 0` runs forever. The bounds that matter are `maxStageRetries`, `evolutionCycles`, `maxIncidentRearms` and `maxLimitWaitMs`. The healer's `npm test` gate and the post-deploy health check are the only things standing between a bad agent and your main branch, so keep `rollbackOnUnhealthy` on.

## Guarantees & guardrails

- One incident per error fingerprint; healing claims are CAS-transactional - duplicate agents for the same error are impossible.
- Global healing concurrency cap + per-incident attempt limit (`maxHealAttempts`), then the incident parks as `failed` for a human.
- Healing PRs and evolution features require human approval by default (`approvals` in config).
- Every gate loop is bounded; a stage that cannot converge parks as `needs_human` with a report instead of looping forever.

## Layout

```
packages/shared        types, config, git/GitHub helpers, process utils
packages/agents        agent runner (Claude Agent SDK) + role prompts
packages/orchestrator  pipeline state machine, stages, autonomous supervisor, factory CLI
packages/sentinel      error ingest server, incident store, healing scheduler
packages/error-sdk     vendored global error handlers (server + browser) for built apps
workspace/             the applications the factory builds
```
