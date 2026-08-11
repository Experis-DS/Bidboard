/* ============================================================
   RFP BRIEF RENDERER — v1.1.0
   ------------------------------------------------------------
   A versioned artifact with ONE job: draw a brief from a pack.

   Two consumers:
     • the hub  — imports this module, mounts into #brief
     • /RFP     — fetches this file + renderer.css at build time and
                  inlines both into CLIENT-RFP-Brief.html

   Never author content here. If it isn't in the pack, it doesn't
   render. Every number is derived or absent.
   ============================================================ */

export const RENDERER_VERSION = "1.1.0";
export const SCHEMA_SUPPORT = { min: 1, max: 3 };

/* ---------------- small helpers ---------------- */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const arr = (v) => (Array.isArray(v) ? v : []);
const has = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);

const DAY = 864e5;
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const parseDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };
const daysFromNow = (v) => { const d = parseDate(v); return d === null ? null : Math.ceil((d - today()) / DAY); };

const fmtDate = (v) => {
  const d = parseDate(v);
  return d ? d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric" }).replace(",", "") : "";
};

/* A submission deadline is a FACT stated in the RFP ("5:00 pm EST"), not a moment
   to re-express in whatever timezone the reader happens to be in. When the pack
   carries an explicit offset, render in that offset and name it. */
