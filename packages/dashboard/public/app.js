/*
 * Factory dashboard.
 *
 * No build step and no framework: the server has no bundler and this page has no
 * business adding one. Views are functions that return HTML strings, rendered into
 * a single container, refreshed from one server-sent-events stream.
 *
 * Everything interpolated goes through esc(). The data here includes agent output,
 * error messages and stack traces from generated applications - none of it is
 * trustworthy, and all of it ends up on this page.
 */

const STAGES = [
  "requirements", "architecture", "development", "qa",
  "review", "security", "validation", "deploy", "evolution",
];

const state = {
  data: null,        // latest overview payload
  view: "overview",
  app: null,         // app name when viewing a detail page
  detail: null,      // cached detail payload
  tab: "flow",
  logName: null,
  logFollow: true,
  connected: false,
};

// ---------------------------------------------------------------- utilities

const $ = (sel) => document.querySelector(sel);

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function money(n) {
  const v = Number(n ?? 0);
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}

function ago(iso) {
  if (!iso) return "—";
  const secs = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (secs < 60) return `${Math.floor(secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function api(path, options) {
  const res = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try { message = JSON.parse(text).error ?? text; } catch { /* plain text */ }
    throw new Error(message || `request failed (${res.status})`);
  }
  try { return JSON.parse(text); } catch { return text; }
}

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 3800);
}

// ---------------------------------------------------------------- fragments

function pill(status, label) {
  return `<span class="pill s-${esc(status)}">${esc(label ?? String(status).replace(/_/g, " "))}</span>`;
}

function bar(percent, tone = "") {
  const width = Math.max(0, Math.min(100, Number(percent) || 0));
  return `<div class="bar"><span class="${tone}" style="width:${width}%"></span></div>`;
}

/** The pipeline flow: the view that answers "where is this build?" at a glance. */
function flow(stages, compact = false) {
  const byName = new Map((stages ?? []).map((s) => [s.name, s]));
  const current = (stages ?? []).find((s) => s.status === "running")
    ?? (stages ?? []).find((s) => s.status === "failed" || s.status === "needs_human")
    ?? (stages ?? []).find((s) => s.status !== "passed");

  const nodes = STAGES.map((name, i) => {
    const rec = byName.get(name) ?? { status: "pending", iterations: 0 };
    const isCurrent = current?.name === name;
    const mark = rec.status === "passed" ? "✓"
      : rec.status === "failed" ? "✕"
      : rec.status === "needs_human" ? "!"
      : rec.status === "running" ? "●" : String(i + 1);
    const prev = i > 0 ? byName.get(STAGES[i - 1]) : null;
    const line = i > 0 ? `<div class="flow-line ${prev?.status === "passed" ? "done" : ""}"></div>` : "";
    const iters = rec.iterations > 1 ? ` <span class="faint">×${rec.iterations}</span>` : "";
    return `${line}<div class="flow-node ${isCurrent ? "is-current" : ""}" title="${esc(name)}: ${esc(rec.status)}">
      <div class="flow-dot ${esc(rec.status)}">${mark}</div>
      ${compact ? "" : `<div class="flow-label">${esc(name)}${iters}</div>`}
    </div>`;
  }).join("");

  const note = current?.notes
    ? `<div class="flow-note ${current.status === "failed" ? "failed" : current.status === "needs_human" ? "warn" : ""}">
         <strong>${esc(current.name)}</strong> — ${esc(current.notes)}
       </div>`
    : "";
  return `<div class="flow">${nodes}</div>${compact ? "" : note}`;
}

function empty(icon, title, body, action = "") {
  return `<div class="empty"><div class="empty-icon">${icon}</div><h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`;
}

// ---------------------------------------------------------------- views

function viewOverview() {
  const d = state.data;
  if (!d) return `<div class="empty">Loading…</div>`;

  const building = d.apps.filter((a) => a.run).length;
  const serving = d.apps.filter((a) => a.serving).length;
  const openIncidents = d.incidents.open + d.incidents.healing + d.incidents.prOpen;
  const spendPct = d.spend.dailyUsd > 0 ? (d.spend.windowSpend / d.spend.dailyUsd) * 100 : 0;
  const spendTone = spendPct > 90 ? "danger" : spendPct > 70 ? "warn" : "";

  const active = d.apps.filter((a) => a.run);
  const attention = d.apps.filter(
    (a) => a.current && (a.current.status === "failed" || a.current.status === "needs_human"),
  );

  return `
  <div class="view">
    <div class="grid stats mb">
      <div class="stat">
        <div class="stat-label">Applications</div>
        <div class="stat-value">${d.apps.length}</div>
        <div class="stat-meta">${serving} serving · ${building} building</div>
      </div>
      <div class="stat">
        <div class="stat-label">Pipeline runs</div>
        <div class="stat-value ${d.activeRuns ? "ok" : ""}">${d.activeRuns}</div>
        <div class="stat-meta">active right now</div>
      </div>
      <div class="stat">
        <div class="stat-label">Open incidents</div>
        <div class="stat-value ${openIncidents ? "warn" : ""}">${openIncidents}</div>
        <div class="stat-meta">${d.incidents.healing} healing · ${d.incidents.failed} parked</div>
      </div>
      <div class="stat">
        <div class="stat-label">Spend · last ${d.spend.windowHours}h</div>
        <div class="stat-value ${spendTone}">${money(d.spend.windowSpend)}</div>
        <div class="stat-meta">${d.spend.dailyUsd > 0 ? `of ${money(d.spend.dailyUsd)} budget` : "no ceiling set"}</div>
        ${d.spend.dailyUsd > 0 ? bar(spendPct, spendTone) : ""}
      </div>
    </div>

    ${attention.length ? `
    <div class="card mb">
      <div class="card-head"><h2>Needs attention</h2><span class="sub">${attention.length} parked</span></div>
      <div class="card-body flush">
        <table><tbody>
          ${attention.map((a) => `
            <tr class="clickable" data-app="${esc(a.name)}">
              <td><strong>${esc(a.name)}</strong></td>
              <td>${pill(a.current.status)}</td>
              <td class="dim">${esc(a.current.stage)}</td>
              <td class="dim truncate">${esc(a.current.notes ?? "")}</td>
              <td class="num faint nowrap">${ago(a.updatedAt)}</td>
            </tr>`).join("")}
        </tbody></table>
      </div>
    </div>` : ""}

    ${active.length ? `
    <div class="card mb">
      <div class="card-head"><h2>In progress</h2></div>
      <div class="card-body">
        ${active.map((a) => `
          <div style="margin-bottom:18px" data-app="${esc(a.name)}" class="clickable">
            <div class="row mb">
              <strong>${esc(a.name)}</strong>
              ${pill(a.current?.status ?? "running")}
              <span class="faint small">${esc(a.run.mode)} · started ${ago(a.run.startedAt)}</span>
              <span class="right faint small">${esc(a.stack.label)}</span>
            </div>
            ${flow(a.stages)}
          </div>`).join("")}
      </div>
    </div>` : ""}

    <div class="grid two">
      <div class="card">
        <div class="card-head"><h2>Applications</h2>
          <span class="right"><button class="btn sm" data-view="apps">View all</button></span>
        </div>
        <div class="card-body flush">
          ${d.apps.length === 0
            ? empty("▦", "No applications yet", "Describe what you want built and the factory will take it from there.",
                `<button class="btn primary" id="empty-new">＋ New build</button>`)
            : `<table><tbody>${d.apps.slice(0, 8).map((a) => `
                <tr class="clickable" data-app="${esc(a.name)}">
                  <td><strong>${esc(a.name)}</strong><div class="faint small">${esc(a.stack.label)}</div></td>
                  <td style="width:120px">${bar(a.progress, a.current?.status === "failed" ? "danger" : "ok")}
                      <div class="faint small" style="margin-top:3px">${a.progress}%</div></td>
                  <td>${a.current ? pill(a.current.status, a.current.stage) : pill("done", "complete")}</td>
                  <td class="num nowrap faint">${money(a.costUsd)}</td>
                </tr>`).join("")}</tbody></table>`}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>Recent incidents</h2>
          <span class="right"><button class="btn sm" data-view="incidents">View all</button></span>
        </div>
        <div class="card-body flush">
          ${d.incidents.recent.length === 0
            ? empty("✓", "No incidents", "Nothing has crashed. Errors reported by a running app appear here.")
            : `<table><tbody>${d.incidents.recent.slice(0, 8).map((i) => `
                <tr class="clickable" data-incident="${i.id}">
                  <td class="faint mono">#${i.id}</td>
                  <td>${pill(i.status)}</td>
                  <td class="truncate" style="max-width:230px">${esc(i.sampleEvent?.type ?? "Error")}: ${esc((i.sampleEvent?.message ?? "").slice(0, 70))}</td>
                  <td class="num faint nowrap">×${i.count}</td>
                </tr>`).join("")}</tbody></table>`}
        </div>
      </div>
    </div>
  </div>`;
}

function viewApps() {
  const d = state.data;
  if (!d) return "";
  if (!d.apps.length) {
    return `<div class="view"><div class="card"><div class="card-body">${empty(
      "▦", "No applications yet",
      "Describe what you want built. The factory chooses the stack, writes it, tests it, deploys it and keeps it healthy.",
      `<button class="btn primary" id="empty-new">＋ New build</button>`)}</div></div></div>`;
  }

  return `<div class="view"><div class="grid two">
    ${d.apps.map((a) => `
      <div class="app-card" data-app="${esc(a.name)}">
        <div class="app-head">
          <span class="app-name">${esc(a.name)}</span>
          ${a.run ? pill("running", a.run.mode) : a.current ? pill(a.current.status, a.current.stage) : pill("done", "complete")}
          <span class="right faint small">${ago(a.updatedAt)}</span>
        </div>
        <div class="app-prompt">${esc(a.prompt)}</div>
        ${flow(a.stages, true)}
        <div class="app-meta">
          <span class="item">◆ ${esc(a.stack.label)}</span>
          <span class="item">✓ ${a.tasks.done}/${a.tasks.total} tasks</span>
          ${a.port ? `<span class="item">${a.serving ? "◉" : "○"} :${a.port}</span>` : ""}
          ${a.incidents.open + a.incidents.healing > 0 ? `<span class="item" style="color:var(--warn)">⚠ ${a.incidents.open + a.incidents.healing}</span>` : ""}
          <span class="item right">${money(a.costUsd)}</span>
        </div>
      </div>`).join("")}
  </div></div>`;
}

function viewAppDetail() {
  const a = state.detail;
  if (!a) return `<div class="empty">Loading…</div>`;

  const tabs = ["flow", "tasks", "defects", "incidents", "logs", "docs", "cost"];
  const body = {
    flow: tabFlow, tasks: tabTasks, defects: tabDefects,
    incidents: tabIncidents, logs: tabLogs, docs: tabDocs, cost: tabCost,
  }[state.tab] ?? tabFlow;

  return `
  <div class="view">
    <div class="card mb">
      <div class="card-body">
        <div class="row wrap mb">
          ${a.run ? pill("running", `${a.run.mode} running`) : a.current ? pill(a.current.status, a.current.stage) : pill("done", "complete")}
          <span class="faint small">${esc(a.stack.label)}${a.stack.framework ? ` · ${esc(a.stack.framework)}` : ""}</span>
          ${a.port ? `<span class="faint small">${a.serving ? "◉ serving on" : "○ stopped ·"} <a href="http://localhost:${a.port}" target="_blank" rel="noreferrer">:${a.port}</a></span>` : ""}
          ${a.repoUrl ? `<a class="small" href="https://github.com/${esc(a.repoUrl)}" target="_blank" rel="noreferrer">${esc(a.repoUrl)} ↗</a>` : `<span class="faint small">local only</span>`}
          <span class="right row">
            ${a.run
              ? `<button class="btn sm danger" data-stop-run="${esc(a.run.id)}">■ Stop run</button>`
              : `<button class="btn sm" data-start="resume">▶ Resume</button>
                 <button class="btn sm" data-start="auto">⟳ Autonomous</button>
                 <button class="btn sm" data-start="evolve">✦ Evolve</button>`}
            ${a.serving ? `<button class="btn sm" data-stop-app="1">■ Stop app</button>` : ""}
            <button class="btn sm" data-rearm="1" title="Put parked stages back on the board">⤾ Re-arm</button>
          </span>
        </div>
        <div class="dim" style="font-size:12.5px">${esc(a.prompt)}</div>
      </div>
      <div class="tabs">
        ${tabs.map((t) => `<button class="tab ${state.tab === t ? "active" : ""}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
      </div>
      <div class="card-body ${state.tab === "logs" ? "flush" : ""}">${body(a)}</div>
    </div>
  </div>`;
}

function tabFlow(a) {
  const done = a.stages.filter((s) => s.status === "passed").length;
  return `
    ${flow(a.stages)}
    <div class="grid stats mt">
      <div class="stat"><div class="stat-label">Stages</div><div class="stat-value">${done}/${a.stages.length}</div></div>
      <div class="stat"><div class="stat-label">Tasks</div><div class="stat-value">${a.tasks.done}/${a.tasks.total}</div>
        <div class="stat-meta">${a.tasks.failed} failed · ${a.tasks.pending} pending</div></div>
      <div class="stat"><div class="stat-label">Incidents</div><div class="stat-value ${a.incidents.length ? "warn" : ""}">${a.incidents.length}</div></div>
      <div class="stat"><div class="stat-label">Spent</div><div class="stat-value">${money(a.costUsd)}</div></div>
    </div>
    <div class="mt"><h3 style="font-size:12.5px;margin:16px 0 8px">Stage history</h3>
    <table><thead><tr><th>Stage</th><th>Status</th><th>Runs</th><th>Notes</th><th>Finished</th></tr></thead><tbody>
      ${a.stages.map((s) => `<tr>
        <td><strong>${esc(s.name)}</strong></td>
        <td>${pill(s.status)}</td>
        <td class="num">${s.iterations}</td>
        <td class="dim truncate">${esc(s.notes ?? "")}</td>
        <td class="faint nowrap">${s.finishedAt ? ago(s.finishedAt) : "—"}</td>
      </tr>`).join("")}
    </tbody></table></div>
    ${a.criteria?.length ? `
      <h3 style="font-size:12.5px;margin:22px 0 8px">Acceptance criteria</h3>
      <table><tbody>${a.criteria.map((c) => `
        <tr><td class="mono faint" style="width:60px">${esc(c.id)}</td><td>${esc(c.description)}</td></tr>`).join("")}
      </tbody></table>` : ""}
    ${a.assumptions?.length ? `
      <h3 style="font-size:12.5px;margin:22px 0 8px">Assumptions</h3>
      <ul class="dim" style="font-size:12.5px;padding-left:18px;margin:0">
        ${a.assumptions.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}`;
}

function tabTasks(a) {
  if (!a.taskList.length) return empty("▦", "No tasks yet", "The architect stage produces the work breakdown.");
  return `<table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Depends on</th></tr></thead><tbody>
    ${a.taskList.map((t) => `<tr>
      <td class="mono faint">${esc(t.id)}</td>
      <td><strong>${esc(t.title)}</strong><div class="faint small truncate">${esc(t.description ?? "")}</div></td>
      <td>${pill(t.status)}</td>
      <td class="faint mono small">${esc((t.dependsOn ?? []).join(", ") || "—")}</td>
    </tr>`).join("")}</tbody></table>`;
}

function tabDefects(a) {
  if (!a.defects.length) return empty("✓", "No defects recorded", "Findings from QA, review, security and validation appear here.");
  return `<table><thead><tr><th>Source</th><th>Severity</th><th>Title</th><th>Detail</th></tr></thead><tbody>
    ${a.defects.map((d) => `<tr>
      <td class="faint">${esc(d.source)}</td>
      <td><span class="pill sev-${esc(d.severity)}">${esc(d.severity)}</span></td>
      <td><strong>${esc(d.title)}</strong></td>
      <td class="dim truncate">${esc(d.detail ?? "")}</td>
    </tr>`).join("")}</tbody></table>`;
}

function tabIncidents(a) {
  if (!a.incidents.length) return empty("✓", "No incidents", "Runtime errors reported by this app appear here and trigger healing.");
  return incidentTable(a.incidents);
}

function incidentTable(list) {
  return `<table><thead><tr><th>#</th><th>Status</th><th>Error</th><th>Seen</th><th>Attempts</th><th>Fix</th><th></th></tr></thead><tbody>
    ${list.map((i) => `<tr>
      <td class="mono faint">${i.id}</td>
      <td>${pill(i.status)}</td>
      <td><strong>${esc(i.sampleEvent?.type ?? "Error")}</strong>
          <div class="faint small truncate">${esc((i.sampleEvent?.message ?? "").slice(0, 120))}</div></td>
      <td class="num">×${i.count}<div class="faint small nowrap">${ago(i.lastSeen)}</div></td>
      <td class="num faint">${i.attempts}${i.rearms ? ` <span title="re-arms">↻${i.rearms}</span>` : ""}</td>
      <td>${i.prUrl ? `<a href="${esc(i.prUrl)}" target="_blank" rel="noreferrer">PR ↗</a>` : `<span class="faint mono small">${esc(i.branch ?? "—")}</span>`}</td>
      <td>${i.status === "failed" ? `<button class="btn sm" data-retry="${i.id}">Retry</button>` : ""}</td>
    </tr>`).join("")}</tbody></table>`;
}

function tabDocs(a) {
  if (!a.docs.length) return empty("▤", "No documents yet", "requirements.md and architecture.md appear once those stages run.");
  return `<div class="row wrap mb">
      ${a.docs.map((d) => `<button class="btn sm" data-doc="${esc(d.name)}">${esc(d.name)} <span class="faint">${bytes(d.size)}</span></button>`).join("")}
    </div><pre class="log-view" id="doc-view" style="max-height:60vh;border:1px solid var(--border);border-radius:var(--radius-sm)">Select a document.</pre>`;
}

function tabCost(a) {
  const all = [...(a.spendByStage ?? []), ...(a.spendByRole ?? [])];
  const max = Math.max(1, ...all.map((g) => g.costUsd));

  const table = (list, label) => !list?.length ? "" : `
    <h3 style="font-size:12.5px;margin:16px 0 8px">${label}</h3>
    <table><tbody>${list.map((g) => `<tr>
      <td style="width:130px">${esc(g.key)}</td>
      <td>${bar((g.costUsd / max) * 100)}</td>
      <td class="num nowrap">${money(g.costUsd)}</td>
      <td class="num faint nowrap">${g.runs} runs</td>
    </tr>`).join("")}</tbody></table>`;

  return `<div class="stat" style="max-width:260px"><div class="stat-label">Total for this app</div>
    <div class="stat-value">${money(a.costUsd)}</div></div>
    ${table(a.spendByStage, "By stage")}${table(a.spendByRole, "By agent role")}`;
}

function tabLogs(a) {
  const logs = a.logs ?? [];
  const items = [{ name: "app.log", label: "Application output", meta: "the running app" }]
    .concat(logs.map((l) => ({ name: l.name, label: l.name, meta: `${bytes(l.size)} · ${ago(l.modified)}` })));

  return `<div class="log-wrap">
    <div class="log-list">
      ${items.map((l) => `<div class="log-entry ${state.logName === l.name ? "active" : ""}" data-log="${esc(l.name)}">
        <div class="n">${esc(l.label)}</div><div class="m">${esc(l.meta)}</div></div>`).join("")}
    </div>
    <div style="display:flex;flex-direction:column;min-width:0">
      <div class="log-toolbar">
        <span class="mono faint">${esc(state.logName ?? "select a log")}</span>
        <span class="right row">
          <label class="row small faint" style="gap:5px"><input type="checkbox" id="follow" ${state.logFollow ? "checked" : ""}> follow</label>
          <button class="btn sm ghost" id="log-refresh">⟳</button>
        </span>
      </div>
      <pre class="log-view" id="log-view">${state.logName ? "Loading…" : "Select a log to view."}</pre>
    </div>
  </div>`;
}

function viewIncidents() {
  const d = state.data;
  if (!d) return "";
  const list = d.incidents.recent;
  return `<div class="view">
    <div class="grid stats mb">
      ${[["open", "Open", "warn"], ["healing", "Healing", ""], ["prOpen", "Fix proposed", ""], ["failed", "Parked", "danger"], ["resolved", "Resolved", "ok"]]
        .map(([k, label, tone]) => `<div class="stat"><div class="stat-label">${label}</div>
          <div class="stat-value ${d.incidents[k] ? tone : ""}">${d.incidents[k]}</div></div>`).join("")}
    </div>
    <div class="card"><div class="card-head"><h2>Incidents</h2>
      <span class="sub">deduplicated by error fingerprint</span></div>
      <div class="card-body flush">
        ${list.length ? incidentTable(list)
          : empty("✓", "No incidents", "When a deployed app throws, it is fingerprinted, deduplicated and healed here.")}
      </div>
    </div>
  </div>`;
}

function viewRuns() {
  const d = state.data;
  if (!d) return "";
  if (!d.runs.length) {
    return `<div class="view"><div class="card"><div class="card-body">${empty(
      "▶", "No pipeline runs yet", "Runs started from this dashboard appear here with their live output.",
      `<button class="btn primary" id="empty-new">＋ New build</button>`)}</div></div></div>`;
  }
  return `<div class="view"><div class="card">
    <div class="card-head"><h2>Pipeline runs</h2></div>
    <div class="card-body flush">
      <table><thead><tr><th>App</th><th>Mode</th><th>Status</th><th>Started</th><th>PID</th><th></th></tr></thead><tbody>
        ${d.runs.map((r) => `<tr>
          <td><strong>${esc(r.app)}</strong>${r.prompt ? `<div class="faint small truncate">${esc(r.prompt)}</div>` : ""}</td>
          <td class="faint">${esc(r.mode)}</td>
          <td>${r.finishedAt ? pill("idle", "finished") : pill("running")}</td>
          <td class="faint nowrap">${ago(r.startedAt)}</td>
          <td class="mono faint">${r.pid}</td>
          <td class="row" style="justify-content:flex-end">
            <button class="btn sm" data-run-log="${esc(r.id)}">Log</button>
            ${!r.finishedAt ? `<button class="btn sm danger" data-stop-run="${esc(r.id)}">Stop</button>` : ""}
          </td>
        </tr>`).join("")}
      </tbody></table>
    </div></div></div>`;
}

function viewCost() {
  const d = state.data;
  if (!d) return "";
  const s = d.spend;
  const pct = s.dailyUsd > 0 ? (s.windowSpend / s.dailyUsd) * 100 : 0;
  const tone = pct > 90 ? "danger" : pct > 70 ? "warn" : "ok";
  const max = Math.max(1, ...s.byApp.map((g) => g.costUsd), ...s.byRole.map((g) => g.costUsd));

  const group = (list, label) => !list.length ? "" : `
    <div class="card"><div class="card-head"><h2>${label}</h2></div><div class="card-body flush">
      <table><tbody>${list.map((g) => `<tr>
        <td style="width:150px">${esc(g.key)}</td>
        <td>${bar((g.costUsd / max) * 100)}</td>
        <td class="num nowrap">${money(g.costUsd)}</td>
        <td class="num faint nowrap">${g.runs} runs</td>
        ${g.errors ? `<td class="num" style="color:var(--danger)">${g.errors} err</td>` : "<td></td>"}
      </tr>`).join("")}</tbody></table>
    </div></div>`;

  return `<div class="view">
    <div class="grid stats mb">
      <div class="stat"><div class="stat-label">Last ${s.windowHours}h</div>
        <div class="stat-value ${tone === "ok" ? "" : tone}">${money(s.windowSpend)}</div>
        <div class="stat-meta">${s.dailyUsd > 0 ? `of ${money(s.dailyUsd)}` : "no ceiling"}</div>
        ${s.dailyUsd > 0 ? bar(pct, tone) : ""}</div>
      <div class="stat"><div class="stat-label">All time</div><div class="stat-value">${money(s.total)}</div>
        <div class="stat-meta">${s.totalUsd > 0 ? `ceiling ${money(s.totalUsd)}` : "no ceiling"}</div></div>
      <div class="stat"><div class="stat-label">Per-app ceiling</div>
        <div class="stat-value">${s.perAppUsd > 0 ? money(s.perAppUsd) : "—"}</div>
        <div class="stat-meta">lifetime, per application</div></div>
      <div class="stat"><div class="stat-label">Budgets</div>
        <div class="stat-value ${s.enabled ? "ok" : "warn"}">${s.enabled ? "On" : "Off"}</div>
        <div class="stat-meta">${s.enabled ? "runs are gated" : "spend is unbounded"}</div></div>
    </div>
    <div class="grid two mb">${group(s.byApp, "By application")}${group(s.byRole, "By agent role")}</div>
    <div class="card"><div class="card-head"><h2>Recent agent runs</h2></div><div class="card-body flush">
      <table><thead><tr><th>When</th><th>App</th><th>Role</th><th>Stage</th><th>Model</th><th class="num">Turns</th><th class="num">Tools</th><th class="num">Cost</th></tr></thead>
      <tbody>${s.recent.map((r) => `<tr>
        <td class="faint nowrap">${ago(r.ts)}</td>
        <td>${esc(r.appName ?? "—")}</td>
        <td>${esc(r.role)}${r.isError ? ` <span class="pill s-failed plain">error</span>` : ""}</td>
        <td class="faint">${esc(r.stage ?? "—")}</td>
        <td class="faint mono small">${esc(r.model)}</td>
        <td class="num">${r.turns}</td><td class="num">${r.toolCalls}</td>
        <td class="num nowrap">${money(r.costUsd)}</td>
      </tr>`).join("")}</tbody></table>
    </div></div>
  </div>`;
}

function viewSettings() {
  const d = state.data;
  if (!d) return "";
  const c = d.config;
  const flag = (on, yes, no) => `<span class="pill ${on ? "s-passed" : "s-warn"}">${on ? yes : no}</span>`;
  return `<div class="view"><div class="card">
    <div class="card-head"><h2>Configuration</h2><span class="sub">edit factory.config.json to change these</span></div>
    <div class="card-body">
      <dl class="kv">
        <dt>Model</dt><dd class="mono">${esc(c.model)}</dd>
        <dt>Sentinel</dt><dd class="mono">${esc(c.sentinelUrl)}</dd>
        <dt>Dev concurrency</dt><dd>${c.devConcurrency} parallel agents, each in its own git worktree</dd>
        <dt>Sandbox</dt><dd>${flag(c.sandbox, "enabled", "disabled")}</dd>
        <dt>Budgets</dt><dd>${flag(c.budgets, "enforced", "off")}</dd>
        <dt>Auto-merge heals</dt><dd>${flag(!c.autoMergeHealPRs, "requires review", "merges automatically")}</dd>
      </dl>
      <div class="hint mt">This dashboard is bound to loopback and grants no privilege a local shell does not
        already have. Exposing it on a network interface makes every request require the admin token.</div>
    </div>
  </div></div>`;
}

// ---------------------------------------------------------------- rendering

const VIEWS = {
  overview: { title: "Overview", render: viewOverview },
  apps: { title: "Applications", render: viewApps },
  app: { title: "Application", render: viewAppDetail },
  incidents: { title: "Incidents", render: viewIncidents },
  runs: { title: "Pipeline runs", render: viewRuns },
  cost: { title: "Cost & budget", render: viewCost },
  settings: { title: "Configuration", render: viewSettings },
};

function render() {
  const view = VIEWS[state.view] ?? VIEWS.overview;
  $("#title").textContent = state.view === "app" ? (state.app ?? "Application") : view.title;
  $("#crumb").textContent = state.view === "app" ? "· application" : "";
  $("#content").innerHTML = view.render();

  document.querySelectorAll(".nav-item").forEach((el) => {
    const target = state.view === "app" ? "apps" : state.view;
    el.classList.toggle("active", el.dataset.view === target);
  });

  if (state.view === "app" && state.tab === "logs" && state.logName) loadLog();
  updateChrome();
}

function updateChrome() {
  const d = state.data;
  if (!d) return;
  $("#c-apps").textContent = d.apps.length || "";
  const open = d.incidents.open + d.incidents.healing;
  $("#c-incidents").textContent = open || "";
  $("#c-runs").textContent = d.activeRuns || "";
  $("#f-model").textContent = d.config.model;
  $("#f-sandbox").textContent = d.config.sandbox ? "on" : "off";
  $("#f-budget").textContent = d.config.budgets ? "on" : "off";
}

function go(view, app) {
  state.view = view;
  if (app) state.app = app;
  if (view === "app") {
    state.tab = "flow";
    state.logName = null;
    loadDetail();
  }
  location.hash = view === "app" ? `#/app/${encodeURIComponent(state.app)}` : `#/${view}`;
  render();
}

async function loadDetail() {
  if (!state.app) return;
  try {
    state.detail = await api(`/api/apps/${encodeURIComponent(state.app)}`);
    if (state.view === "app") render();
  } catch (err) {
    toast(`Could not load ${state.app}: ${err.message}`, "error");
    go("apps");
  }
}

// ---------------------------------------------------------------- logs

/** Agent logs carry ANSI colour and level markers; turn them into styled lines. */
function renderLogText(text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = clean.split("\n").slice(-3000);
  return lines.map((line) => {
    let level = "";
    if (/\bERROR\b|\[denied\]|Error:/.test(line)) level = "lvl-error";
    else if (/\bWARN\b/.test(line)) level = "lvl-warn";
    else if (/\bOK\b/.test(line)) level = "lvl-ok";
    else if (/\bAGENT\b|\[assistant\]/.test(line)) level = "lvl-agent";
    else if (/\[tool\]|\btool:/.test(line)) level = "lvl-tool";
    return `<div class="log-line ${level}">${esc(line) || "&nbsp;"}</div>`;
  }).join("");
}

async function loadLog() {
  const view = $("#log-view");
  if (!view || !state.logName) return;
  const url = state.logName === "app.log"
    ? `/api/apps/${encodeURIComponent(state.app)}/applog`
    : `/api/apps/${encodeURIComponent(state.app)}/logs/${encodeURIComponent(state.logName)}`;
  try {
    const text = await api(url);
    const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 60;
    view.innerHTML = renderLogText(String(text)) || "<div class='faint'>(empty)</div>";
    if (state.logFollow && atBottom) view.scrollTop = view.scrollHeight;
  } catch (err) {
    view.textContent = `Could not read the log: ${err.message}`;
  }
}

function showRunLog(id) {
  openModal(`Run log · ${esc(id)}`, `<pre class="log-view" id="run-log" style="max-height:60vh;margin:0">Loading…</pre>`, "");
  const load = async () => {
    const el = $("#run-log");
    if (!el) return false;
    try {
      const text = await api(`/api/runs/${encodeURIComponent(id)}/log`);
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      el.innerHTML = renderLogText(String(text)) || "<div class='faint'>(no output yet)</div>";
      if (atBottom) el.scrollTop = el.scrollHeight;
    } catch { /* modal closed */ }
    return true;
  };
  load();
  const timer = setInterval(async () => { if (!(await load())) clearInterval(timer); }, 2000);
  modalCleanup = () => clearInterval(timer);
}

// ---------------------------------------------------------------- modal

let modalCleanup = null;

function openModal(title, body, footer) {
  $("#modal-host").innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h2>${title}</h2>
          <span class="right"><button class="btn sm ghost" id="modal-x">✕</button></span></div>
        <div class="modal-body">${body}</div>
        ${footer === "" ? "" : `<div class="modal-foot">${footer}</div>`}
      </div>
    </div>`;
  $("#overlay").addEventListener("click", (e) => { if (e.target.id === "overlay") closeModal(); });
  $("#modal-x").addEventListener("click", closeModal);
}

function closeModal() {
  if (modalCleanup) { modalCleanup(); modalCleanup = null; }
  $("#modal-host").innerHTML = "";
}

function newBuildModal() {
  openModal("New build", `
    <label class="field"><span>What should the factory build?</span>
      <textarea id="b-prompt" placeholder="A URL shortener with a REST API, click analytics and a small web UI"></textarea>
      <div class="hint">The architect chooses the language, framework and data store. Say so here if you have a preference.</div>
    </label>
    <label class="field"><span>Application name <span class="faint">(optional)</span></span>
      <input type="text" id="b-name" placeholder="derived from the prompt">
    </label>
    <label class="field"><span>Mode</span>
      <select id="b-mode">
        <option value="auto">Autonomous — build, then heal and evolve continuously</option>
        <option value="auto-build">Autonomous, build only — stop once deployed</option>
        <option value="build">Build once — no healing loop</option>
      </select>
      <div class="hint">Spend is capped by the budgets in factory.config.json. Watch it on the Cost page.</div>
    </label>`,
    `<button class="btn" id="b-cancel">Cancel</button><button class="btn primary" id="b-go">Start build</button>`);

  $("#b-cancel").addEventListener("click", closeModal);
  $("#b-prompt").focus();
  $("#b-go").addEventListener("click", async () => {
    const prompt = $("#b-prompt").value.trim();
    const name = $("#b-name").value.trim();
    const choice = $("#b-mode").value;
    if (!prompt) { toast("Describe what you want built.", "error"); return; }

    $("#b-go").disabled = true;
    $("#b-go").textContent = "Starting…";
    try {
      const run = await api("/api/builds", {
        method: "POST",
        body: JSON.stringify({
          prompt, name: name || undefined,
          mode: choice === "build" ? "build" : "auto",
          buildOnly: choice === "auto-build",
        }),
      });
      closeModal();
      toast(`Build started for ${run.app}`, "ok");
      state.app = run.app;
      setTimeout(() => go("app", run.app), 400);
    } catch (err) {
      toast(err.message, "error");
      $("#b-go").disabled = false;
      $("#b-go").textContent = "Start build";
    }
  });
}

// ---------------------------------------------------------------- events

document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-view], [data-app], [data-tab], [data-log], [data-doc], [data-retry], [data-stop-run], [data-run-log], [data-stop-app], [data-rearm], [data-start], [data-incident]");
  if (!t) return;

  if (t.dataset.view) return go(t.dataset.view);
  if (t.dataset.app) return go("app", t.dataset.app);
  if (t.dataset.incident !== undefined) return go("incidents");

  if (t.dataset.tab) {
    state.tab = t.dataset.tab;
    if (state.tab === "logs" && !state.logName) state.logName = "app.log";
    return render();
  }

  if (t.dataset.log) { state.logName = t.dataset.log; render(); return loadLog(); }

  if (t.dataset.doc) {
    const el = $("#doc-view");
    if (el) el.textContent = "Loading…";
    try {
      const text = await api(`/api/apps/${encodeURIComponent(state.app)}/doc/${encodeURIComponent(t.dataset.doc)}`);
      if ($("#doc-view")) $("#doc-view").textContent = String(text);
    } catch (err) { toast(err.message, "error"); }
    return;
  }

  if (t.dataset.runLog) return showRunLog(t.dataset.runLog);

  if (t.dataset.retry) {
    try { await api(`/api/incidents/${t.dataset.retry}/retry`, { method: "POST" }); toast("Incident re-armed", "ok"); refresh(); }
    catch (err) { toast(err.message, "error"); }
    return;
  }

  if (t.dataset.stopRun) {
    if (!confirm("Stop this pipeline run? Work already committed is kept.")) return;
    try { await api(`/api/runs/${encodeURIComponent(t.dataset.stopRun)}/stop`, { method: "POST" }); toast("Run stopped"); refresh(); }
    catch (err) { toast(err.message, "error"); }
    return;
  }

  if (t.dataset.stopApp) {
    try { await api(`/api/apps/${encodeURIComponent(state.app)}/stop`, { method: "POST" }); toast("Application stopped"); loadDetail(); }
    catch (err) { toast(err.message, "error"); }
    return;
  }

  if (t.dataset.rearm) {
    try { await api(`/api/apps/${encodeURIComponent(state.app)}/rearm`, { method: "POST" }); toast("Parked stages re-armed", "ok"); loadDetail(); }
    catch (err) { toast(err.message, "error"); }
    return;
  }

  if (t.dataset.start) {
    const mode = t.dataset.start;
    if (!confirm(`Start a ${mode} run for ${state.app}? This spends against your budget.`)) return;
    try {
      await api("/api/builds", { method: "POST", body: JSON.stringify({ name: state.app, mode }) });
      toast(`${mode} run started`, "ok");
      loadDetail();
    } catch (err) { toast(err.message, "error"); }
  }
});

document.addEventListener("change", (e) => {
  if (e.target.id === "follow") state.logFollow = e.target.checked;
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
  if (e.key === "n" && !/input|textarea|select/i.test(e.target.tagName)) { e.preventDefault(); newBuildModal(); }
});

$("#new-build").addEventListener("click", newBuildModal);
document.addEventListener("click", (e) => { if (e.target.id === "empty-new") newBuildModal(); });
document.addEventListener("click", (e) => { if (e.target.id === "log-refresh") loadLog(); });

$("#theme-toggle").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("factory-theme", next); } catch { /* private mode */ }
});

// ---------------------------------------------------------------- live data

function apply(data) {
  state.data = data;
  if (state.view === "app") {
    // Keep the detail page fresh without stealing focus or scroll from a log tail.
    loadDetail();
    updateChrome();
  } else {
    render();
  }
}

async function refresh() {
  try { apply(await api("/api/overview")); }
  catch (err) { toast(`Cannot reach the factory: ${err.message}`, "error"); }
}

function setLive(on, text) {
  state.connected = on;
  const el = $("#live");
  el.className = `live ${on ? "on" : "off"}`;
  $("#live-text").textContent = text;
}

function connect() {
  const source = new EventSource("/api/stream");
  source.addEventListener("overview", (e) => {
    setLive(true, "live");
    try { apply(JSON.parse(e.data)); } catch { /* malformed frame */ }
  });
  source.onopen = () => setLive(true, "live");
  source.onerror = () => {
    setLive(false, "reconnecting");
    // EventSource reconnects on its own; this only reports the gap.
  };
}

function readHash() {
  const m = location.hash.match(/^#\/app\/(.+)$/);
  if (m) { state.view = "app"; state.app = decodeURIComponent(m[1]); loadDetail(); return; }
  const view = location.hash.replace(/^#\//, "");
  state.view = VIEWS[view] ? view : "overview";
}

window.addEventListener("hashchange", () => { readHash(); render(); });

try {
  const saved = localStorage.getItem("factory-theme");
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* private mode */ }

readHash();
refresh().then(connect);
setInterval(() => { if (state.view === "app" && state.tab === "logs") loadLog(); }, 3000);
