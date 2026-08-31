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
  // Anything the reader picked lives here rather than in the DOM. A live stream
  // repaints this page every couple of seconds; state kept only in the document
  // is state the next frame throws away.
  doc: null,         // { name, text } of the document being read
  drawer: null,      // { kind, id, ... } of the detail panel that is open
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
  if (!v) return "$0";
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

const MARK = { passed: "✓", running: "●", failed: "✕", needs_human: "!", pending: "·" };

/** Stage names are capitalized in CSS, which would render "qa" as "Qa". */
const STAGE_LABEL = { qa: "QA" };

/**
 * The agent contract a stage writes, where it is not simply `<stage>.json`.
 * The architect writes the task DAG as tasks.json and development reports as
 * dev-report.json, so a plain name lookup would find neither.
 */
const STAGE_OUT = { architecture: "tasks", development: "dev-report" };

/** Elapsed time for one stage, from the timestamps the state file already keeps. */
function duration(rec) {
  if (!rec?.startedAt) return "";
  const end = rec.finishedAt ? Date.parse(rec.finishedAt) : Date.now();
  const secs = (end - Date.parse(rec.startedAt)) / 1000;
  if (!Number.isFinite(secs) || secs < 0) return "";
  if (secs < 60) return `${Math.round(secs)}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m${String(Math.round(secs % 60)).padStart(2, "0")}`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, "0")}`;
}

/** The stage that most deserves a reader's attention right now. */
function currentStage(stages) {
  const list = stages ?? [];
  return list.find((s) => s.status === "running")
    ?? list.find((s) => s.status === "failed" || s.status === "needs_human")
    ?? list.find((s) => s.status !== "passed");
}

/**
 * The one line of context that makes a stage row worth reading. A note from the
 * stage itself always wins - it is the only text written about this specific run.
 */
function stageDetail(name, rec, app) {
  if (rec.notes) return esc(rec.notes);
  const bits = [];
  if (name === "architecture" && app?.stack?.label && rec.status === "passed") bits.push(esc(app.stack.label));
  if (name === "development" && app?.tasks?.total) {
    bits.push(`${app.tasks.done}/${app.tasks.total} tasks`);
    if (app.tasks.failed) bits.push(`${app.tasks.failed} failed`);
  }
  if (name === "deploy" && app?.port && rec.status === "passed") bits.push(`port ${app.port}`);
  if (rec.iterations > 1) bits.push(`<span class="aside">×${rec.iterations} iterations</span>`);
  return bits.join(" · ");
}

/**
 * The pipeline, set as a ledger: one line per stage, with the time it took and
 * what it did. This is the most distinctive thing the factory has, so it gets the
 * room to say something rather than being nine dots in a row.
 */
function stageLedger(stages, app) {
  const byName = new Map((stages ?? []).map((s) => [s.name, s]));
  const current = currentStage(stages);

  return `<div class="ledger">${STAGES.map((name) => {
    const rec = byName.get(name) ?? { name, status: "pending", iterations: 0 };
    const isCurrent = current?.name === name;
    const tone = rec.status === "failed" ? "failed-row" : rec.status === "needs_human" ? "warn-row" : "";
    return `<div class="ledger-row ${isCurrent ? "is-current" : ""} ${rec.status === "pending" ? "is-pending" : ""} ${tone}"
                 data-stage="${esc(name)}" title="${esc(name)}: ${esc(rec.status)}">
      <div class="ledger-mark ${esc(rec.status)}">${MARK[rec.status] ?? "·"}</div>
      <div class="ledger-name">${esc(STAGE_LABEL[name] ?? name)}</div>
      <div class="ledger-time">${esc(duration(rec))}</div>
      <div class="ledger-detail">${stageDetail(name, rec, app)}</div>
    </div>`;
  }).join("")}</div>`;
}

/** The compact form for a card in a list: one segment per stage, no words. */
function stageRail(stages) {
  const byName = new Map((stages ?? []).map((s) => [s.name, s]));
  return `<div class="rail">${STAGES.map((name) => {
    const status = byName.get(name)?.status ?? "pending";
    return `<span class="rail-seg ${esc(status)}" title="${esc(name)}: ${esc(status)}"></span>`;
  }).join("")}</div>`;
}

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

function empty(title, body, action = "") {
  return `<div class="empty"><h3>${esc(title)}</h3><p>${esc(body)}</p>${action}</div>`;
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
      <div class="card-head"><h2>In progress</h2>
        <span class="sub">${active.length === 1 ? "one build running" : `${active.length} builds running`}</span></div>
      <div class="card-body">
        ${active.map((a) => `
          <div class="mb">
            <div class="row mb clickable" data-app="${esc(a.name)}">
              <span class="app-name">${esc(a.name)}</span>
              ${pill(a.current?.status ?? "running")}
              <span class="faint small">${esc(a.run.mode)} · started ${ago(a.run.startedAt)}</span>
              <span class="right faint small mono">${money(a.costUsd)}</span>
            </div>
            ${stageLedger(a.stages, a)}
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
            ? empty("No applications yet", "Describe what you want built and the factory will take it from there.",
                `<button class="btn primary" id="empty-new">New build</button>`)
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
            ? empty("No incidents", "Nothing has crashed. Errors reported by a running app appear here.")
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
    return `<div class="view">${empty(
      "No applications yet",
      "Describe what you want built. The factory chooses the stack, writes it, tests it, deploys it and keeps it healthy.",
      `<button class="btn primary" id="empty-new">New build</button>`)}</div>`;
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
        ${stageRail(a.stages)}
        <div class="app-meta">
          <span class="item">${esc(a.stack.label)}</span>
          <span class="item">${a.tasks.done}/${a.tasks.total} tasks</span>
          ${a.port ? `<span class="item">${a.serving ? "serving" : "stopped"} :${a.port}</span>` : ""}
          ${a.incidents.open + a.incidents.healing > 0 ? `<span class="item" style="color:var(--warn)">${a.incidents.open + a.incidents.healing} open</span>` : ""}
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
          <span class="faint small">${esc(a.stack.label)}${a.stack.framework && !a.stack.label.includes(a.stack.framework) ? ` · ${esc(a.stack.framework)}` : ""}</span>
          ${a.port ? `<span class="faint small">${a.serving ? "serving on" : "stopped ·"} <a href="http://localhost:${a.port}" target="_blank" rel="noreferrer">:${a.port}</a></span>` : ""}
          ${a.repoUrl ? `<a class="small" href="https://github.com/${esc(a.repoUrl)}" target="_blank" rel="noreferrer">${esc(a.repoUrl)}</a>` : `<span class="faint small">local only</span>`}
          <span class="right row">
            ${a.run
              ? `<button class="btn sm danger" data-stop-run="${esc(a.run.id)}">Stop run</button>`
              : `<button class="btn sm" data-start="resume">Resume</button>
                 <button class="btn sm" data-start="auto">Autonomous</button>
                 <button class="btn sm" data-start="evolve">Evolve</button>`}
            ${a.serving ? `<button class="btn sm" data-stop-app="1">Stop app</button>` : ""}
            <button class="btn sm" data-rearm="1" title="Put parked stages back on the board">Re-arm</button>
          </span>
        </div>
        <div class="standfirst">${esc(a.prompt)}</div>
      </div>
      <div class="tabs">
        ${tabs.map((t) => `<button class="tab ${state.tab === t ? "active" : ""}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
      </div>
      <div class="card-body ${state.tab === "logs" || state.tab === "docs" ? "flush" : ""}">${body(a)}</div>
    </div>
  </div>`;
}

function tabFlow(a) {
  const done = a.stages.filter((s) => s.status === "passed").length;
  const current = currentStage(a.stages);
  // The ledger already carries status, duration, runs and notes for every stage,
  // so the old stage-history table said the same thing again in a worse form.
  const note = current?.notes
    ? `<div class="flow-note ${current.status === "failed" ? "failed" : current.status === "needs_human" ? "warn" : ""}">
         <strong>${esc(current.name)}</strong> — ${esc(current.notes)}</div>`
    : "";

  return `
    ${stageLedger(a.stages, a)}
    ${note}
    <div class="grid stats mt">
      <div class="stat"><div class="stat-label">Stages</div><div class="stat-value">${done}<span class="faint">/${a.stages.length}</span></div></div>
      <div class="stat"><div class="stat-label">Tasks</div><div class="stat-value">${a.tasks.done}<span class="faint">/${a.tasks.total}</span></div>
        <div class="stat-meta">${a.tasks.failed} failed · ${a.tasks.pending} pending</div></div>
      <div class="stat"><div class="stat-label">Incidents</div><div class="stat-value ${a.incidents.length ? "warn" : ""}">${a.incidents.length}</div></div>
      <div class="stat"><div class="stat-label">Spent</div><div class="stat-value">${money(a.costUsd)}</div></div>
    </div>
    ${a.criteria?.length ? `
      <div class="subhead">Acceptance criteria</div>
      <table><tbody>${a.criteria.map((c) => `
        <tr><td class="mono faint" style="width:64px">${esc(c.id)}</td><td>${esc(c.description)}</td></tr>`).join("")}
      </tbody></table>` : ""}
    ${a.assumptions?.length ? `
      <div class="subhead">Assumptions the factory made</div>
      <ul class="dim" style="font-size:13px;padding-left:18px;margin:0">
        ${a.assumptions.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}`;
}

function tabTasks(a) {
  if (!a.taskList.length) return empty("No tasks yet", "The architect stage produces the work breakdown.");
  return `<table><thead><tr><th>ID</th><th>Title</th><th>Status</th><th>Depends on</th></tr></thead><tbody>
    ${a.taskList.map((t) => `<tr class="clickable" data-task="${esc(t.id)}">
      <td class="mono faint">${esc(t.id)}</td>
      <td><strong>${esc(t.title)}</strong><div class="faint small truncate">${esc(t.description ?? "")}</div></td>
      <td>${pill(t.status)}</td>
      <td class="faint mono small">${esc((t.dependsOn ?? []).join(", ") || "—")}</td>
    </tr>`).join("")}</tbody></table>`;
}

function tabDefects(a) {
  if (!a.defects.length) return empty("No defects recorded", "Findings from QA, review, security and validation appear here.");
  return `<table><thead><tr><th>Source</th><th>Severity</th><th>Title</th><th>Detail</th></tr></thead><tbody>
    ${a.defects.map((d, i) => `<tr class="clickable" data-defect="${i}">
      <td class="faint">${esc(d.source)}</td>
      <td><span class="pill sev-${esc(d.severity)}">${esc(d.severity)}</span></td>
      <td><strong>${esc(d.title)}</strong></td>
      <td class="dim truncate">${esc(d.detail ?? "")}</td>
    </tr>`).join("")}</tbody></table>`;
}

function tabIncidents(a) {
  if (!a.incidents.length) return empty("No incidents", "Runtime errors reported by this app appear here and trigger healing.");
  return incidentTable(a.incidents);
}

function incidentTable(list) {
  return `<table><thead><tr><th>#</th><th>Status</th><th>Error</th><th>Seen</th><th>Attempts</th><th>Fix</th><th></th></tr></thead><tbody>
    ${list.map((i) => `<tr class="clickable" data-incident="${i.id}">
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

/**
 * Markdown, rendered from text that has *already* been escaped.
 *
 * These documents are agent output, so the order matters: esc() first, then match
 * only on the escaped text and emit a fixed set of tags. Nothing here can
 * reintroduce markup, because by the time a pattern runs there is no live "<"
 * left in the string.
 */
function renderMarkdown(text) {
  const lines = esc(String(text)).split("\n");
  const out = [];
  let inCode = false;
  let inList = false;

  const closeList = () => { if (inList) { out.push("</ul>"); inList = false; } };

  for (const line of lines) {
    if (/^```/.test(line)) {
      closeList();
      out.push(inCode ? "</code></pre>" : `<pre class="md-code"><code>`);
      inCode = !inCode;
      continue;
    }
    if (inCode) { out.push(line); continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<h${heading[1].length} class="md-h">${inline(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const item = line.match(/^\s*[-*]\s+(.*)$/);
    if (item) {
      if (!inList) { out.push("<ul class=\"md-list\">"); inList = true; }
      out.push(`<li>${inline(item[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim() === "") out.push("");
    else out.push(`<p class="md-p">${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }
}

function tabDocs(a) {
  if (!a.docs.length) return empty("No documents yet", "requirements.md and architecture.md appear once those stages run.");
  const sel = state.doc;
  return `<div class="doc-wrap">
    <div class="doc-list">
      ${a.docs.map((d) => `<div class="log-entry ${sel?.name === d.name ? "active" : ""}" data-doc="${esc(d.name)}">
        <div class="n">${esc(d.name)}</div><div class="m">${bytes(d.size)}</div></div>`).join("")}
    </div>
    <div class="doc-view">${
      sel ? (sel.text === null ? `<p class="md-p faint">Loading…</p>` : renderMarkdown(sel.text))
          : `<p class="md-p faint">Select a document.</p>`
    }</div>
  </div>`;
}

function tabCost(a) {
  const all = [...(a.spendByStage ?? []), ...(a.spendByRole ?? [])];
  const max = Math.max(1, ...all.map((g) => g.costUsd));

  const table = (list, label) => !list?.length ? "" : `
    <div class="subhead">${label}</div>
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
          <button class="btn sm ghost" id="log-refresh">Refresh</button>
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
          : empty("No incidents", "When a deployed app throws, it is fingerprinted, deduplicated and healed here.")}
      </div>
    </div>
  </div>`;
}

function viewRuns() {
  const d = state.data;
  if (!d) return "";
  if (!d.runs.length) {
    return `<div class="view">${empty(
      "No pipeline runs yet", "Runs started from this dashboard appear here with their live output.",
      `<button class="btn primary" id="empty-new">New build</button>`)}</div>`;
  }
  return `<div class="view"><div class="card">
    <div class="card-head"><h2>Pipeline runs</h2></div>
    <div class="card-body flush">
      <table><thead><tr><th>App</th><th>Mode</th><th>Status</th><th>Started</th><th>PID</th><th></th></tr></thead><tbody>
        ${d.runs.map((r) => `<tr class="clickable" data-run-log="${esc(r.id)}">
          <td><strong>${esc(r.app)}</strong>${r.prompt ? `<div class="faint small truncate">${esc(r.prompt)}</div>` : ""}</td>
          <td class="faint">${esc(r.mode)}</td>
          <td>${r.finishedAt ? pill("idle", "finished") : pill("running")}</td>
          <td class="faint nowrap">${ago(r.startedAt)}</td>
          <td class="mono faint">${r.pid}</td>
          <td class="row" style="justify-content:flex-end">
            <button class="btn sm" data-app="${esc(r.app)}">Open app</button>
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
      <table><tbody>${list.map((g) => `<tr ${label === "By application" ? `class="clickable" data-app="${esc(g.key)}"` : ""}>
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
        <td class="faint mono small">${esc(r.provider ? `${r.provider} · ` : "")}${esc(r.model)}</td>
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
    <div class="card-head"><h2>Configuration</h2><span class="sub">new pipelines use the selection below</span></div>
    <div class="card-body">
      <form id="agent-config" class="config-form">
        <label>Provider
          <select id="agent-provider" name="provider">
            <option value="claude" ${c.provider === "claude" ? "selected" : ""}>Claude</option>
            <option value="codex" ${c.provider === "codex" ? "selected" : ""}>Codex</option>
          </select>
        </label>
        <label>Model
          <select id="agent-model" name="model">${modelOptions(c)}</select>
        </label>
        <label id="custom-model-wrap" class="custom-model-wrap" ${isKnownModel(c) ? "hidden" : ""}>Custom model ID
          <input id="agent-custom-model" name="customModel" maxlength="128" value="${isKnownModel(c) ? "" : esc(c.model)}" autocomplete="off" spellcheck="false">
        </label>
        <button class="btn primary" type="submit">Save agent settings</button>
      </form>
      <p class="hint">This changes the default for future pipelines. A running pipeline keeps the provider and model it was started with.</p>
      <dl class="kv">
        <dt>Current agent</dt><dd class="mono">${esc(c.provider)} · ${esc(c.model)}</dd>
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

function isKnownModel(config) {
  return (config.modelCatalog?.[config.provider] ?? []).some((m) => m.id === config.model);
}

function modelOptions(config) {
  const models = config.modelCatalog?.[config.provider] ?? [];
  const known = models.some((m) => m.id === config.model);
  return models.map((m) => `<option value="${esc(m.id)}" ${m.id === config.model ? "selected" : ""}>${esc(m.label)} — ${esc(m.detail)}</option>`).join("")
    + (!known ? `<option value="__custom__" selected>Current custom model</option>` : "")
    + `<option value="__custom__">Custom model ID…</option>`;
}

function syncModelChoices() {
  const select = $("#agent-model");
  const provider = $("#agent-provider")?.value;
  const config = state.data?.config;
  if (!select || !provider || !config) return;
  const models = config.modelCatalog?.[provider] ?? [];
  select.innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)} — ${esc(m.detail)}</option>`).join("")
    + `<option value="__custom__">Custom model ID…</option>`;
  select.value = models[0]?.id ?? "__custom__";
  $("#custom-model-wrap").hidden = select.value !== "__custom__";
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

/** The markup currently in #content, so an unchanged frame writes nothing. */
let painted = "";

/**
 * Paint the current view.
 *
 * A live page that rebuilds its whole document every couple of seconds destroys
 * whatever the reader was doing: the scroll position, the text they were
 * selecting, and - before the selection moved into `state` - the document they
 * had open. So this only touches the DOM when the markup actually differs, which
 * means a tab whose content did not change is never repainted at all, and it
 * restores the scroll offsets when it does have to write.
 */
function render() {
  const view = VIEWS[state.view] ?? VIEWS.overview;
  $("#title").textContent = state.view === "app" ? (state.app ?? "Application") : view.title;
  $("#crumb").textContent = state.view === "app" ? "· application" : "";

  const html = view.render();
  const el = $("#content");
  if (html !== painted) {
    const outer = el.scrollTop;
    const pane = el.querySelector(".log-view, .doc-view");
    const inner = pane?.scrollTop ?? 0;
    el.innerHTML = html;
    painted = html;
    el.scrollTop = outer;
    const next = el.querySelector(".log-view, .doc-view");
    if (next) next.scrollTop = inner;
  }

  document.querySelectorAll(".nav-item").forEach((el) => {
    const target = state.view === "app" ? "apps" : state.view;
    el.classList.toggle("active", el.dataset.view === target);
  });

  if (state.view === "app" && state.tab === "logs" && state.logName) loadLog();
  // An open drawer tracks the same data, so a stage that finishes while you are
  // reading it updates in place rather than going stale behind the panel.
  renderDrawer();
  updateChrome();
}

function updateChrome() {
  const d = state.data;
  if (!d) return;
  $("#c-apps").textContent = d.apps.length || "";
  const open = d.incidents.open + d.incidents.healing;
  $("#c-incidents").textContent = open || "";
  $("#c-runs").textContent = d.activeRuns || "";
  $("#f-model").textContent = `${d.config.provider} · ${d.config.model}`;
  $("#f-sandbox").textContent = d.config.sandbox ? "on" : "off";
  $("#f-budget").textContent = d.config.budgets ? "on" : "off";
}

/** The URL for wherever we are now, so every view and tab is linkable. */
function hashFor() {
  if (state.view !== "app") return `#/${state.view}`;
  return `#/app/${encodeURIComponent(state.app)}${state.tab && state.tab !== "flow" ? `/${state.tab}` : ""}`;
}

/** Update the address bar without letting hashchange re-enter and re-render. */
let ownHash = "";
function setHash() {
  ownHash = hashFor();
  if (location.hash !== ownHash) location.hash = ownHash;
}

function go(view, app, tab) {
  const changedApp = app && app !== state.app;
  state.view = view;
  if (app) state.app = app;
  if (view === "app") {
    state.tab = tab ?? "flow";
    if (changedApp) { state.logName = null; state.doc = null; state.detail = null; }
    loadDetail();
  }
  setHash();
  render();
}

/** Read one document into state, where a repaint cannot lose it. */
async function openDoc(name) {
  state.doc = { name, text: null };
  render();
  try {
    const text = await api(`/api/apps/${encodeURIComponent(state.app)}/doc/${encodeURIComponent(name)}`);
    if (state.doc?.name === name) { state.doc.text = String(text); render(); }
  } catch (err) {
    state.doc = null;
    toast(err.message, "error");
    render();
  }
}

async function loadDetail() {
  if (!state.app) return;
  try {
    state.detail = await api(`/api/apps/${encodeURIComponent(state.app)}`);
    // Arriving on the docs tab by link should show a document, not a chooser.
    if (state.view === "app" && state.tab === "docs" && !state.doc && state.detail.docs?.length) {
      return openDoc(state.detail.docs[0].name);
    }
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

// ---------------------------------------------------------------- drawer
//
// Every list on this page used to be a dead end: a stage, an incident, a task or
// a defect could be read only in the one truncated row it occupied. The drawer is
// the destination for all four. It lives outside #content so the memoized repaint
// of the main view neither rebuilds it nor loses its scroll.

/** Transcripts an app has for one stage: `<stage>-<timestamp>.log`. */
function logsForStage(a, stage) {
  return (a.logs ?? []).filter((l) => l.name.startsWith(`${stage}-`));
}

function kv(rows) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!shown.length) return "";
  return `<dl class="kv">${shown.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
}

function drawerStage(a) {
  const stage = state.drawer.id;
  const rec = (a.stages ?? []).find((s) => s.name === stage) ?? { status: "pending", iterations: 0 };
  const transcripts = logsForStage(a, stage);
  const spend = (a.spendByStage ?? []).find((g) => g.key === stage);
  const defects = (a.defects ?? []).filter((d) => d.source === stage);
  const out = state.drawer.out;

  return `
    ${kv([
      ["Status", pill(rec.status)],
      ["Elapsed", duration(rec) ? `<span class="mono">${esc(duration(rec))}</span>` : "—"],
      ["Runs", `${rec.iterations}${rec.iterations > 1 ? " <span class=\"faint\">(the gate sent work back)</span>" : ""}`],
      ["Started", rec.startedAt ? esc(ago(rec.startedAt)) : ""],
      ["Finished", rec.finishedAt ? esc(ago(rec.finishedAt)) : ""],
      ["Cost", spend ? `<span class="mono">${money(spend.costUsd)}</span> <span class="faint">over ${spend.runs} agent run${spend.runs === 1 ? "" : "s"}</span>` : ""],
    ])}
    ${rec.notes ? `<div class="flow-note ${rec.status === "failed" ? "failed" : rec.status === "needs_human" ? "warn" : ""}">${esc(rec.notes)}</div>` : ""}

    ${defects.length ? `<div class="subhead">Defects this stage found</div>
      ${defects.map((d) => `<div class="drawer-item">
        <div class="row"><span class="pill sev-${esc(d.severity)}">${esc(d.severity)}</span>
          <strong>${esc(d.title)}</strong></div>
        <p class="drawer-text">${esc(d.detail ?? "")}</p>
        ${d.suggestedFix ? `<p class="drawer-text faint">Suggested: ${esc(d.suggestedFix)}</p>` : ""}
      </div>`).join("")}` : ""}

    ${out ? `<div class="subhead">${esc(out.name)}.json <span class="faint">— what the agent returned</span></div>
      <pre class="md-code">${esc(out.text ?? "Loading…")}</pre>` : ""}

    <div class="subhead">Agent transcripts</div>
    ${transcripts.length
      ? `<div class="drawer-list">${transcripts.map((l) => `
          <div class="log-entry" data-drawer-log="${esc(l.name)}">
            <div class="n">${esc(l.name)}</div>
            <div class="m">${bytes(l.size)} · ${ago(l.modified)}</div>
          </div>`).join("")}</div>
         <p class="drawer-text faint">Opens in the Logs tab.</p>`
      : `<p class="drawer-text faint">No transcript recorded for this stage yet.</p>`}`;
}

function drawerIncident() {
  const i = state.drawer.data;
  if (!i) return `<p class="drawer-text faint">Loading…</p>`;
  const ev = i.sampleEvent ?? {};
  return `
    ${kv([
      ["Status", pill(i.status)],
      ["Occurrences", `${i.count}`],
      ["First seen", esc(ago(i.firstSeen))],
      ["Last seen", esc(ago(i.lastSeen))],
      ["Heal attempts", `${i.attempts}${i.rearms ? ` <span class="faint">· re-armed ${i.rearms}×</span>` : ""}`],
      ["Fingerprint", `<span class="mono">${esc(i.fingerprint)}</span>`],
      ["Release", ev.release ? `<span class="mono">${esc(ev.release)}</span>` : ""],
      ["Fix", i.prUrl ? `<a href="${esc(i.prUrl)}" target="_blank" rel="noreferrer">pull request</a>`
        : i.branch ? `<span class="mono">${esc(i.branch)}</span>` : ""],
    ])}
    ${i.lastNote ? `<div class="flow-note">${esc(i.lastNote)}</div>` : ""}

    <div class="subhead">${esc(ev.type ?? "Error")}</div>
    <p class="drawer-text">${esc(ev.message ?? "")}</p>

    ${ev.stack ? `<div class="subhead">Stack</div><pre class="md-code">${esc(ev.stack)}</pre>` : ""}
    ${ev.context && Object.keys(ev.context).length
      ? `<div class="subhead">Request context</div><pre class="md-code">${esc(JSON.stringify(ev.context, null, 2))}</pre>` : ""}
    ${i.status === "failed" ? `<button class="btn" data-retry="${i.id}">Re-arm this incident</button>` : ""}`;
}

function drawerTask(a) {
  const t = (a.taskList ?? []).find((x) => x.id === state.drawer.id);
  if (!t) return `<p class="drawer-text faint">This task is no longer in the plan.</p>`;
  const deps = (t.dependsOn ?? []).map((id) => (a.taskList ?? []).find((x) => x.id === id)).filter(Boolean);
  const blocks = (a.taskList ?? []).filter((x) => (x.dependsOn ?? []).includes(t.id));
  const link = (x) => `<div class="drawer-item clickable" data-task="${esc(x.id)}">
      <div class="row"><span class="mono faint">${esc(x.id)}</span> ${pill(x.status)}</div>
      <div>${esc(x.title)}</div></div>`;

  return `
    ${kv([["Status", pill(t.status)], ["ID", `<span class="mono">${esc(t.id)}</span>`]])}
    <div class="subhead">What it covers</div>
    <p class="drawer-text">${esc(t.description ?? "")}</p>
    ${t.acceptance?.length ? `<div class="subhead">Acceptance</div>
      <ul class="md-list">${t.acceptance.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
    ${deps.length ? `<div class="subhead">Waits on</div>${deps.map(link).join("")}` : ""}
    ${blocks.length ? `<div class="subhead">Blocks</div>${blocks.map(link).join("")}` : ""}`;
}

function drawerDefect(a) {
  const d = (a.defects ?? [])[state.drawer.id];
  if (!d) return `<p class="drawer-text faint">This defect is no longer recorded.</p>`;
  return `
    ${kv([["Severity", `<span class="pill sev-${esc(d.severity)}">${esc(d.severity)}</span>`],
          ["Found by", esc(d.source)]])}
    <div class="subhead">${esc(d.title)}</div>
    <p class="drawer-text">${esc(d.detail ?? "")}</p>
    ${d.suggestedFix ? `<div class="subhead">Suggested fix</div><p class="drawer-text">${esc(d.suggestedFix)}</p>` : ""}`;
}

const DRAWERS = {
  stage: { title: (d) => `${STAGE_LABEL[d.id] ?? cap(d.id)} stage`, render: drawerStage },
  incident: { title: (d) => `Incident #${d.id}`, render: drawerIncident },
  task: { title: (d) => `Task ${d.id}`, render: drawerTask },
  defect: { title: () => "Defect", render: drawerDefect },
};

let drawerPainted = "";

function renderDrawer() {
  const host = $("#drawer-host");
  const d = state.drawer;
  if (!d) {
    if (drawerPainted !== "") { host.innerHTML = ""; drawerPainted = ""; }
    return;
  }
  const spec = DRAWERS[d.kind];
  const html = `
    <div class="drawer-mask" id="drawer-mask"></div>
    <aside class="drawer" role="dialog" aria-modal="true">
      <div class="drawer-head">
        <h2>${esc(spec.title(d))}</h2>
        <span class="right"><button class="btn sm ghost" id="drawer-x">Close</button></span>
      </div>
      <div class="drawer-body">${spec.render(state.detail ?? {})}</div>
    </aside>`;
  if (html === drawerPainted) return;
  const body = host.querySelector(".drawer-body");
  const scroll = body?.scrollTop ?? 0;
  host.innerHTML = html;
  drawerPainted = html;
  const next = host.querySelector(".drawer-body");
  if (next) next.scrollTop = scroll;
}

function openDrawer(kind, id) {
  state.drawer = { kind, id };
  renderDrawer();

  // A stage shows the JSON its agent returned, when that stage wrote one.
  if (kind === "stage") {
    const want = STAGE_OUT[id] ?? id;
    const outName = (state.detail?.outs ?? []).find((o) => o.name === want)?.name;
    if (outName) {
      state.drawer.out = { name: outName, text: null };
      renderDrawer();
      api(`/api/apps/${encodeURIComponent(state.app)}/out/${encodeURIComponent(outName)}`)
        .then((text) => {
          if (state.drawer?.kind === "stage" && state.drawer.id === id) {
            state.drawer.out.text = typeof text === "string" ? text : JSON.stringify(text, null, 2);
            renderDrawer();
          }
        })
        .catch(() => { /* the stage simply has no output yet */ });
    }
  }

  // An incident may not be in the overview's recent handful, so fetch it in full.
  if (kind === "incident") {
    const known = (state.data?.incidents?.recent ?? []).find((x) => String(x.id) === String(id))
      ?? (state.detail?.incidents ?? []).find((x) => String(x.id) === String(id));
    state.drawer.data = known ?? null;
    renderDrawer();
    api(`/api/incidents/${encodeURIComponent(id)}`)
      .then((data) => {
        if (state.drawer?.kind === "incident" && String(state.drawer.id) === String(id)) {
          state.drawer.data = data;
          renderDrawer();
        }
      })
      .catch(() => { /* keep whatever the list already gave us */ });
  }
}

function closeDrawer() {
  state.drawer = null;
  renderDrawer();
}

// ---------------------------------------------------------------- modal

let modalCleanup = null;

function openModal(title, body, footer) {
  $("#modal-host").innerHTML = `
    <div class="overlay" id="overlay">
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h2>${title}</h2>
          <span class="right"><button class="btn sm ghost" id="modal-x">Close</button></span></div>
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
  if (e.target.id === "drawer-x" || e.target.id === "drawer-mask") return closeDrawer();

  const t = e.target.closest("[data-view], [data-app], [data-tab], [data-log], [data-doc], [data-retry], [data-stop-run], [data-run-log], [data-stop-app], [data-rearm], [data-start], [data-incident], [data-stage], [data-task], [data-defect], [data-drawer-log]");
  if (!t) return;

  if (t.dataset.view) return go(t.dataset.view);
  if (t.dataset.app) return go("app", t.dataset.app);

  // The drill-downs. Each of these used to be a row you could not open.
  if (t.dataset.incident !== undefined) return openDrawer("incident", t.dataset.incident);
  if (t.dataset.stage) return openDrawer("stage", t.dataset.stage);
  if (t.dataset.task) return openDrawer("task", t.dataset.task);
  if (t.dataset.defect !== undefined) return openDrawer("defect", Number(t.dataset.defect));

  if (t.dataset.drawerLog) {
    state.logName = t.dataset.drawerLog;
    state.tab = "logs";
    closeDrawer();
    setHash();
    render();
    return loadLog();
  }

  if (t.dataset.tab) {
    state.tab = t.dataset.tab;
    if (state.tab === "logs" && !state.logName) state.logName = "app.log";
    if (state.tab === "docs" && !state.doc) {
      const first = state.detail?.docs?.[0]?.name;
      if (first) return openDoc(first);
    }
    setHash();
    return render();
  }

  if (t.dataset.log) { state.logName = t.dataset.log; render(); return loadLog(); }

  if (t.dataset.doc) return openDoc(t.dataset.doc);

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
  if (e.target.id === "agent-provider") syncModelChoices();
  if (e.target.id === "agent-model") $("#custom-model-wrap").hidden = e.target.value !== "__custom__";
});

document.addEventListener("submit", async (e) => {
  if (e.target.id !== "agent-config") return;
  e.preventDefault();
  const form = e.target;
  const body = Object.fromEntries(new FormData(form));
  if (body.model === "__custom__") body.model = body.customModel;
  delete body.customModel;
  try {
    await api("/api/config", { method: "POST", body: JSON.stringify(body) });
    toast("Agent settings saved. New pipelines will use them.", "ok");
    await refresh();
  } catch (err) { toast(err.message, "error"); }
});

document.addEventListener("keydown", (e) => {
  // Innermost first: a modal sits above the drawer, so Escape closes that one.
  if (e.key === "Escape") {
    if ($("#overlay")) closeModal();
    else if (state.drawer) closeDrawer();
  }
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

const TABS = ["flow", "tasks", "defects", "incidents", "logs", "docs", "cost"];

function readHash() {
  const m = location.hash.match(/^#\/app\/([^/]+)(?:\/([a-z]+))?$/);
  if (m) {
    const app = decodeURIComponent(m[1]);
    if (app !== state.app) { state.detail = null; state.doc = null; state.logName = null; }
    state.view = "app";
    state.app = app;
    state.tab = TABS.includes(m[2]) ? m[2] : "flow";
    if (state.tab === "logs" && !state.logName) state.logName = "app.log";
    loadDetail();
    return;
  }
  const view = location.hash.replace(/^#\//, "");
  state.view = VIEWS[view] ? view : "overview";
}

window.addEventListener("hashchange", () => {
  // Ignore the echo of our own setHash(); only react to a real navigation.
  if (location.hash === ownHash) return;
  readHash();
  render();
});

try {
  const saved = localStorage.getItem("factory-theme");
  if (saved) document.documentElement.dataset.theme = saved;
} catch { /* private mode */ }

readHash();
refresh().then(connect);
setInterval(() => { if (state.view === "app" && state.tab === "logs") loadLog(); }, 3000);