const fmtDeadline = (v) => {
  const m = /([+-])(\d{2}):(\d{2})$/.exec(String(v));
  const d = parseDate(v);
  if (!d) return "";
  if (!m) return fmtDate(v);
  const off = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const s = new Date(d.getTime() + off * 6e4).toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC",
  }).replace(",", "");
  const mins = Math.abs(off) % 60;
  return `${s} UTC${m[1]}${Number(m[2])}${mins ? ":" + m[3] : ""}`;
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const pct = (x) => Math.round(x * 100);
const bytes = (b) => (!b ? "" : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB");

const STAGES = [
  ["ingested", "Ingested"], ["bid-decision", "Bid decision"], ["workshop", "Workshop"],
  ["drafting", "Drafting"], ["review", "Review"], ["submitted", "Submitted"],
];

/* ============================================================
   DERIVED METRICS
   Pure functions of the pack. Never stored, never typed in.
   Each returns { ok:false, why } when the data is too thin —
   the component then states that in one line instead of showing
   a misleading zero.
   ============================================================ */

export function derive(pack) {
  return {
    readiness: deriveReadiness(pack),
    criticalPath: deriveCriticalPath(pack),
    ownerLoad: deriveOwnerLoad(pack),
    coverage: deriveCoverage(pack),
  };
}

function deriveReadiness(pack) {
  const items = arr(pack.actionItems), reqs = arr(pack.requirements), rules = arr(pack.rules);
  const inputs = [];

  if (items.length) {
    const done = items.filter((i) => i.status === "done").length;
    inputs.push({ key: "Action items complete", value: done / items.length, detail: `${done} of ${items.length}` });
  }
  if (reqs.length) {
    const covered = reqs.filter((r) => r.owner && r.status && r.status !== "open").length;
    inputs.push({ key: "Requirements covered", value: covered / reqs.length, detail: `${covered} of ${reqs.length} owned and moving` });
  }
  if (rules.length) {
    const checked = rules.filter((r) => r.checked).length;
    inputs.push({ key: "Rules & constraints checked", value: checked / rules.length, detail: `${checked} of ${rules.length}` });
  }
  if (!inputs.length) return { ok: false, why: "Readiness unavailable — no items, requirements or rules in the pack" };

  let value = inputs.reduce((s, i) => s + i.value, 0) / inputs.length;

  // Never read above 90% while a mandatory rule is unchecked.
  const openMandatoryRule = rules.some((r) => r.mandatory && !r.checked);
  const capped = openMandatoryRule && value > 0.9;
  if (capped) value = 0.9;

  const gaps = [];
  const unowned = reqs.filter((r) => !r.owner);
  if (unowned.length) gaps.push(`${plural(unowned.length, "requirement")} unowned`);
  const openItems = items.filter((i) => i.status !== "done");
  if (openItems.length) gaps.push(`${plural(openItems.length, "action item")} open`);
  const uncheckedMand = rules.filter((r) => r.mandatory && !r.checked);
  if (uncheckedMand.length) gaps.push(`${plural(uncheckedMand.length, "mandatory rule")} unchecked`);

  const worst = inputs.slice().sort((a, b) => a.value - b.value)[0];
  return { ok: true, value, inputs, gaps, capped, biggestDrag: gaps[0] || `lowest input: ${worst.key.toLowerCase()}` };
}

function deriveCriticalPath(pack) {
  const sub = pack.submission && pack.submission.date;
  const dates = arr(pack.dates).filter((d) => parseDate(d.date));
  if (!sub && !dates.length) return { ok: false, why: "Countdown unavailable — no dates in the pack" };

  const milestones = dates.map((d) => ({ ...d, days: daysFromNow(d.date) }));
  if (sub) milestones.push({ id: "submission", label: "Submission", date: sub, days: daysFromNow(sub), ourAction: pack.submission.method || "" });
  milestones.sort((a, b) => a.days - b.days);

  const upcoming = milestones.filter((m) => m.days >= 0);
  const late = arr(pack.actionItems).filter((i) => i.status !== "done" && daysFromNow(i.due) < 0);
  const subDays = sub ? daysFromNow(sub) : null;
  const nearest = upcoming.find((m) => m.id !== "submission");

  return { ok: true, subDays, nearest, milestones, late };
}

function deriveOwnerLoad(pack) {
  const items = arr(pack.actionItems);
  const roster = arr(pack.roster);
  if (!items.length && !roster.length) return { ok: false, why: "Owner load unavailable — no roster or action items yet" };

  const names = [...new Set([...roster.map((r) => r.name), ...items.map((i) => i.owner).filter(Boolean)])];
  const themes = [...new Set(arr(pack.requirements).map((r) => r.theme).filter(Boolean))];
  const reqTheme = Object.fromEntries(arr(pack.requirements).map((r) => [r.id, r.theme]));

  const open = (n) => items.filter((i) => i.owner === n && i.status !== "done").length;
  const people = names.map((n) => ({ name: n, open: open(n) })).sort((a, b) => b.open - a.open);
  const unassigned = items.filter((i) => !i.owner && i.status !== "done").length;

  const grid = people.map((p) => ({
    name: p.name,
    cells: themes.map((t) => items.filter((i) => i.owner === p.name && i.status !== "done" && reqTheme[i.requirementId] === t).length),
  }));
  const unownedThemes = themes.filter((t) =>
    !items.some((i) => i.owner && reqTheme[i.requirementId] === t) &&
    !arr(pack.requirements).some((r) => r.theme === t && r.owner));

  const idle = people.filter((p) => p.open === 0).map((p) => p.name);
  const busiest = people.length ? people[0].open : 0;
  return { ok: true, people, unassigned, themes, grid, unownedThemes, idle, busiest };
}

function deriveCoverage(pack) {
  const reqs = arr(pack.requirements);
  if (!reqs.length) return { ok: false, why: "Coverage unavailable — no requirements in the pack" };

  const cells = reqs.map((r) => {
    const dueDays = daysFromNow(r.due);
    const atRisk = r.mandatory && r.status !== "done" && (!r.owner || (dueDays !== null && dueDays <= 3));
    const state = atRisk ? "at-risk" : !r.owner ? "unowned" : r.status === "done" ? "done" : r.status === "in-progress" ? "in-progress" : "open";
    return { id: r.id, theme: r.theme || "Ungrouped", state, label: r.text };
  });
  const count = (s) => cells.filter((c) => c.state === s).length;
  return {
    ok: true, total: reqs.length, cells,
    done: count("done"), inProgress: count("in-progress"),
    open: count("open"), unowned: count("unowned"), atRisk: count("at-risk"),
    themes: [...new Set(cells.map((c) => c.theme))],
  };
}

/* ============================================================
   SECTIONS

   `when` decides whether a section exists at all. Omitting an empty
   section beats padding it — a nav full of sections that say
   "nothing captured" makes a thin pack look like a broken tool.
   ============================================================ */

const SECTIONS = [
  { id: "snapshot",     label: "Snapshot",             render: secSnapshot },
  { id: "checklist",    label: "Action Checklist",     render: secChecklist,    when: (p) => has(p.actionItems), count: (p) => arr(p.actionItems).filter((i) => i.status !== "done").length || null },
  { id: "ask",          label: "The Ask",              render: secAsk,          when: (p) => has(p.ask) },
  { id: "dates",        label: "Key Dates",            render: secDates,        when: (p) => has(p.dates) || has(p.submission), count: (p) => arr(p.dates).length || null },
  { id: "rules",        label: "Rules & Constraints",  render: secRules,        when: (p) => has(p.rules), count: (p) => arr(p.rules).length || null },
  { id: "evaluation",   label: "Evaluation",           render: secEvaluation,   when: (p) => has(p.evaluation) },
  { id: "requirements", label: "Requirements",         render: secRequirements, when: (p) => has(p.requirements), count: (p) => arr(p.requirements).length || null },
  { id: "team",         label: "Team & Burden",        render: secTeam,         when: (p) => has(p.team) || has(p.roster) },
  { id: "questions",    label: "Questions for Client", render: secQuestions,    when: (p) => has(p.questions), count: (p) => arr(p.questions).length || null },
  { id: "risks",        label: "Risks & Signals",      render: secRisks,        when: (p) => has(p.risks) || has(p.signals) },
  { id: "decisions",    label: "Decisions",            render: secDecisions,    when: (p) => has(p.decisions) || has(p.parkingLot) || has(p.meetings), count: (p) => arr(p.decisions).length || null },
  { id: "documents",    label: "Document Map",         render: secDocuments,    when: (p) => has(p.documents), count: (p) => arr(p.documents).length || null },
];

/* ---------- 1. Snapshot ---------- */

function secSnapshot(p, d, ctx) {
  const subDays = p.submission ? daysFromNow(p.submission.date) : null;
  const urgent = subDays !== null && subDays <= 7 && subDays >= 0;
  const past = subDays !== null && subDays < 0;

  const deadline = p.submission
    ? `<div class="rb-deadline ${urgent ? "is-urgent" : ""} ${past ? "is-past" : ""}">
         <span class="rb-deadline-label">Submission deadline</span>
         <span class="rb-deadline-value">${esc(fmtDeadline(p.submission.date))}</span>
         <span class="rb-countdown">${past
            ? `closed <b>${Math.abs(subDays)}</b> days ago`
            : `<b>${subDays}</b> ${subDays === 1 ? "day" : "days"} left`}</span>
         ${has(p.submission.format) || has(p.submission.method)
            ? `<span class="rb-deadline-meta">${[p.submission.format, p.submission.method].filter(has).map(esc).join("<br>")}</span>` : ""}
       </div>`
    : `<p class="rb-empty" style="margin-bottom:var(--rb-s4)">No submission deadline captured in the pack.</p>`;

  // Editable in place, like every other piece of prose in the brief. Shown even
  // when empty in edit mode, or there is nothing to click to start writing.
  const askParas = [["ask.summary", p.ask?.summary], ["ask.background", p.ask?.background]]
    .filter(([, t]) => has(t) || ctx.edit)
    .map(([path, t]) => `<p${edIn(ctx, path, "rb-ask")}>${esc(t)}</p>`).join("");

  const verdict = has(p.verdict)
    ? `<div class="rb-zone">
         <div class="rb-zone-head"><span>Our read</span></div>
         <div class="rb-verdict">
           ${[["What this demands", p.verdict.responseType, "verdict.responseType"],
              ["Execution fit", p.verdict.executionFit, "verdict.executionFit"],
              ["What it's really about", p.verdict.reallyAbout, "verdict.reallyAbout"]]
             .filter(([, v]) => has(v) || ctx.edit)
             .map(([k, v, path]) => `<p><b>${k}</b><span${ed(ctx, path)}>${esc(v)}</span></p>`).join("")}
         </div>
       </div>` : "";

  // Zone 2 — WHO
  const load = d.ownerLoad;
  const lead = arr(p.roster).find((r) => /lead/i.test(r.role || ""));
  const whoBody = load.ok && load.people.length
    ? `<div class="rb-people">${load.people.map((x) => {
        const cls = x.open === 0 ? "is-idle" : x.open === load.busiest && load.busiest > 1 ? "is-heavy" : "";
        return `<span class="rb-person ${cls}"><b>${esc(x.name)}</b><i>${x.open} open</i></span>`;
      }).join("")}${load.unassigned
        ? `<span class="rb-person is-heavy"><b>Unassigned</b><i>${load.unassigned}</i></span>` : ""}</div>`
    : `<p class="rb-empty">No roster captured yet — owner load and assignment are unavailable until there is one.</p>`;

  // Zone 3 — WHAT'S NEEDED
  const blockers = arr(p.actionItems)
    .filter((i) => i.status !== "done")
    .sort((a, b) => (daysFromNow(a.due) ?? 9e3) - (daysFromNow(b.due) ?? 9e3))
    .slice(0, 5);
  const stageLabel = (STAGES.find((s) => s[0] === p.stage) || [, "Stage not set"])[1];

  const outlook = p.signals?.winLikelihood
    ? `<div class="rb-zone rb-outlook">Outlook: <b>${esc(p.signals.winLikelihood)}</b>${
        summariseSignals(p.signals)} <a href="#" data-goto="risks">Details&nbsp;→</a></div>`
    : "";

  return `
    <div class="rb-snapshot">
      <div class="rb-masthead">
        <div>
          <div${edIn(ctx, "client", "rb-eyebrow")}>${esc(p.client)}</div>
          <h1${edIn(ctx, "title", "rb-h1")}>${esc(p.title || "RFP brief")}</h1>
        </div>
        <div class="rb-actions">
          <button class="rb-btn rb-btn-primary" data-action="start-meeting">Start meeting</button>
        </div>
      </div>

      ${deadline}
      ${askParas ? `<div class="rb-zone" style="margin-top:0">${askParas}</div>` : ""}

      <div class="rb-zone rb-pulse">
        ${tileReadiness(d.readiness)}
        ${tileCountdown(d.criticalPath)}
      </div>

      ${verdict}

      <div class="rb-zone">
        <div class="rb-zone-head"><span>Who's involved</span></div>
        <p class="rb-sub rb-small" style="margin-bottom:12px">${esc(p.client)}${
          lead ? ` · our response lead is <b>${esc(lead.name)}</b>` : ""}</p>
        ${whoBody}
        ${lineOwnerLoad(d.ownerLoad)}
      </div>

      <div class="rb-zone">
        <div class="rb-zone-head"><span>What's needed next</span></div>
        <p class="rb-sub rb-small" style="margin-bottom:12px"><b>${esc(stageLabel)}</b>${
          subDays !== null && subDays >= 0 ? ` — submission in ${plural(subDays, "day")}` : ""}</p>
        ${blockers.length
          ? `<ul class="rb-needs">${blockers.map((b) => {
              const late = daysFromNow(b.due) < 0;
              return `<li><span>${esc(b.task)}</span>
                <span class="rb-need-owner">${b.owner ? esc(b.owner) : "unassigned"}</span>
                <span class="rb-need-due ${late ? "is-late" : ""}">${b.due ? esc(fmtDate(b.due)) : "—"}</span></li>`;
            }).join("")}</ul>`
          : `<p class="rb-empty">No open action items — either the work is done or nothing has been captured yet.</p>`}
        ${lineCoverage(d.coverage)}
      </div>

      ${outlook}
    </div>`;
}

function summariseSignals(s) {
  const bits = [];
  if (arr(s.red).length) bits.push(`${plural(s.red.length, "signal")} against`);
  if (arr(s.green).length) bits.push(`${s.green.length} for`);
  return bits.length ? ` — ${bits.join(", ")}.` : "";
}

function tileReadiness(r) {
  if (!r.ok) return `<div class="rb-card rb-degraded">${esc(r.why)}</div>`;
  return `<div class="rb-card rb-tile">
    <div class="rb-tile-label">Response readiness</div>
    <div class="rb-metric-num">${pct(r.value)}<small>%</small></div>
    <div class="rb-metric-note">${esc(r.biggestDrag)}</div>
    <div class="rb-bar"><i style="width:${pct(r.value)}%"></i></div>
    <details class="rb-expand"><summary>How this is computed</summary>
      <div class="rb-expand-body">
        <ul class="rb-rows">${r.inputs.map((i) => `
          <li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:46px">
            <span class="rb-row-text">${esc(i.key)}<br><span class="rb-meta">${esc(i.detail)}</span></span>
            <span></span><span></span>
            <b class="rb-meta r" style="color:var(--rb-ink);font-size:13px">${pct(i.value)}%</b>
          </div></li>`).join("")}</ul>
        <div class="rb-formula">readiness = mean(${r.inputs.map((i) => pct(i.value) + "%").join(", ")})${
          r.capped ? " → capped at 90%: a mandatory rule is unchecked" : ""}</div>
        ${r.gaps.length ? `<p class="rb-small rb-muted" style="margin-top:10px">Gaps: ${esc(r.gaps.join(" · "))}</p>` : ""}
      </div>
    </details>
  </div>`;
}

function tileCountdown(c) {
  if (!c.ok) return `<div class="rb-card rb-degraded">${esc(c.why)}</div>`;
  const big = c.subDays === null ? "—" : c.subDays < 0 ? Math.abs(c.subDays) : c.subDays;
  const unit = c.subDays === null ? "no submission date" : c.subDays < 0 ? "days since close" : "days to submit";
  const note = c.nearest && c.nearest.days >= 0
    ? `Next: ${esc(c.nearest.label)} in ${plural(c.nearest.days, "day")}`
    : c.late.length ? `${plural(c.late.length, "item")} already late` : "No nearer constraint";
  return `<div class="rb-card rb-tile">
    <div class="rb-tile-label">Critical path</div>
    <div class="rb-metric-num">${big}<small> ${esc(unit)}</small></div>
    <div class="rb-metric-note">${note}</div>
    <details class="rb-expand"><summary>Milestones and slack</summary>
      <div class="rb-expand-body">
        <ul class="rb-rows">${c.milestones.map((m) => `
          <li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:96px;--rb-c3:82px">
            <span class="rb-row-text">${esc(m.label)}</span><span></span>
            <span class="rb-meta r">${esc(fmtDate(m.date))}</span>
            <span class="rb-meta r ${m.days < 0 ? "is-late" : ""}">${m.days < 0 ? `${Math.abs(m.days)}d ago` : `${m.days}d slack`}</span>
          </div></li>`).join("")}</ul>
        ${c.late.length ? `<p class="rb-small" style="margin-top:10px;color:var(--rb-urgent)">Late: ${
          c.late.map((i) => esc(i.task)).join("; ")}</p>` : ""}
        <div class="rb-formula">slack = due date − today, from Key Dates and item due dates</div>
      </div>
    </details>
  </div>`;
}

function lineOwnerLoad(o) {
  if (!o.ok) return `<p class="rb-empty" style="margin-top:12px">${esc(o.why)}</p>`;
  // Name the finding, not the feature. "Owner load" alone tells nobody anything;
  // "3 themes with nobody on them" is why you'd open it.
  const flags = [
    o.unownedThemes.length ? `${plural(o.unownedThemes.length, "theme")} with nobody on it` : null,
    o.people.length && o.busiest > 1 ? `${o.people[0].name} carrying ${o.busiest}` : null,
    o.idle.length ? `${plural(o.idle.length, "person", "people")} carrying nothing` : null,
  ].filter(Boolean).join(" · ");
  return `<details class="rb-expand" style="margin-top:14px"><summary>Owner load${
    flags ? ` — ${esc(flags)}` : " by theme"}</summary>
    <div class="rb-expand-body">${heatmap(o)}</div></details>`;
}

function heatmap(o) {
  if (!o.themes.length) return `<p class="rb-empty">No requirement themes yet — the grid needs themed requirements to be meaningful.</p>`;
  const max = Math.max(1, ...o.grid.flatMap((g) => g.cells));
  return `<div style="overflow-x:auto"><table class="rb-heat">
    <thead><tr><th>Person</th>${o.themes.map((t) => `<th class="rb-rot">${esc(t)}</th>`).join("")}</tr></thead>
    <tbody>${o.grid.map((g) => `<tr><td>${esc(g.name)}</td>${g.cells.map((n) => `
      <td><span class="rb-hcell" style="${n ? `background:rgba(82,65,181,${0.08 + (n / max) * 0.42});border-color:transparent;color:var(--rb-ink);font-weight:700` : ""}">${n || "·"}</span></td>`).join("")}</tr>`).join("")}
    </tbody></table></div>
    ${o.unownedThemes.length ? `<p class="rb-small" style="margin-top:12px"><b>No owner at all:</b> ${
      esc(o.unownedThemes.join(", "))}</p>` : ""}
    ${o.idle.length ? `<p class="rb-small rb-muted">Carrying nothing: ${esc(o.idle.join(", "))}</p>` : ""}
    ${o.unassigned ? `<p class="rb-small rb-muted">${plural(o.unassigned, "item")} unassigned.</p>` : ""}`;
}

function lineCoverage(c) {
  if (!c.ok) return `<p class="rb-empty" style="margin-top:12px">${esc(c.why)}</p>`;
  return `<details class="rb-expand" style="margin-top:14px"><summary>Coverage — ${c.total} requirements, ${
    c.done} answered, ${c.inProgress} in progress${c.atRisk ? `, ${c.atRisk} at risk` : ""}</summary>
    <div class="rb-expand-body">${matrix(c)}</div></details>`;
}

function matrix(c) {
  const byTheme = c.themes.map((t) => ({ theme: t, cells: c.cells.filter((x) => x.theme === t) }));
  return byTheme.map((g) => `
    <div class="rb-group">
      <div class="rb-group-head"><span>${esc(g.theme)}</span><span class="rb-nav-count">${g.cells.length}</span></div>
      <div class="rb-matrix" style="margin-top:10px">${g.cells.map((x) => `
        <a class="rb-cell" data-s="${x.state}" data-goto="requirements" data-el="req-${esc(x.id)}"
           href="#" title="${esc(x.id)} — ${esc(x.state)}: ${esc((x.label || "").slice(0, 90))}"></a>`).join("")}</div>
    </div>`).join("") + `
    <div class="rb-legend">
      <span><i style="background:var(--rb-accent);border-color:var(--rb-accent)"></i>answered</span>
      <span><i style="background:var(--rb-accent-soft);border-color:#C9C2F0"></i>in progress</span>
      <span><i style="background:var(--rb-fill)"></i>open</span>
      <span><i style="background:repeating-linear-gradient(45deg,#fff,#fff 3px,var(--rb-line) 3px,var(--rb-line) 5px)"></i>unowned</span>
      <span><i style="background:var(--rb-urgent-soft);border-color:var(--rb-urgent)"></i>at risk</span>
    </div>
    <div class="rb-formula">at risk = mandatory AND (unowned OR due within 3 days)</div>`;
}

/* ---------- edit controls ----------
   Structured inputs only: owner, status, due, the rule checkbox, and the text
   of an action item (because you can't add one without typing it). Everything
   else stays read-only — the pack is the source, and free-typing over analysis
   is how a brief quietly stops matching its documents. */

const STATUSES = ["open", "in-progress", "done"];
const dateVal = (v) => (v ? String(v).slice(0, 10) : "");

/* Edit-in-place on a text node. Commits on blur, reverts on Escape — never on
   keystroke, or a re-render would steal focus mid-sentence. We read
   textContent, so pasted markup can never reach the pack. */
const ed = (ctx, path) => (ctx.edit
  ? ` contenteditable="plaintext-only" spellcheck="false" class="rb-etext" data-etext="${esc(path)}"`
  : "");

/* Same, but for an element that already carries a class attribute. */
const edIn = (ctx, path, cls) => (ctx.edit
  ? ` contenteditable="plaintext-only" spellcheck="false" class="${cls} rb-etext" data-etext="${esc(path)}"`
  : ` class="${cls}"`);

const delBtn = (ctx, coll, id) => (ctx.edit
  ? `<button class="rb-del" data-del="${coll}" data-id="${esc(id)}" title="Delete" aria-label="Delete ${esc(id)}">×</button>`
  : "");

const addBtn = (ctx, coll, label) => (ctx.edit
  ? `<div class="rb-addrow"><button class="rb-btn rb-add" data-add="${coll}">+ ${esc(label)}</button></div>` : "");

const ownerSelect = (ctx, id, coll, value) => `
  <select class="rb-in" data-edit="owner" data-coll="${coll}" data-id="${esc(id)}" aria-label="Owner">
    <option value=""${!value ? " selected" : ""}>unassigned</option>
    ${ctx.roster.map((n) => `<option${n === value ? " selected" : ""}>${esc(n)}</option>`).join("")}
    ${value && !ctx.roster.includes(value) ? `<option selected>${esc(value)}</option>` : ""}
  </select>`;

const statusSelect = (id, coll, value) => `
  <select class="rb-in" data-edit="status" data-coll="${coll}" data-id="${esc(id)}" aria-label="Status">
    ${STATUSES.map((s) => `<option${s === (value || "open") ? " selected" : ""}>${s}</option>`).join("")}
  </select>`;

/* ---------- 2. Action Checklist ---------- */
function secChecklist(p, d, ctx) {
  const items = arr(p.actionItems);
  const add = addBtn(ctx, "actionItems", "Add an item");

  if (!items.length) return head("What we need from you") + add +
    `<p class="rb-empty">No action items captured yet. The kickoff is where these get created and assigned.</p>`;

  const owners = [...new Set(items.map((i) => i.owner || "Unassigned"))]
    .sort((a, b) => (a === "Unassigned" ? 1 : b === "Unassigned" ? -1 : a.localeCompare(b)));

  return head("What we need from you",
    "Every input the response needs from a human. Each line is answerable without opening an RFP document.") +
    add +
    owners.map((o) => {
      const mine = items.filter((i) => (i.owner || "Unassigned") === o);
      const open = mine.filter((i) => i.status !== "done").length;
      return `<div class="rb-group">
        <div class="rb-group-head"><span>${esc(o)}</span><span class="rb-nav-count">${open} open of ${mine.length}</span></div>
        <ul class="rb-rows">${mine.map((i) => {
          const late = i.status !== "done" && daysFromNow(i.due) < 0;
          if (ctx.edit) return `<li data-el="action-${esc(i.id)}"><div class="rb-row is-edit">
            <span class="rb-id">${esc(i.id || "")}</span>
            <input class="rb-in rb-in-text" data-edit="task" data-coll="actionItems" data-id="${esc(i.id)}"
                   value="${esc(i.task)}" aria-label="Task">
            ${ownerSelect(ctx, i.id, "actionItems", i.owner)}
            <input class="rb-in" type="date" data-edit="due" data-coll="actionItems" data-id="${esc(i.id)}"
                   value="${esc(dateVal(i.due))}" aria-label="Due date">
            ${statusSelect(i.id, "actionItems", i.status)}
            <button class="rb-del" data-del="actionItems" data-id="${esc(i.id)}" title="Delete item"
                    aria-label="Delete ${esc(i.id)}">×</button>
          </div></li>`;
          return `<li data-el="action-${esc(i.id)}"><div class="rb-row" style="--rb-c1:62px;--rb-c2:104px;--rb-c3:104px">
            <span class="rb-id">${esc(i.id || "")}</span>
            <span class="rb-row-text ${i.status === "done" ? "is-done" : ""}">${esc(i.task)}</span>
            <span class="rb-meta r">${i.requirementId
              ? `<a href="#" data-goto="requirements" data-el="req-${esc(i.requirementId)}">${esc(i.requirementId)}</a>` : ""}</span>
            <span class="rb-meta r ${late ? "is-late" : ""}">${i.due ? esc(fmtDate(i.due)) + (late ? " · late" : "") : ""}</span>
            <span class="rb-status" data-s="${esc(i.status || "open")}">${esc(i.status || "open")}</span>
          </div></li>`;
        }).join("")}</ul></div>`;
    }).join("");
}

/* ---------- 3. The Ask ---------- */
function secAsk(p, d, ctx) {
  const a = p.ask || {};
  const blocks = [["", a.summary, "ask.summary"], ["Background", a.background, "ask.background"],
                  ["What done looks like", a.doneLooksLike, "ask.doneLooksLike"]];
  return head("The ask") + `<div class="rb-measure">` +
    blocks.filter(([, v]) => has(v) || ctx.edit).map(([k, v, path]) =>
      `${k ? `<h3 class="rb-h3" style="margin-top:var(--rb-s4)">${k}</h3>` : ""}
       <p${edIn(ctx, path, "rb-ask")} style="margin-top:${k ? 8 : 0}px">${esc(v || "")}</p>`).join("") + `</div>`;
}

/* ---------- 4. Key Dates ---------- */
function secDates(p, d) {
  const idx = STAGES.findIndex((s) => s[0] === p.stage);
  const stepper = `<div class="rb-stepper">${STAGES.map(([id, label], me) => {
    const stamp = arr(p.stageHistory).find((h) => h.stage === id);
    return `<span class="rb-step ${me < idx ? "is-done" : ""} ${me === idx ? "is-current" : ""}">
      <span>${esc(label)}${stamp ? ` <span class="rb-micro rb-muted">${esc(fmtDate(stamp.at))}</span>` : ""}</span></span>`;
  }).join("")}</div>`;

  const rows = d.criticalPath.ok ? d.criticalPath.milestones : [];
  const firstUpcoming = rows.findIndex((m) => m.days >= 0);
  return head("Key dates") + stepper +
    (rows.length
      ? `<ul class="rb-timeline">${rows.map((m, i) => `
          <li class="${m.days < 0 ? "is-past" : ""} ${i === firstUpcoming ? "is-next" : ""}" data-el="date-${esc(m.id || i)}">
            <div class="rb-tl-date">${esc(m.id === "submission" ? fmtDeadline(m.date) : fmtDate(m.date))} · ${
              m.days < 0 ? `${Math.abs(m.days)} days ago` : `in ${plural(m.days, "day")}`}</div>
            <div class="rb-tl-title">${esc(m.label)}</div>
            ${has(m.ourAction) && m.ourAction !== "—" ? `<div class="rb-sub rb-small">We must: ${esc(m.ourAction)}</div>` : ""}
          </li>`).join("")}</ul>`
      : `<p class="rb-empty">No dates captured.</p>`);
}

/* ---------- 5. Rules & Constraints ---------- */
function secRules(p, d, ctx) {
  const rules = arr(p.rules);
  if (!rules.length) return head("Rules & constraints") + `<p class="rb-empty">No submission mechanics captured.</p>`;
  const done = rules.filter((r) => r.checked).length;
  return head("Rules & constraints",
    "Miss one of these and the bid is non-compliant regardless of quality.") +
    `<p class="rb-small rb-muted">${done} of ${rules.length} confirmed.</p>
     <ul class="rb-rows">${rules.map((r) => `
      <li data-el="rule-${esc(r.id)}"><div class="rb-row" style="--rb-c1:0px;--rb-c2:88px;--rb-c3:150px">
        ${ctx.edit
          ? `<input class="rb-check" type="checkbox" data-edit="checked" data-coll="rules"
                    data-id="${esc(r.id)}"${r.checked ? " checked" : ""} aria-label="${esc(r.label)}">`
          : `<span class="rb-id" aria-hidden="true" style="text-align:center;font-size:14px;color:${
              r.checked ? "var(--rb-accent)" : "var(--rb-gray-2)"}">${r.checked ? "✓" : "○"}</span>`}
        <span${edIn(ctx, `rules[id=${r.id}].label`, "rb-row-text " + (r.checked ? "rb-muted" : ""))}>${esc(r.label)}</span>
        <span></span>
        <span class="rb-meta r">${r.mandatory ? `<span class="rb-chip rb-chip-mand">mandatory</span>` : ""}</span>
        <span class="rb-meta r">${ctx.edit ? delBtn(ctx, "rules", r.id) : srcLink(r.source, ctx)}</span>
      </div></li>`).join("")}</ul>` + addBtn(ctx, "rules", "Add a rule");
}

/* ---------- 6. Evaluation ---------- */
function secEvaluation(p, d, ctx) {
  const e = p.evaluation || {};
  const crit = arr(e.criteria);
  const max = Math.max(1, ...crit.map((c) => Number(c.weight) || 0));
  return head("Evaluation", "How they score it — and therefore where effort pays.") +
    (crit.length
      ? `<ul class="rb-weights">${crit.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0)).map((c) => `
          <li><span>${esc(c.name)}${c.mandatory ? ' <span class="rb-chip rb-chip-mand">gate</span>' : ""}</span>
            <span class="rb-weight-bar"><i style="width:${((c.weight || 0) / max) * 100}%"></i></span>
            <span class="rb-weight-num">${esc(c.weight)}%</span></li>`).join("")}</ul>`
      : `<p class="rb-empty">No scoring weights stated in the documents.</p>`) +
    (arr(e.gates).length
      ? `<div class="rb-group"><div class="rb-group-head"><span>Pass / fail gates</span><span class="rb-nav-count">${e.gates.length}</span></div>
         <ul class="rb-rows">${e.gates.map((g) => `<li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:0px">
           <span class="rb-row-text">${esc(g)}</span><span></span><span></span><span></span></div></li>`).join("")}</ul></div>` : "") +
    (has(e.guidance)
      ? `<div class="rb-verdict" style="margin-top:var(--rb-s4)"><p><b>Where to over-invest</b><span${
          ed(ctx, "evaluation.guidance")}>${esc(e.guidance)}</span></p></div>` : "");
}

/* ---------- 7. Requirements ---------- */
function secRequirements(p, d, ctx) {
  const reqs = arr(p.requirements);
  if (!reqs.length) return head("Requirements") + `<p class="rb-empty">No requirements extracted.</p>`;
  const themes = [...new Set(reqs.map((r) => r.theme || "Ungrouped"))];

  return head("Requirements", `${reqs.length} in total. Click a line for the verbatim source text.`) +
    (d.coverage.ok ? `<div class="rb-card" style="padding:18px 20px">${matrix(d.coverage)}</div>` : "") +
    themes.map((t) => {
      const group = reqs.filter((r) => (r.theme || "Ungrouped") === t);
      return `<div class="rb-group">
        <div class="rb-group-head"><span>${esc(t)}</span><span class="rb-nav-count">${group.length}</span></div>
        <ul class="rb-rows">${group.map((r) => `
          <li data-el="req-${esc(r.id)}">
            <div class="rb-row" style="--rb-c1:70px;--rb-c2:78px;--rb-c3:104px">
              <span class="rb-id">${esc(r.id)}</span>
              <span class="rb-row-text">${ctx.edit
                ? `<span${ed(ctx, `requirements[id=${r.id}].text`)}>${esc(r.text)}</span>`
                : has(r.verbatim) || has(r.source)
                ? `<details class="rb-expand rb-inline"><summary>${esc(r.text)}</summary>
                     <div class="rb-expand-body rb-measure">
                       ${has(r.verbatim) ? `<p style="white-space:pre-wrap">${esc(r.verbatim)}</p>` : ""}
                       <p class="rb-src" style="margin-top:8px">${srcLink(r.source, ctx)}</p>
                     </div></details>`
                : esc(r.text)}</span>
              <span class="rb-meta r">${r.mandatory ? `<span class="rb-chip rb-chip-mand">must</span>` : ""}</span>
              <span class="rb-meta r">${ctx.edit
                ? ownerSelect(ctx, r.id, "requirements", r.owner)
                : esc(r.owner || "unowned")}</span>
              ${ctx.edit
                ? statusSelect(r.id, "requirements", r.status)
                : `<span class="rb-status" data-s="${esc(r.status || "open")}">${esc(r.status || "open")}</span>`}
            </div>
          </li>`).join("")}</ul></div>`;
    }).join("");
}

/* ---------- 8. Team & Burden ---------- */
function secTeam(p, d) {
  const t = p.team || {};
  const comps = arr(t.competencies);
  const totalFte = comps.reduce((s, c) => s + (Number(c.fte) || 0), 0);
  return head("Team & burden", "Marked DRAFT and deliberately lean — the workshop challenges it upward, not down.") +
    (arr(p.roster).length
      ? `<div class="rb-group"><div class="rb-group-head"><span>Roster</span><span class="rb-nav-count">${p.roster.length}</span></div>
         <ul class="rb-rows">${p.roster.map((r) => `
           <li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:200px">
             <span class="rb-row-text"><b>${esc(r.name)}</b></span><span></span><span></span>
             <span class="rb-meta r">${esc(r.role || "")}</span></div></li>`).join("")}</ul></div>` : "")
    +
    (comps.length
      ? `<div class="rb-group"><div class="rb-group-head"><span>Competencies the RFP demands</span>
           <span class="rb-nav-count">${totalFte.toFixed(1)} FTE draft</span></div>
         <ul class="rb-rows">${comps.map((c) => `
           <li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:180px;--rb-c3:70px">
             <span class="rb-row-text">${esc(c.name)}</span><span></span>
             <span class="rb-meta r">${arr(c.requirementIds).length ? esc(c.requirementIds.join(", ")) : ""}</span>
             <b class="rb-meta r" style="color:var(--rb-ink)">${esc(c.fte)} FTE</b></div></li>`).join("")}</ul></div>`
      : `<p class="rb-empty">No competency breakdown captured.</p>`)
    +
    (arr(t.keyPersonnel).length
      ? `<div class="rb-group"><div class="rb-group-head"><span>Key personnel mandates</span><span class="rb-nav-count">${t.keyPersonnel.length}</span></div>
         <ul class="rb-rows">${t.keyPersonnel.map((k) => `<li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:0px">
           <span class="rb-row-text">${esc(typeof k === "string" ? k : k.text || k.name)}</span>
           <span></span><span></span><span></span></div></li>`).join("")}</ul></div>` : "")
    +
    (d.ownerLoad.ok ? `<div class="rb-group"><div class="rb-group-head"><span>Current load</span></div>
       <div style="margin-top:12px">${heatmap(d.ownerLoad)}</div></div>` : "");
}

/* Collapsed sections are a viewing preference, not content — they belong to the
   person, not the pack. localStorage can throw in a sandboxed frame, so every
   access is guarded rather than assumed. */
const collapseKey = (briefId) => `rb.qcollapse.${briefId || "brief"}`;
function readCollapsed(briefId) {
  try { return new Set(JSON.parse(localStorage.getItem(collapseKey(briefId)) || "[]")); }
  catch { return new Set(); }
}
function writeCollapsed(briefId, set) {
  try { localStorage.setItem(collapseKey(briefId), JSON.stringify([...set])); } catch {}
}

const toggleBtn = (mount) => mount.querySelector("[data-exp-toggle]");
function flashBtn(btn, label) {
  if (!btn) return;
  const original = btn.innerHTML;
  btn.textContent = label;
  setTimeout(() => { btn.innerHTML = original; }, 1400);
}

/* ---------- 9. Questions ----------
   Topic is the organising idea here, and questions get re-filed constantly as
   the Q&A takes shape. In edit mode a row can be dragged between topics, and
   the same move is available from a select — drag is the fast path, not the
   only path, because drag alone is unusable by keyboard. */
function secQuestions(p, d, ctx) {
  const qs = arr(p.questions);
  const exportBtn = qs.length ? `
    <div class="rb-exp">
      <button class="rb-btn rb-export-q" data-exp-toggle aria-haspopup="true" aria-expanded="false">
        Export questions <span class="rb-caret" aria-hidden="true"></span>
      </button>
      <div class="rb-exp-pop" hidden>
        <button data-export="clip">Copy to clipboard</button>
        <button data-export="txt">Plain text · .txt</button>
        <button data-export="docx">Word · .docx</button>
        <button data-export="csv">Spreadsheet · .csv</button>
      </div>
    </div>` : "";
  const headBlock = `<div class="rb-sec-head">
      ${head("Questions for client", "Submission-ready wording. Copy straight into the Q&A response.")}
      ${exportBtn}
    </div>`;

  if (!qs.length) return headBlock + `<p class="rb-empty">No open questions.</p>`;

  const topicOf = (q) => q.topic || "General";
  // Union of topics in use and sections someone created deliberately, so an
  // empty section survives until it is filled rather than vanishing the moment
  // it is made. Sorted, not first-seen: with first-seen order, moving one
  // question out of a topic reorders every group on the page and the reader
  // loses their place mid-edit. "General" sits last — it means "not filed yet".
  /* questionTopics is the running order of sections, and also what keeps an
     empty section alive until it is filled. Anything in use but not listed yet
     falls in after it, alphabetically, with "General" last — so a pack that has
     never been reordered looks exactly as it did before. */
  const declared = arr(p.questionTopics).filter((t) => typeof t === "string" && t.trim());
  const inUse = [...new Set(qs.map(topicOf))];
  const extras = inUse.filter((t) => !declared.includes(t)).sort((a, b) =>
    a === "General" ? 1 : b === "General" ? -1 : a.localeCompare(b));
  const topics = [...new Set([...declared, ...extras])];

  const topicSelect = (q) => `
    <select class="rb-in rb-topic" data-edit="topic" data-coll="questions" data-id="${esc(q.id)}"
            aria-label="Topic for ${esc(q.id)}">
      ${topics.map((t) => `<option${t === topicOf(q) ? " selected" : ""}>${esc(t)}</option>`).join("")}
      <option value="__new">New topic…</option>
    </select>`;

  /* A running number in reading order, recomputed on every render, so adding,
     deleting or moving a question renumbers the list without touching any id.
     The id underneath never changes — overrides, the activity log and the
     requirement links all address it, and renumbering those would break them.
     It stays on the row as a tooltip for anyone chasing an internal reference. */
  const displayNo = new Map();
  topics.forEach((t) => qs.filter((q) => topicOf(q) === t)
    .forEach((q) => displayNo.set(q.id, displayNo.size + 1)));

  const rows = (t) => qs.filter((q) => topicOf(q) === t).map((q) => `
    <li data-el="question-${esc(q.id)}" data-qid="${esc(q.id)}"${ctx.edit ? ' class="rb-drag"' : ""}>
      <div class="rb-row" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:${ctx.edit ? "210px" : "70px"}">
        <span class="rb-id" title="${esc(q.id)}">${ctx.edit
          ? `<span class="rb-grip" draggable="true" role="button" tabindex="0"
                   aria-label="Move ${esc(q.id)} to another section">⠿</span>` : ""}Q-${displayNo.get(q.id)}</span>
        <span${edIn(ctx, `questions[id=${q.id}].text`, "rb-row-text")}>${esc(q.text)}</span><span></span><span></span>
        <span class="rb-meta r">${ctx.edit
          ? topicSelect(q) + delBtn(ctx, "questions", q.id)
          : (q.requirementId
            ? `<a href="#" data-goto="requirements" data-el="req-${esc(q.requirementId)}">${esc(q.requirementId)}</a>` : "")}</span>
      </div></li>`).join("");

  const collapsed = readCollapsed(p.briefId);
  return headBlock + topics.map((t) => {
    const n = qs.filter((q) => topicOf(q) === t).length;
    // An empty section is only shown while editing — a reader has no use for a
    // heading with nothing under it.
    if (!n && !ctx.edit) return "";
    return `<details class="rb-group rb-qgroup" data-topic="${esc(t)}"${collapsed.has(t) ? "" : " open"}>
      <summary class="rb-group-head">
        <span class="rb-chev" aria-hidden="true"></span>
        ${ctx.edit ? `<span class="rb-sgrip" draggable="true" title="Drag to reorder this section"
             aria-label="Reorder section ${esc(t)}">⠿</span>` : ""}
        <span${ctx.edit
        ? ` contenteditable="plaintext-only" spellcheck="false" class="rb-topic-name"
            data-topic-edit="${esc(t)}" role="textbox" aria-label="Section name"`
        : ""}>${esc(t)}</span>
        <span class="rb-nav-count">${n}</span></summary>
      ${n ? `<ul class="rb-rows">${rows(t)}</ul>`
          : `<p class="rb-empty rb-empty-topic">Empty — drag a question here, or add one.</p>`}
    </details>`;
  }).join("") +
    (ctx.edit ? `<div class="rb-group rb-qgroup rb-newtopic" data-topic="__new">
      <div class="rb-group-head"><span>Drop here to start a new section</span></div></div>` : "") +
    (ctx.edit ? `<div class="rb-addrow">
      <button class="rb-btn rb-add" data-add="questions">+ Add a question</button>
      <button class="rb-btn rb-add" data-add-section="1">+ Add a section</button>
    </div>` : "");
}

/* Plain text, because the destination is a portal form or an email, and every
   richer format arrives there as a formatting problem. */
/* Shared by every export so a .txt and a .docx of the same brief agree, and
   both agree with the screen. */
function orderedQuestions(p) {
  const qs = arr(p.questions);
  const topicOf = (q) => q.topic || "General";
  const declared = arr(p.questionTopics).filter((t) => typeof t === "string" && t.trim());
  const inUse = [...new Set(qs.map(topicOf))];
  const extras = inUse.filter((t) => !declared.includes(t)).sort((a, b) =>
    a === "General" ? 1 : b === "General" ? -1 : a.localeCompare(b));
  const topics = [...new Set([...declared, ...extras])].filter((t) => inUse.includes(t));
  const out = [];
  for (const t of topics) {
    for (const q of qs.filter((x) => topicOf(x) === t)) out.push({ ...q, topic: t, no: out.length + 1 });
  }
  return { topics, rows: out };
}

function questionsToText(p) {
  const { topics, rows } = orderedQuestions(p);
  const client = p.client || p.meta?.client || "";
  const title = p.title || p.meta?.title || "";
  const L = ["QUESTIONS FOR CLIENT"];
  if (client) L.push(client + (title ? ` — ${title}` : ""));
  const due = p.dates?.qaDeadline || p.qaDeadline;
  if (due) L.push(`Q&A deadline: ${due}`);
  L.push(`${rows.length} question${rows.length === 1 ? "" : "s"}`);
  L.push("");
  for (const t of topics) {
    L.push(t.toUpperCase());
    L.push("-".repeat(t.length));
    for (const q of rows.filter((x) => x.topic === t)) {
      L.push(`Q-${q.no}  ${q.text}`);
      if (q.requirementId) L.push(`      ref: ${q.requirementId}`);
    }
    L.push("");
  }
  return L.join("\n");
}

/* CSV, for the teams who track Q&A in a sheet. Quoting is not optional: these
   are sentences, and they contain commas and quotes as a matter of course. */
function questionsToCsv(p) {
  const { rows } = orderedQuestions(p);
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["#", "Section", "Question", "Requirement"].map(cell).join(",")];
  for (const q of rows) lines.push([`Q-${q.no}`, q.topic, q.text, q.requirementId || ""].map(cell).join(","));
  // BOM so Excel opens UTF-8 correctly instead of mangling the first column.
  return "\ufeff" + lines.join("\r\n");
}

/* ---------- a real .docx ----------
   Not HTML with a .doc extension: modern Word warns that the format does not
   match the extension, which is a poor thing to hand a colleague. A .docx is a
   zip of three XML parts, and the entries are small enough to store without
   compressing — which removes the only hard part. */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return (bytes) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
})();

function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  const u16 = (n) => [n & 255, (n >>> 8) & 255];
  const u32 = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];

  for (const [name, text] of files) {
    const nameB = enc.encode(name), data = enc.encode(text);
    const crc = CRC(data);
    const local = [...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameB.length), ...u16(0)];
    parts.push(new Uint8Array(local), nameB, data);
    // One pair per entry. Pushing head and nameB as two arguments appends two
    // separate items, and the destructuring below then reads a number as the
    // header — a zip whose central directory is garbage but whose EOCD is
    // valid, so it opens as an archive containing nothing.
    central.push([[...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(nameB.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(offset)], nameB]);
    offset += local.length + nameB.length + data.length;
  }
  const cd = [];
  for (const [head, nameB] of central) { cd.push(new Uint8Array(head), nameB); }
  const cdSize = cd.reduce((n, b) => n + b.length, 0);
  const eocd = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
  return new Blob([...parts, ...cd, eocd], {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function questionsToDocx(p) {
  const { topics, rows } = orderedQuestions(p);
  const x = (v) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const para = (text, { size = 22, bold = false, before = 0, caps = false } = {}) =>
    `<w:p><w:pPr><w:spacing w:before="${before}" w:after="80"/></w:pPr>` +
    `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="${size}"/>` +
    `${bold ? "<w:b/>" : ""}${caps ? '<w:caps/>' : ""}</w:rPr>` +
    `<w:t xml:space="preserve">${x(text)}</w:t></w:r></w:p>`;

  const client = p.client || p.meta?.client || "";
  const title = p.title || p.meta?.title || "";
  const body = [para("Questions for client", { size: 32, bold: true })];
  if (client) body.push(para(client + (title ? ` — ${title}` : ""), { size: 20 }));
  body.push(para(`${rows.length} question${rows.length === 1 ? "" : "s"}`, { size: 18 }));

  for (const t of topics) {
    body.push(para(t, { size: 24, bold: true, before: 320, caps: true }));
    for (const q of rows.filter((x) => x.topic === t)) {
      body.push(para(`Q-${q.no}   ${q.text}`, { size: 22 }));
      if (q.requirementId) body.push(para(`ref: ${q.requirementId}`, { size: 18 }));
    }
  }

  return zipStore([
    ["[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
    ["_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`],
  ]);
}

/* ---------- 10. Risks & Signals ---------- */
function secRisks(p, d, ctx) {
  const s = p.signals || {};
  const order = { high: 0, med: 1, medium: 1, low: 2 };
  const risks = arr(p.risks).slice().sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

  const group = (title, items, dir) => arr(items).length
    ? `<div><div class="rb-group-head"><span>${title}</span><span class="rb-nav-count">${items.length}</span></div>
       <ul class="rb-signal-group" data-dir="${dir}" style="margin-top:8px">${items.map((x) => `<li><span>${
         esc(typeof x === "string" ? x : x.basis)}${
         typeof x === "object" && x.source ? ` <span class="rb-src">(${esc(x.source)})</span>` : ""}</span></li>`).join("")}</ul></div>` : "";

  return head("Risks & signals") +
    (has(s.winLikelihood)
      ? `<div class="rb-verdict"><p><b>Win likelihood — DRAFT</b><span><b>${esc(s.winLikelihood)}</b>. A judgement read off the signals below, not a computed number.</span></p></div>` : "") +
    `<div class="rb-signals">
      ${group("Working against us", s.red, "red")}
      ${group("Working for us", s.green, "green")}
      ${group("Soft signals", s.beige, "beige")}
      ${arr(s.unknown).length ? `<p class="rb-small rb-muted">Still unknown: ${esc(s.unknown.join(", "))} — recorded as unknown rather than guessed.</p>` : ""}
    </div>` +
    (risks.length
      ? `<div class="rb-group"><div class="rb-group-head"><span>Risks</span><span class="rb-nav-count">${risks.length}</span></div>
         <div style="margin-top:6px">${risks.map((r) => `<div class="rb-risk" data-sev="${esc(r.severity || "")}" data-el="risk-${esc(r.id || r.title)}">
            <div class="rb-sev">${esc(r.severity || "")}</div>
            <div>
              <div${edIn(ctx, `risks[id=${r.id}].title`, "rb-risk-title")}>${esc(r.title)}</div>
              ${has(r.detail) || ctx.edit ? `<p${edIn(ctx, `risks[id=${r.id}].detail`, "rb-sub rb-small")} style="margin-top:2px">${esc(r.detail || "")}</p>` : ""}
              ${has(r.mitigation) || ctx.edit ? `<p${edIn(ctx, `risks[id=${r.id}].mitigation`, "rb-mitigation")}>${esc(r.mitigation || "")}</p>` : ""}
            </div>
            ${delBtn(ctx, "risks", r.id)}
          </div>`).join("")}</div></div>` : "") + addBtn(ctx, "risks", "Add a risk");
}

/* ---------- 11. Decisions & Parking Lot ---------- */
function secDecisions(p) {
  const ds = arr(p.decisions), pl = arr(p.parkingLot), ms = arr(p.meetings);
  if (!ds.length && !pl.length && !ms.length)
    return head("Decisions & parking lot") +
      `<p class="rb-empty">Nothing recorded yet. Decisions land here when they're captured in a meeting — a decision exists because someone wrote it down, not because it was discussed.</p>`;
  const row = (main, meta) => `<li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:0px">
    <span class="rb-row-text"><b>${main}</b><br><span class="rb-meta">${meta}</span></span>
    <span></span><span></span><span></span></div></li>`;
  return head("Decisions & parking lot") +
    (ds.length ? `<div class="rb-group"><div class="rb-group-head"><span>Decisions</span><span class="rb-nav-count">${ds.length}</span></div>
      <ul class="rb-rows">${ds.map((x) => row(esc(x.text || x.decision),
        [x.by, fmtDate(x.at), x.meeting, x.binds].filter(has).map(esc).join(" · "))).join("")}</ul></div>` : "") +
    (pl.length ? `<div class="rb-group"><div class="rb-group-head"><span>Parking lot</span><span class="rb-nav-count">${pl.length}</span></div>
      <ul class="rb-rows">${pl.map((x) => row(esc(x.text),
        [x.by, x.why, x.disposition || "open"].filter(has).map(esc).join(" · "))).join("")}</ul></div>` : "") +
    (ms.length ? `<div class="rb-group"><div class="rb-group-head"><span>Meeting history</span><span class="rb-nav-count">${ms.length}</span></div>
      <ul class="rb-rows">${ms.map((m) => `<li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:110px;--rb-c3:110px">
        <span class="rb-row-text"><b>${esc(m.type)}</b></span><span></span>
        <span class="rb-meta r">${esc(fmtDate(m.date))}</span>
        <span class="rb-meta r">${arr(m.attendees).length} attended${m.duration ? ` · ${esc(m.duration)}` : ""}</span>
      </div></li>`).join("")}</ul></div>` : "");
}

/* ---------- 12. Document Map ---------- */
function secDocuments(p, d, ctx) {
  const docs = arr(p.documents);
  if (!docs.length) return head("Document map") + `<p class="rb-empty">No source documents recorded.</p>`;
  const anyMissing = docs.some((doc) => !doc.unreadable && !ctx.resolveDoc(doc));
  return head("Document map", "A launcher, not a bibliography. Hover any file for a preview.") +
    (anyMissing ? `<div class="rb-notice">Source files stay on the machine that imported the
       pack — they are never uploaded, because this site has no sign-in. Everyone sees the same
       brief; the files themselves open only where they were imported.</div>` : "") +
    `<div>${docs.map((doc) => {
      const href = ctx.resolveDoc(doc);
      const name = doc.unreadable || !href
        ? `<span class="rb-doc-name">${esc(doc.file)}</span> <span class="rb-src">${
            doc.unreadable ? "unprocessed — could not be read"
            : "not on this device — open it from the machine that imported the pack"}</span>`
        : `<a class="rb-doc-name rb-doclink" href="${esc(href)}" ${docTarget(doc)} data-doc="${esc(doc.file)}">${esc(doc.file)}</a>`;
      return `<div class="rb-doc ${doc.unreadable ? "is-unreadable" : ""}" data-el="doc-${esc(doc.file)}">
        ${doc.thumb ? `<img class="rb-doc-thumb" src="${esc(doc.thumb)}" alt="">`
                    : `<span class="rb-doc-thumb rb-doc-glyph">${esc((doc.type || "?").slice(0, 4))}</span>`}
        <div style="min-width:0">
          <div>${name}</div>
          <div class="rb-doc-meta">${[doc.type, doc.pages ? `${doc.pages} pages` : doc.sheets ? `${doc.sheets} sheets` : "",
            bytes(doc.bytes)].filter(has).map(esc).join(" · ")}</div>
          ${has(doc.purpose) ? `<p class="rb-doc-purpose">${esc(doc.purpose)}</p>` : ""}
          ${arr(doc.keySections).length ? `<p class="rb-small rb-muted" style="margin-top:3px">Key: ${esc(doc.keySections.join(" · "))}</p>` : ""}
          ${has(doc.excerpt) && !doc.thumb ? `<p class="rb-small rb-muted" style="margin-top:4px">“${esc(doc.excerpt)}”</p>` : ""}
        </div></div>`;
    }).join("")}</div>`;
}

const VIEWABLE = ["pdf", "png", "jpg", "jpeg", "txt", "html", "csv", "svg"];
const docTarget = (doc) => VIEWABLE.includes(String(doc.type || "").toLowerCase())
  ? 'target="_blank" rel="noopener"' : `download="${esc(doc.file)}"`;

/* ---------- shared bits ---------- */
function head(title, sub) {
  return `<div><h1 class="rb-h1">${esc(title)}</h1>${
    sub ? `<p class="rb-sub" style="margin-top:7px">${esc(sub)}</p>` : ""}</div>`;
}

function srcLink(src, ctx) {
  if (!src) return "";
  if (typeof src === "string") return `<span class="rb-src">${esc(src)}</span>`;
  const label = [src.doc, src.section].filter(has).join(", ");
  const doc = ctx.docByName(src.doc);
  const href = doc ? ctx.resolveDoc(doc, src.page) : null;
  return href
    ? `<a class="rb-src rb-doclink" href="${esc(href)}" ${docTarget(doc)} data-doc="${esc(src.doc)}">${esc(label)}</a>`
    : `<span class="rb-src">${esc(label)}</span>`;
}

/* ============================================================
   MOUNT
   ============================================================ */

export function renderBrief(pack, mount, opts = {}) {
  const o = {
    section: "snapshot", mode: "read",
    onNavigate: () => {}, onDerive: () => {}, onMeetingStart: null,
    onEdit: null,
    baseHref: "", headerHeight: 0,
    resolveDoc: null,
    ...opts,
  };
  let current = pack;

  /* Every listener below is registered on `mount`, and `mount` survives a
     re-render — so without this, each update() stacked another full set. After
     four edits one click on "Add a question" fired five times, and the earlier
     copies were still holding a stale `current`. Abort the previous render's
     listeners before wiring this one. */
  mount.__rbAbort?.abort();
  const rbAC = new AbortController();
  mount.__rbAbort = rbAC;
  // `toggle` does not bubble, so some listeners need capture. Options merge in
  // rather than replacing the abort signal, which every listener depends on.
  const on = (type, fn, capture) =>
    mount.addEventListener(type, fn, { signal: rbAC.signal, capture: !!capture });

  const d = derive(pack);
  o.onDerive({
    readiness: d.readiness.ok ? d.readiness.value : null,
    counts: {
      requirements: arr(pack.requirements).length,
      openItems: arr(pack.actionItems).filter((i) => i.status !== "done").length,
      questions: arr(pack.questions).length,
    },
  });

  const docsByName = Object.fromEntries(arr(pack.documents).map((x) => [x.file, x]));
  const ctx = {
    edit: o.mode === "edit" && !!o.onEdit,
    roster: [...new Set(arr(pack.roster).map((r) => r.name).filter(Boolean))],
    docByName: (n) => docsByName[n] || null,
    resolveDoc: (doc, page) => {
      if (!doc || doc.unreadable) return null;
      if (o.resolveDoc) return o.resolveDoc(doc, page);
      if (pack.docLinks === "none" || !doc.href) return null;
      const base = o.baseHref || "";
      return base + doc.href + (page && String(doc.type).toLowerCase() === "pdf" ? `#page=${page}` : "");
    },
  };

  const live = SECTIONS.filter((s) => (s.when ? s.when(pack) : true));

  mount.className = "rb" + (ctx.edit ? " is-editing" : "");
  mount.style.setProperty("--rb-head-h", (o.headerHeight || 0) + "px");
  mount.innerHTML = `
    <div class="rb-shell">
      <nav class="rb-nav" aria-label="Brief sections">
        <div class="rb-nav-eyebrow">${esc(pack.client || "Brief")}</div>
        ${live.map((s) => {
          const c = s.count ? s.count(pack) : null;
          return `<a href="#" data-goto="${s.id}"><span>${esc(s.label)}</span>${
            c ? `<span class="rb-nav-count">${c}</span>` : ""}</a>`;
        }).join("")}
      </nav>
      <main class="rb-main"><div class="rb-col">
        ${live.map((s) => `<section class="rb-section" id="rb-${s.id}" data-section="${s.id}"></section>`).join("")}
      </div></main>
    </div>
    <div class="rb-pop" hidden role="tooltip"></div>`;

  // Render section bodies once. They are cheap, and pre-rendering makes deep
  // links and print-all work without a second code path.
  for (const s of live) mount.querySelector(`#rb-${s.id}`).innerHTML = s.render(pack, d, ctx);

  const show = (id, elId) => {
    const target = live.some((s) => s.id === id) ? id : "snapshot";
    mount.querySelectorAll(".rb-section").forEach((el) =>
      el.setAttribute("data-active", String(el.dataset.section === target)));
    mount.querySelectorAll(".rb-nav a").forEach((a) =>
      a.setAttribute("aria-current", String(a.dataset.goto === target)));
    if (elId) {
      const el = mount.querySelector(`[data-el="${CSS.escape(elId)}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("rb-flash"); void el.offsetWidth; el.classList.add("rb-flash");
      }
    } else {
      scrollTo({ top: 0, behavior: "instant" });
    }
    o.onNavigate(target);
  };

  on("click", (e) => {
    const nav = e.target.closest("[data-goto]");
    if (nav) { e.preventDefault(); show(nav.dataset.goto, nav.dataset.el); return; }
    const toggle = e.target.closest("[data-exp-toggle]");
    const pop = mount.querySelector(".rb-exp-pop");
    if (pop) {
      if (toggle) {
        e.preventDefault();
        const open = pop.hidden;
        pop.hidden = !open;
        toggle.setAttribute("aria-expanded", String(open));
        return;
      }
      if (!e.target.closest(".rb-exp")) pop.hidden = true;
    }

    const exp = e.target.closest("[data-export]");
    if (exp) {
      e.preventDefault();
      if (pop) pop.hidden = true;
      const kind = exp.dataset.export;
      const slug = String(current.briefId || current.client || "pursuit")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

      if (kind === "clip") {
        // Clipboard is the most-used path — the destination is usually a
        // portal textarea — so it gets a visible confirmation, not silence.
        navigator.clipboard.writeText(questionsToText(current)).then(
          () => flashBtn(toggleBtn(mount), "Copied"),
          () => alert("The browser blocked clipboard access. Use Plain text instead."));
        return;
      }
      const out = kind === "docx" ? { blob: questionsToDocx(current), ext: "docx" }
        : kind === "csv" ? { blob: new Blob([questionsToCsv(current)], { type: "text/csv;charset=utf-8" }), ext: "csv" }
        : { blob: new Blob([questionsToText(current)], { type: "text/plain;charset=utf-8" }), ext: "txt" };

      const a = document.createElement("a");
      a.href = URL.createObjectURL(out.blob);
      a.download = `${slug}-questions.${out.ext}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      return;
    }

    const meet = e.target.closest('[data-action="start-meeting"]');
    if (meet) {
      e.preventDefault();
      if (o.onMeetingStart) o.onMeetingStart(current);
      else alert("Meeting Mode arrives in the next renderer release.\n\nUntil then: run the meeting off the Snapshot and the Coverage matrix, and capture decisions in the Decisions section.");
    }
  });

  /* ---------- edit events ----------
     Structured controls commit on change and trigger a re-render, because
     changing an owner or a status moves rows and changes every derived number.
     Text commits on blur and does NOT re-render — the DOM already shows what
     you typed, and re-rendering mid-sentence would steal the caret. */
  if (ctx.edit) {
    on("change", (e) => {
      const f = e.target.closest("[data-edit]");
      if (!f) return;
      const field = f.dataset.edit;
      let value = f.type === "checkbox" ? f.checked : f.value;

      // "New topic…" is a command, not a value. Cancelling must not leave the
      // select showing a topic the question is not actually in.
      if (field === "topic" && value === "__new") {
        const name = (prompt("Name the new topic:") || "").trim();
        if (!name) { o.onEdit({ kind: "noop", rerender: true }); return; }
        value = name;
      }
      o.onEdit({
        kind: "set", coll: f.dataset.coll, itemId: f.dataset.id, field,
        path: `${f.dataset.coll}[id=${f.dataset.id}].${field}`,
        value: field === "owner" && value === "" ? null : value,
        elementId: `${f.dataset.coll}-${f.dataset.id}.${field}`,
        label: field === "topic" ? `${f.dataset.id} · moved to ${value}` : `${f.dataset.id} · ${field}`,
        rerender: field !== "task",
      });
    });

    on("focusin", (e) => {
      const t = e.target.closest("[data-etext]");
      if (t) t.dataset.before = t.textContent;
    });

    /* Renaming a section is not a field edit — it rewrites the topic on every
       question filed under it. It gets its own change kind so the activity log
       records one "renamed" line rather than one line per question. */
    /* Inside a <summary>, a click toggles the section. The rename field and the
       reorder grip both live there, so both have to opt out or you cannot type
       a name without collapsing what you are naming. */
    on("click", (e) => {
      if (e.target.closest("[data-topic-edit], .rb-sgrip")) e.preventDefault();
    });

    on("keydown", (e) => {
      const t = e.target.closest("[data-topic-edit]");
      if (!t) return;
      if (e.key === "Escape") { t.textContent = t.dataset.topicEdit; t.blur(); }
      if (e.key === "Enter") { e.preventDefault(); t.blur(); }
    });
    on("focusout", (e) => {
      const t = e.target.closest("[data-topic-edit]");
      if (!t) return;
      const from = t.dataset.topicEdit;
      const to = t.textContent.trim();
      if (!to) { t.textContent = from; return; }          // blank is a cancel
      if (to === from) return;
      // Claim the new name before emitting. The re-render tears this node out
      // while it still has focus, which fires focusout a second time — and the
      // second pass would log a rename of zero questions over the real one.
      t.dataset.topicEdit = to;
      o.onEdit({ kind: "rename-topic", from, to, rerender: true,
                 label: `section “${from}” → “${to}”` });
    });
    on("keydown", (e) => {
      const t = e.target.closest("[data-etext]");
      if (!t) return;
      if (e.key === "Escape") { t.textContent = t.dataset.before ?? t.textContent; t.blur(); }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); t.blur(); }
    });
    on("focusout", (e) => {
      const t = e.target.closest("[data-etext]");
      if (!t) return;
      const before = t.dataset.before ?? "";
      const after = t.textContent.trim();
      if (after === before.trim()) return;
      o.onEdit({
        kind: "set", path: t.dataset.etext, value: after,
        elementId: t.dataset.etext, label: t.dataset.etext,
        before, rerender: false,
      });
      t.dataset.before = after;
    });

    /* Drag a question into another topic. The drop target is the group, so the
       whole band is a target rather than a thin line between rows — ordering
       within a topic is not meaningful here, only which topic it belongs to. */
    let dragId = null;        // a question being re-filed
    let dragSection = null;   // a whole section being reordered

    const sectionOrder = () =>
      [...mount.querySelectorAll(".rb-qgroup[data-topic]")]
        .map((el) => el.dataset.topic)
        .filter((t) => t && t !== "__new");

    const clearDropMarks = () => mount.querySelectorAll(".is-over,.is-before,.is-after")
      .forEach((el) => el.classList.remove("is-over", "is-before", "is-after"));

    on("dragstart", (e) => {
      const sgrip = e.target.closest(".rb-sgrip");
      if (sgrip) {
        dragSection = sgrip.closest(".rb-qgroup")?.dataset.topic || null;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", `section:${dragSection}`);
        return;
      }
      // Only the grip starts a move. The row cannot be draggable itself: its
      // text is contenteditable, so dragging anywhere on it starts a text drag
      // and the row never moves.
      const grip = e.target.closest(".rb-grip");
      const li = grip && grip.closest("li[data-qid]");
      if (!li) return;
      dragId = li.dataset.qid;
      li.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", dragId);
    });

    on("dragend", () => {
      dragId = null; dragSection = null;
      mount.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
      clearDropMarks();
    });

    on("dragover", (e) => {
      const g = e.target.closest(".rb-qgroup[data-topic]");
      if (!g) return;

      if (dragSection) {
        if (g.dataset.topic === dragSection || g.dataset.topic === "__new") return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        // Above or below the midpoint decides which side it lands on. Without
        // that, dragging a section downward always inserts above the target and
        // the row appears to move the wrong way.
        const r = g.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        clearDropMarks();
        g.classList.add(before ? "is-before" : "is-after");
        return;
      }

      if (!dragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!g.classList.contains("is-over")) {
        clearDropMarks();
        g.classList.add("is-over");
      }
      // A collapsed section is still a valid destination — open it so the drop
      // is visible rather than a guess.
      if (g.tagName === "DETAILS" && !g.open) g.open = true;
    });

    on("dragleave", (e) => {
      const g = e.target.closest(".rb-qgroup[data-topic]");
      if (g && !g.contains(e.relatedTarget)) g.classList.remove("is-over", "is-before", "is-after");
    });

    on("drop", (e) => {
      const g = e.target.closest(".rb-qgroup[data-topic]");
      if (!g) return;
      e.preventDefault();

      if (dragSection) {
        const target = g.dataset.topic;
        const r = g.getBoundingClientRect();
        const before = e.clientY < r.top + r.height / 2;
        clearDropMarks();
        if (!target || target === dragSection || target === "__new") return;

        const order = sectionOrder().filter((t) => t !== dragSection);
        const at = order.indexOf(target) + (before ? 0 : 1);
        order.splice(at, 0, dragSection);

        o.onEdit({
          kind: "set", path: "questionTopics", value: order,
          elementId: "questionTopics", label: `moved section “${dragSection}”`,
          rerender: true,
        });
        dragSection = null;
        return;
      }

      const id = dragId || e.dataTransfer.getData("text/plain");
      if (!id || id.startsWith("section:")) return;
      clearDropMarks();

      let topic = g.dataset.topic;
      if (topic === "__new") {
        topic = (prompt("Name the new section:") || "").trim();
        if (!topic) return;
      }
      const from = mount.querySelector(`li[data-qid="${CSS.escape(id)}"]`)
        ?.closest(".rb-qgroup")?.dataset.topic;
      if (from === topic) return;   // dropped where it already was

      o.onEdit({
        kind: "set", coll: "questions", itemId: id, field: "topic",
        path: `questions[id=${id}].topic`, value: topic,
        elementId: `questions-${id}.topic`,
        label: `${id} · moved to ${topic}`,
        before: from, rerender: true,
      });
    });

    on("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        e.preventDefault();
        o.onEdit({ kind: "remove", coll: del.dataset.del, itemId: del.dataset.id,
                   elementId: `remove-${del.dataset.del}-${del.dataset.id}`,
                   label: `deleted ${del.dataset.id}`, rerender: true });
        return;
      }
      const add = e.target.closest("[data-add]");
      if (add) {
        e.preventDefault();
        o.onEdit({ kind: "add", coll: add.dataset.add, rerender: true,
                   label: `added to ${add.dataset.add}` });
        return;
      }
      /* A section is not a row, so it is not an "add" to a collection. It is a
         name recorded on the pack, which is what lets an empty one survive. */
      const sec = e.target.closest("[data-add-section]");
      if (sec) {
        e.preventDefault();
        const name = (prompt("Name the new section:") || "").trim();
        if (!name) return;
        const existing = arr(current.questionTopics);
        const inUse = new Set([...arr(current.questions).map((q) => q.topic || "General"), ...existing]);
        if (inUse.has(name)) { alert(`"${name}" already exists.`); return; }
        o.onEdit({
          kind: "set", path: "questionTopics", value: [...existing, name],
          elementId: "questionTopics", label: `added section ${name}`, rerender: true,
        });
      }
    });
  }

  /* Remember which sections are collapsed, per person, per brief. */
  on("toggle", (e) => {
    const g = e.target.closest?.(".rb-qgroup[data-topic]");
    if (!g || g.dataset.topic === "__new") return;
    const set = readCollapsed(current.briefId);
    if (g.open) set.delete(g.dataset.topic); else set.add(g.dataset.topic);
    writeCollapsed(current.briefId, set);
  }, true);

  attachPopovers(mount, docsByName, ctx, rbAC.signal);
  show(o.section);

  /* Re-render in place, keeping the reader where they were. */
  const update = (nextPack, nextMode) => {
    const section = [...mount.querySelectorAll(".rb-section")]
      .find((el) => el.dataset.active === "true")?.dataset.section || o.section;
    const y = window.scrollY;
    const api = renderBrief(nextPack || current, mount, { ...o, mode: nextMode || o.mode, section });
    window.scrollTo({ top: y, behavior: "instant" });
    return api;
  };

  return {
    version: RENDERER_VERSION,
    metrics: d,
    goto: show,
    update,
    destroy: () => { rbAC.abort(); mount.__rbAbort = null; mount.innerHTML = ""; mount.className = ""; },
  };
}

/* ---------- document hover previews (vanilla positioning) ---------- */
function attachPopovers(root, docsByName, ctx, signal) {
  // Same accumulation problem as renderBrief, and worse for the two window
  // listeners: those outlive the mount entirely and would pile up for the life
  // of the page.
  const opt = { signal };
  const pop = root.querySelector(".rb-pop");
  let openTimer = null, closeTimer = null, current = null;

  const place = (anchor) => {
    const r = anchor.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    const pad = 10;
    let left = r.right + pad, top = r.top;
    if (left + pr.width > innerWidth - pad) left = r.left - pr.width - pad;   // flip
    if (left < pad) left = Math.min(pad, innerWidth - pr.width - pad);         // shift
    if (top + pr.height > innerHeight - pad) top = innerHeight - pr.height - pad;
    if (top < pad) top = pad;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  };

  const open = (anchor) => {
    const doc = docsByName[anchor.dataset.doc];
    if (!doc) return;
    const href = ctx.resolveDoc(doc);
    pop.innerHTML = `
      ${doc.thumb ? `<img src="${esc(doc.thumb)}" alt="">` : ""}
      <div class="rb-pop-title">${esc(doc.file)}</div>
      <div class="rb-doc-meta">${[doc.type, doc.pages ? `${doc.pages} pages` : doc.sheets ? `${doc.sheets} sheets` : "",
        bytes(doc.bytes)].filter(has).map(esc).join(" · ")}</div>
      ${has(doc.purpose) ? `<p class="rb-small" style="margin-top:7px">${esc(doc.purpose)}</p>` : ""}
      ${arr(doc.keySections).length ? `<p class="rb-small rb-muted" style="margin-top:3px">Key: ${esc(doc.keySections.join(" · "))}</p>` : ""}
      ${has(doc.excerpt) && !doc.thumb ? `<p class="rb-small rb-muted" style="margin-top:7px">“${esc(doc.excerpt)}”</p>` : ""}
      ${href ? `<div class="rb-pop-actions">
        <a class="rb-btn" href="${esc(href)}" target="_blank" rel="noopener">Open</a>
        <a class="rb-btn" href="${esc(href)}" download="${esc(doc.file)}">Download</a></div>` : ""}`;
    pop.hidden = false;
    place(anchor);
    current = anchor;
  };

  const close = () => { pop.hidden = true; current = null; };

  root.addEventListener("mouseover", (e) => {
    const a = e.target.closest("[data-doc]");
    if (!a || a === current) return;
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    openTimer = setTimeout(() => open(a), 200);      // intent delay
  }, opt);
  root.addEventListener("mouseout", (e) => {
    if (!e.target.closest("[data-doc]")) return;
    clearTimeout(openTimer);
    closeTimer = setTimeout(close, 100);             // grace period into the popover
  }, opt);
  pop.addEventListener("mouseenter", () => clearTimeout(closeTimer), opt);
  pop.addEventListener("mouseleave", close, opt);
  root.addEventListener("focusin", (e) => { const a = e.target.closest("[data-doc]"); if (a) open(a); }, opt);
  root.addEventListener("focusout", () => { closeTimer = setTimeout(close, 100); }, opt);
  addEventListener("keydown", (e) => { if (e.key === "Escape") close(); }, opt);
  addEventListener("scroll", close, { capture: true, signal });
}
