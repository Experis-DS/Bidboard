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

export const RENDERER_VERSION = "2.2.0";
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

/* Retained for the schema's stageHistory field, which /RFP still records for
   provenance, but NOT rendered anywhere: a self-reported pipeline stage rots.
   Do not reintroduce a stepper from this without a way to keep it honest. */
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
  /* Rules used to be a third input, scored on `checked`. They are constraints,
     not tasks — see secRules — so a "rules confirmed" percentage was measuring
     whether somebody had clicked, not whether we were ready. Two honest inputs
     beat three with one of them made up. */
  if (!inputs.length) return { ok: false, why: "Readiness unavailable — no action items or requirements in the pack" };

  const value = inputs.reduce((s, i) => s + i.value, 0) / inputs.length;

  /* Each gap is a place to go, not a sentence to read. Named collections so the
     Readiness tab can link straight at the work. */
  const gaps = [];
  const unowned = reqs.filter((r) => !r.owner);
  if (unowned.length) gaps.push({ text: `${plural(unowned.length, "requirement")} with no owner`, goto: "compliance", el: `req-${unowned[0].id}` });
  const openItems = items.filter((i) => i.status !== "done");
  if (openItems.length) gaps.push({ text: `${plural(openItems.length, "action item")} still open`, goto: "plan", el: `action-${openItems[0].id}` });
  const late = items.filter((i) => i.status !== "done" && daysFromNow(i.due) < 0);
  if (late.length) gaps.push({ text: `${plural(late.length, "item")} past due`, goto: "plan", el: `action-${late[0].id}` });
  const unanswered = arr(pack.questions).filter((q) => !has(q.answer));
  if (unanswered.length) gaps.push({ text: `${plural(unanswered.length, "question")} unanswered by the client`, goto: "questions", el: `question-${unanswered[0].id}` });

  const worst = inputs.slice().sort((a, b) => a.value - b.value)[0];
  return { ok: true, value, inputs, gaps, capped: false,
    biggestDrag: gaps[0] ? gaps[0].text : `lowest input: ${worst.key.toLowerCase()}` };
}

function deriveCriticalPath(pack) {
  const sub = pack.submission && pack.submission.date;
  const dates = arr(pack.dates).filter((d) => parseDate(d.date));
  if (!sub && !dates.length) return { ok: false, why: "Countdown unavailable — no dates in the pack" };

  const milestones = dates.map((d) => ({ ...d, kind: dateKind(d), days: daysFromNow(d.date) }));
  if (sub) milestones.push({ id: "submission", label: "Submission", date: sub, days: daysFromNow(sub), kind: "response", ourAction: pack.submission.method || "" });
  milestones.sort((a, b) => a.days - b.days);

  const upcoming = milestones.filter((m) => m.days >= 0);
  const late = arr(pack.actionItems).filter((i) => i.status !== "done" && daysFromNow(i.due) < 0);
  const subDays = sub ? daysFromNow(sub) : null;
  /* "Next" means the next thing WE have to do. A client programme milestone a
     year out is not a nearer constraint than the submission, and reading it as
     one is how the countdown tile stopped being trusted. */
  const nearest = upcoming.find((m) => m.id !== "submission" && m.kind === "response")
    || upcoming.find((m) => m.id !== "submission");

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

/* EIGHT nav sections, down from twelve. "You could probably be down to at least
   a third less tabs" — and the four nobody could tell apart (Rules &
   Constraints, Evaluation, Requirements, Pass/Fail Gates) collapse into two.

   Section IDS ARE PRESERVED even where labels and contents merged, because
   #/b/<pursuit>/requirements links are already shared in Teams threads. New
   composite sections take the id of their dominant half and the rest resolve
   through ALIASES in show(). A tidier id set is not worth a dead link. */
const SECTIONS = [
  { id: "snapshot",     label: "TLDR",                 render: secScope },
  { id: "plan",         label: "Readiness",            render: secPlan,
    when: (p) => has(p.actionItems) || has(p.dates) || has(p.submission),
    count: (p) => arr(p.actionItems).filter((i) => i.status !== "done").length || null },
  { id: "compliance",   label: "Rules & Requirements", render: secCompliance,
    when: (p) => has(p.rules) || has(p.requirements),
    count: (p) => (arr(p.rules).length + arr(p.requirements).length) || null },
  { id: "evaluation",   label: "Evaluation Scorecard", render: secEvaluation,   when: (p) => has(p.scorecard) || has(p.evaluation) },
  { id: "team",         label: "Team & Burden",        render: secTeam,         when: (p) => has(p.team) || has(p.roster) },
  { id: "questions",    label: "Questions",            render: secQuestions,    when: (p) => has(p.questions), count: (p) => arr(p.questions).length || null },
  { id: "risks",        label: "Risks & Signals",      render: secRisks,        when: (p) => has(p.risks) || has(p.signals) },
  { id: "decisions",    label: "Record",               render: secDecisions,    when: (p) => has(p.decisions) || has(p.parkingLot) || has(p.meetings), count: (p) => arr(p.decisions).length || null },
  /* Documents is a LAUNCHER, not a page: the way it gets used is "bam, bam,
     bam, you can get the docs you need". chrome:true keeps it out of the nav
     and reachable from the header, which removes a tab and makes it available
     from every section instead of one. */
  { id: "documents",    label: "Documents",            render: secDocuments,    chrome: true, when: (p) => has(p.documents), count: (p) => arr(p.documents).length || null },
];

/* Old routes keep working. */
/* Set once per render, before section bodies are built. */
let BASE_ROUTE = "#";
const goHref = (id) => (BASE_ROUTE === "#" ? "#" : `${BASE_ROUTE}/${id}`);

const SECTION_ALIASES = { ask: "snapshot", checklist: "plan", dates: "plan", rules: "compliance", requirements: "compliance", scorecard: "evaluation", record: "decisions" };

/* ---------- date kinds ----------
   Two clocks were being drawn on one rail and read as one sequence. A RESPONSE
   date is something we must hit to stay in the process — questions due,
   submission, orals, award. A PROGRAM date is something the client has told us
   about their own world — contract start, go-live, phase gates. Mixed together
   you get a timeline where "in 4 days" and "in 14 months" share a rail, and the
   eye reads the far date as slack on the near one.

   So: classify, colour, and show ONE kind at a time by default. The pack may
   state `kind` outright; where it does not the label decides. Unclassifiable
   falls to "response", because an unlabelled date on an RFP brief is far more
   likely to belong to the submission clock than to the client's programme. */
const PROGRAM_WORDS = /(start|commenc|kick[- ]?off|kickoff|go[- ]?live|golive|launch|transition|onboard|mobilis|mobiliz|ramp|cut[- ]?over|phase|milestone|contract|renewal|expir|implementation|steady state|hand[- ]?over)/i;
const RESPONSE_WORDS = /(q&a|q ?and ?a|question|clarification|addend|amend|intent|nda|submi|due|proposal|bid|tender|oral|present|demo|shortlist|award|notif|evaluat|interview|registration|portal|deadline|pre[- ]?bid|site visit|conference|response)/i;

const KIND_LABEL = { response: "Response", program: "Program" };

function dateKind(d) {
  const stated = String((d && d.kind) || "").toLowerCase();
  if (stated === "program" || stated === "programme") return "program";
  if (stated === "response" || stated === "procurement") return "response";
  const t = String((d && d.type) || "").toLowerCase();
  if (t === "program" || t === "programme" || t === "milestone") return "program";
  if (t === "qa" || t === "submission" || t === "award" || t === "orals") return "response";
  const label = `${(d && d.label) || ""} ${(d && d.ourAction) || ""}`;
  if (RESPONSE_WORDS.test(label)) return "response";
  return PROGRAM_WORDS.test(label) ? "program" : "response";
}

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
    : `<p class="rb-empty">No roster captured yet.</p>`;

  // Zone 3 — WHAT'S NEEDED
  const blockers = arr(p.actionItems)
    .filter((i) => i.status !== "done")
    .sort((a, b) => (daysFromNow(a.due) ?? 9e3) - (daysFromNow(b.due) ?? 9e3))
    .slice(0, 5);
  /* No stage label. It was self-reported and nothing kept it honest, so it went
     stale and taught people to distrust the board. What replaces it is derived
     and therefore always true: how much is outstanding, and how long is left. */
  const openCount = arr(p.actionItems).filter((i) => i.status !== "done").length;
  const unowned = arr(p.actionItems).filter((i) => i.status !== "done" && !i.owner).length;

  const outlook = p.signals?.winLikelihood
    ? `<div class="rb-zone rb-outlook">Outlook: <b>${esc(p.signals.winLikelihood)}</b>${
        summariseSignals(p.signals)} <a href="${goHref("risks")}" data-goto="risks">Details&nbsp;→</a></div>`
    : "";

  return `
    <div class="rb-snapshot">
      <div class="rb-masthead">
        <div>
          <div${edIn(ctx, "client", "rb-eyebrow")}>${esc(p.client)}</div>
          <h1${edIn(ctx, "title", "rb-h1")}>${esc(p.title || "RFP brief")}</h1>
        </div>
      </div>

      ${deadline}
      ${askParas ? `<div class="rb-zone" style="margin-top:0">${askParas}</div>` : ""}

      ${verdict}

      <div class="rb-zone">
        <div class="rb-zone-head"><span>Who's involved</span></div>
        <p class="rb-sub rb-small" style="margin-bottom:12px">${esc(p.client)}${
          lead ? ` · our response lead is <b>${esc(lead.name)}</b>` : ""}</p>
        ${whoBody}
      </div>

      <div class="rb-zone">
        <div class="rb-zone-head"><span>What's needed next</span></div>
        <p class="rb-sub rb-small" style="margin-bottom:12px"><b>${
          openCount ? plural(openCount, "open item") : "Nothing outstanding"}</b>${
          unowned ? ` \u00b7 ${unowned} unassigned` : ""}${
          subDays !== null && subDays >= 0 ? ` \u2014 submission in ${plural(subDays, "day")}` : ""}</p>
        ${blockers.length
          ? `<ul class="rb-needs">${blockers.map((b) => {
              const late = daysFromNow(b.due) < 0;
              return `<li><span>${esc(b.task)}</span>
                <span class="rb-need-owner">${b.owner ? esc(b.owner) : "unassigned"}</span>
                <span class="rb-need-due ${late ? "is-late" : ""}">${b.due ? esc(fmtDate(b.due)) : "—"}</span></li>`;
            }).join("")}</ul>`
          : `<p class="rb-empty">No open action items.</p>`}
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
    <div class="rb-bar"><i style="width:${pct(r.value)}%"></i></div>
    <details class="rb-expand"><summary>How this is computed</summary>
      <div class="rb-expand-body">
        <ul class="rb-rows">${r.inputs.map((i) => `
          <li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:46px">
            <span class="rb-row-text">${esc(i.key)}<br><span class="rb-meta">${esc(i.detail)}</span></span>
            <span></span><span></span>
            <b class="rb-meta r" style="color:var(--rb-ink);font-size:13px">${pct(i.value)}%</b>
          </div></li>`).join("")}</ul>
        <div class="rb-formula">readiness = mean(${r.inputs.map((i) => pct(i.value) + "%").join(", ")})</div>
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
            <span class="rb-row-text"><i class="rb-kdot" data-kind="${m.kind || "response"}"></i>${esc(m.label)}</span><span></span>
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


/* ---------- the shared list ----------
   Standing rule from the feedback sessions: EVERY list gets filter, collapse and
   a status. It is a pattern, not a per-section judgement — there are nine lists
   in this brief and hand-rolling filters per section is how they diverge.

   Filtering is CSS, driven by data-filter on the wrapper. That is deliberate:
   re-rendering to filter would destroy focus, selection and any half-typed
   value in edit mode, and would fight the live-sync guard in app.js. Nothing
   about the pack changes when you filter, so nothing should re-render.

   Status vocabulary is three values and only three — done | open | atRisk —
   identical in every list. atRisk is DERIVED here at render time, never stored,
   or it goes stale the moment a due date passes. */

const rowStatus = (row, { mandatoryMatters = false } = {}) => {
  const s = String(row.status || (row.checked ? "done" : "open")).toLowerCase();
  if (s === "done" || row.checked) return "done";
  const dd = daysFromNow(row.due);
  const late = dd !== null && dd < 3;
  const unowned = mandatoryMatters && row.mandatory && !row.owner;
  return late || unowned ? "atRisk" : "open";
};

const STATUS_LABEL = { done: "done", open: "open", atRisk: "at risk" };

/* rows: [{ html, status, owner }] */
function listBlock(ctx, key, title, rows, opts = {}) {
  if (!rows.length) return "";
  const n = (s) => rows.filter((r) => r.status === s).length;
  const owners = new Set(rows.map((r) => r.owner).filter(Boolean));
  const collapsed = ctx.collapsed.has(key);

  const chip = (id, label, count, on) => count === 0 && id !== "all" ? "" :
    `<button type="button" class="rb-chip-f" data-lchip="${id}" data-list="${esc(key)}"
       aria-pressed="${on}">${label}<span class="rb-chip-n">${count}</span></button>`;

  const showMine = !!ctx.me && owners.has(ctx.me);
  const controls = `<div class="rb-chips" role="group" aria-label="Filter ${esc(title)}">
      ${chip("all", "All", rows.length, true)}
      ${chip("open", "Open", n("open"), false)}
      ${chip("atRisk", "At risk", n("atRisk"), false)}
      ${chip("done", "Done", n("done"), false)}
      ${showMine ? chip("mine", "Mine", rows.filter((r) => r.owner === ctx.me).length, false) : ""}
    </div>`;

  return `<div class="rb-group rb-list" data-list="${esc(key)}" data-filter="all">
    <div class="rb-group-head">
      <button type="button" class="rb-collapse" data-lcollapse="${esc(key)}"
        aria-expanded="${!collapsed}"><span class="rb-caret" aria-hidden="true"></span>${esc(title)}</button>
      <span class="rb-nav-count">${plural(rows.length, opts.unit || "item")}</span>
    </div>
    <div class="rb-list-body"${collapsed ? " hidden" : ""}>
      ${/* Standing rule: every list gets filters. Offer them when there is
            actually something to filter BY — more than one status present, or a
            list long enough that scanning it is work. A single chip row over
            three identical rows is noise, not affordance. */""}
      ${(rows.length > 3 || new Set(rows.map((r) => r.status)).size > 1 || showMine) ? controls : ""}
      <ul class="rb-rows">${rows.map((r) =>
        `<li data-status="${r.status}"${r.owner ? ` data-owner="${esc(r.owner)}"` : ""}${
          r.el ? ` data-el="${esc(r.el)}"` : ""}>${r.html}</li>`).join("")}</ul>
      <p class="rb-empty rb-filter-empty" hidden>Nothing matches that filter.</p>
    </div>
  </div>`;
}

const statusPill = (s) => `<span class="rb-status" data-s="${s}">${STATUS_LABEL[s]}</span>`;

/* A checkbox that closes a row without entering edit mode. Offered only when the
   host can actually persist it — in the standalone HTML brief there is nowhere to
   write, and a checkbox that forgets is worse than no checkbox. */
function tick(ctx, coll, id, on, label, field) {
  if (!ctx.canTick || ctx.edit) return "";
  return `<input class="rb-tick" type="checkbox" data-tick="${coll}" data-id="${esc(id)}"
    data-tickf="${field || "status"}"${on ? " checked" : ""}
    aria-label="Mark done: ${esc(String(label || id).slice(0, 60))}">`;
}


/* ---------- composite sections (the 12 -> 8 merge) ---------- */

/* Scope: the snapshot, with The Ask folded in underneath rather than living in
   its own tab. It was skipped as "pretty straightforward" in every session —
   it is narrative context for the screen above it, not a destination. */
/* No "the ask, in full" fold. The TLDR already opens with the ask in two plain
   sentences and the verdict beneath it; repeating the same content one click
   down is the duplication this tab exists to avoid. What was only in the fold —
   background and what-done-looks-like — is one edit away in the pack and belongs
   in the summary if it earns the space. */
function secScope(p, d, ctx) {
  return secSnapshot(p, d, ctx);
}

/* Plan: where we are, what is next, who owns it. Key Dates and the Action
   Checklist answered halves of one question and neither could give the
   "where are we today" view on its own. The timeline is the frame; the
   checklist is the content, so the timeline collapses once there is work. */
/* Plan is the status tab. Readiness, the critical path and who is carrying what
   all moved HERE from the TLDR, because they answer "how are we doing" and the
   TLDR answers "what is this" — two different questions that were sharing one
   screen and making it a dashboard instead of a read-out. */
function secPlan(p, d, ctx) {
  const items = arr(p.actionItems);
  const dates = secDates(p, d, ctx, { bare: true });
  const timelineOpen = !items.length;
  const r = d.readiness;

  /* The number, then the reason the number is not 100. A percentage with no
     stated cause is a score; a percentage with its blockers under it is a
     to-do list. Each blocker is a link into the exact row. */
  const blockers = r.ok && r.gaps.length
    ? `<ul class="rb-blockers">${r.gaps.map((g) => `
        <li><a href="${goHref(g.goto)}" data-goto="${g.goto}"${g.el ? ` data-el="${esc(g.el)}"` : ""}>${esc(g.text)}</a></li>`).join("")}</ul>`
    : r.ok
    ? `<p class="rb-small rb-muted" style="margin-top:10px">Nothing outstanding — every requirement is owned, every item is closed, and the client has answered.</p>`
    : "";

  return head("Readiness") +
    `<div class="rb-zone rb-pulse" style="margin-top:0">
       ${tileReadiness(d.readiness)}
       ${tileCountdown(d.criticalPath)}
     </div>` +
    blockers +
    /* No "who's carrying what" grid. It arrived as the honest home for owner
       load and earned its place on paper, but on a real pursuit it is a matrix
       of ones and zeroes that tells you less than the checklist directly above
       it — which is already grouped by owner and counts itself. The heatmap()
       function is kept: it is the right instrument once themes are populated
       enough to have a shape, and Team is where it will land if it returns. */
    secChecklist(p, d, ctx) +
    `<details class="rb-fold"${timelineOpen ? " open" : ""} data-el="timeline">
       <summary><span class="rb-caret" aria-hidden="true"></span>Key dates</summary>
       <div class="rb-fold-body">${dates}</div>
     </details>`;
}

/* Compliance: submission rules plus client requirements. Asked to describe the
   difference between the two as separate tabs, readers could not: "are they the
   same thing? Are we looking at two different things here?" */
function secCompliance(p, d, ctx) {
  return head("Rules & Requirements") +
    secRules(p, d, ctx) + secRequirements(p, d, ctx);
}

/* ---------- 2. Action Checklist ---------- */
function secChecklist(p, d, ctx) {
  const items = arr(p.actionItems);
  const add = addBtn(ctx, "actionItems", "Add an item");

  if (!items.length) return subhead("What we need from you") + add +
    `<p class="rb-empty">No action items yet.</p>`;

  const owners = [...new Set(items.map((i) => i.owner || "Unassigned"))]
    .sort((a, b) => (a === "Unassigned" ? 1 : b === "Unassigned" ? -1 : a.localeCompare(b)));

  return subhead("What we need from you") +
    add +
    owners.map((o) => {
      const mine = items.filter((i) => (i.owner || "Unassigned") === o);
      return listBlock(ctx, `act:${o}`, o, mine.map((i) => {
        const st = rowStatus(i);
        const late = st !== "done" && daysFromNow(i.due) < 0;
        return {
          status: st,
          owner: i.owner || "",
          el: `action-${i.id}`,
          html: ctx.edit
            ? `<div class="rb-row is-edit">
                 <span class="rb-id">${esc(i.id || "")}</span>
                 <input class="rb-in rb-in-text" data-edit="task" data-coll="actionItems" data-id="${esc(i.id)}"
                        value="${esc(i.task)}" aria-label="Task">
                 ${ownerSelect(ctx, i.id, "actionItems", i.owner)}
                 <input class="rb-in" type="date" data-edit="due" data-coll="actionItems" data-id="${esc(i.id)}"
                        value="${esc(dateVal(i.due))}" aria-label="Due date">
                 ${statusSelect(i.id, "actionItems", i.status)}
                 <button class="rb-del" data-del="actionItems" data-id="${esc(i.id)}" title="Delete item"
                         aria-label="Delete ${esc(i.id)}">×</button>
               </div>`
            : `<div class="rb-row" style="--rb-c1:62px;--rb-c2:104px;--rb-c3:104px">
                 <span class="rb-id">${tick(ctx, "actionItems", i.id, st === "done", i.task)}${esc(i.id || "")}</span>
                 <span class="rb-row-text ${st === "done" ? "is-done" : ""}">${esc(i.task)}</span>
                 <span class="rb-meta r">${i.requirementId
                   ? `<a href="${goHref("compliance")}" data-goto="compliance" data-el="req-${esc(i.requirementId)}">${esc(i.requirementId)}</a>` : ""}</span>
                 <span class="rb-meta r ${late ? "is-late" : ""}">${i.due ? esc(fmtDate(i.due)) + (late ? " · late" : "") : ""}</span>
                 ${statusPill(st)}
               </div>`,
        };
      }), { unit: "item" });
    }).join("");
}

/* ---------- The Ask ----------
   No section, no fold. The TLDR opens with ask.summary and ask.background as
   editable prose, which is the whole of what people read. ask.doneLooksLike is
   still carried in the pack and still exported to /DRAFT — it is simply not
   given a tab of its own, because a tab that repeats the screen above it is the
   duplication this restructure removed. */

/* ---------- 4. Key Dates ---------- */
function secDates(p, d, ctx, opts = {}) {
  /* The six-step stage stepper was REMOVED, not restyled.
     It only ever moved when a human remembered to move it, and a pursuit
     showing "Drafting" three weeks after it was submitted is worse than showing
     nothing — it teaches people the board is stale. Everything here is derived
     from dates in the documents instead, so it cannot rot. The one thing the
     stepper was genuinely good for — "where are we today" — is the TODAY marker
     and the muted past dates below. */
  const title = opts.bare ? "" : subhead("Key dates");
  const rows = d.criticalPath.ok ? d.criticalPath.milestones : [];
  if (!rows.length) return title + `<p class="rb-empty">No dates captured.</p>`;

  const nResp = rows.filter((m) => m.kind === "response").length;
  const nProg = rows.filter((m) => m.kind === "program").length;
  /* Default to whichever kind the pursuit actually has. Both present: response,
     because that is the clock that can lose you the bid. */
  const start = nResp ? "response" : "program";
  const both = nResp && nProg;

  const chip = (id, label, count) => count === 0 && id !== "all" ? "" :
    `<button type="button" class="rb-chip-f" data-tchip="${id}"
       aria-pressed="${String(id === start)}">${label}<span class="rb-chip-n">${count}</span></button>`;

  /* The key is only earned when there are two things to tell apart. On a pursuit
     with response dates only, a legend explaining a distinction that is not on
     screen is the explanatory helper text we spent a pass removing. */
  const key = both
    ? `<div class="rb-key" aria-hidden="true">
         <span class="rb-key-i" data-kind="response"><i></i>Response — ours to hit</span>
         <span class="rb-key-i" data-kind="program"><i></i>Program — the client's own dates</span>
       </div>`
    : "";

  const firstUpcoming = (kind) => rows.findIndex((m) => m.days >= 0 && m.kind === kind);
  const nextResp = firstUpcoming("response"), nextProg = firstUpcoming("program");
  const nextAttr = (i) => i === nextResp ? ' data-next="response"' : i === nextProg ? ' data-next="program"' : "";

  return title +
    (both
      ? `<div class="rb-chips" role="group" aria-label="Filter key dates by kind">
           ${chip("response", "Response", nResp)}${chip("program", "Program", nProg)}${chip("all", "Both", rows.length)}
         </div>`
      : "") +
    key +
    `<div class="rb-timewrap" data-kind="${start}">
      <ul class="rb-timeline">${rows.map((m, i) => `
        <li data-kind="${m.kind}"${nextAttr(i)} class="${m.days < 0 ? "is-past" : ""}" data-el="date-${esc(m.id || i)}">
          <div class="rb-tl-date">${esc(m.id === "submission" ? fmtDeadline(m.date) : fmtDate(m.date))} \u00b7 ${
            m.days < 0 ? `${Math.abs(m.days)} days ago` : `in ${plural(m.days, "day")}`}</div>
          <div class="rb-tl-title">${esc(m.label)}</div>
          ${has(m.ourAction) && m.ourAction !== "\u2014" ? `<div class="rb-sub rb-small">We must: ${esc(m.ourAction)}</div>` : ""}
        </li>`).join("")}</ul>
      <p class="rb-empty rb-filter-empty" hidden>Nothing matches that filter.</p>
    </div>`;
}

/* ---------- 5. Rules & Constraints ---------- */
function secRules(p, d, ctx) {
  const rules = arr(p.rules);
  if (!rules.length) return "";
  return subhead("To bid at all, we must obey this",
    `${plural(rules.length, "rule")} governing the submission — miss one and the bid is discarded unread`) +
    `<ul class="rb-rows">${rules.map((r) => `
      <li data-el="rule-${esc(r.id)}"><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:170px">
        <span${edIn(ctx, `rules[id=${r.id}].label`, "rb-row-text")}>${esc(r.label)}</span>
        <span></span>
        <span></span>
        <span class="rb-meta r">${ctx.edit ? delBtn(ctx, "rules", r.id) : srcLink(r.source, ctx)}</span>
      </div></li>`).join("")}</ul>` + addBtn(ctx, "rules", "Add a rule");
}

/* ---------- 6. Scorecard ---------- */
/* Renamed from "Evaluation" on user evidence, not taste: "evaluation could mean
   a lot of things, but if I think scorecard, I know exactly what this means."
   Three participants across two sessions reached for the same word — and in a
   staffing company "evaluation" collides with supplier scorecards and QBRs, so
   people read it as how the client rates US on an existing contract.

   The section id stays "evaluation" so links like #/b/x/evaluation keep working.
   Both field shapes are read: schema v4 renames evaluation -> scorecard and
   gates -> successCriteria, but a pack cached in IndexedDB before this deploy is
   still stored at v3, so falling back costs one ?? and removes a whole class of
   "my brief went blank after the update". */
function secEvaluation(p, d, ctx) {
  const e = p.scorecard || p.evaluation || {};
  const criteriaOf = arr(e.criteria);
  const crit = criteriaOf;
  const success = arr(e.successCriteria).length ? arr(e.successCriteria) : arr(e.gates);
  const max = Math.max(1, ...crit.map((c) => Number(c.weight) || 0));
  const total = crit.reduce((n, c) => n + (Number(c.weight) || 0), 0);
  /* The subtitle is the specific thing that made this legible in testing: the
     scoring mechanic stated immediately under the heading, before the bars. */
  const mechanic = crit.length
    ? `Scored out of ${total || 100}. Heaviest weight: ${esc(crit.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0))[0].name)}.`
    : "How they score it — and therefore where effort pays.";
  return head("Scorecard", mechanic) +
    (crit.length
      ? `<ul class="rb-weights">${crit.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0)).map((c) => `
          <li><span>${esc(c.name)}</span>
            <span class="rb-weight-bar"><i style="width:${((c.weight || 0) / max) * 100}%"></i></span>
            <span class="rb-weight-num">${esc(c.weight)}%</span></li>`).join("")}</ul>`
      : `<p class="rb-empty">No scoring weights stated.</p>`) +
    /* Was "Pass / fail gates" — a misleading name over mis-modelled content.
       Nobody could relate it to the weights beside it ("what percentage means
       that I fail?") because these are not thresholds: they are stated
       must-haves and explicit rule-outs, often said aloud at kickoff rather
       than written in the RFP. */
    (success.length
      ? `<div class="rb-group"><div class="rb-group-head"><span>Criteria for success</span><span class="rb-nav-count">${success.length}</span></div>
         <ul class="rb-rows">${success.map((g) => `<li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:0px">
           <span class="rb-row-text">${esc(typeof g === "string" ? g : (g.text || g.basis || ""))}</span><span></span><span></span><span></span></div></li>`).join("")}</ul></div>` : "") +
    (has(e.guidance)
      ? `<div class="rb-verdict" style="margin-top:var(--rb-s4)"><p><b>Where to over-invest</b><span${
          ed(ctx, p.scorecard ? "scorecard.guidance" : "evaluation.guidance")}>${esc(e.guidance)}</span></p></div>` : "");
}

/* ---------- 7. Requirements ---------- */
function secRequirements(p, d, ctx) {
  const reqs = arr(p.requirements);
  if (!reqs.length) return "";
  const themes = [...new Set(reqs.map((r) => r.theme || "Ungrouped"))];

  const rowFor = (r) => ({
    status: rowStatus(r, { mandatoryMatters: true }),
    owner: r.owner || "",
    el: `req-${r.id}`,
    html: `<div class="rb-row" style="--rb-c1:104px;--rb-c2:104px;--rb-c3:0px">
        <span class="rb-id">${tick(ctx, "requirements", r.id, r.status === "done", r.text)}${esc(r.id)}</span>
        <span class="rb-row-text">${ctx.edit
          ? `<span${ed(ctx, `requirements[id=${r.id}].text`)}>${esc(r.text)}</span>`
          : has(r.verbatim) || has(r.source)
          ? `<details class="rb-expand rb-inline"><summary>${esc(r.text)}</summary>
               <div class="rb-expand-body rb-measure">
                 ${has(r.verbatim) ? `<p style="white-space:pre-wrap">${esc(r.verbatim)}</p>` : ""}
                 <p class="rb-src" style="margin-top:8px">${srcLink(r.source, ctx)}</p>
               </div></details>`
          : esc(r.text)}</span>
        <span class="rb-meta r">${ctx.edit
          ? ownerSelect(ctx, r.id, "requirements", r.owner)
          : esc(r.owner || "unowned")}</span>
        ${ctx.edit
          ? statusSelect(r.id, "requirements", r.status)
          : statusPill(rowStatus(r, { mandatoryMatters: true }))}
      </div>`,
  });

  return subhead("If we win, we deliver this",
    `${plural(reqs.length, "requirement")} — the scope we are committing to`) +
    themes.map((th) => listBlock(ctx, `req:${th}`, th,
      reqs.filter((r) => (r.theme || "Ungrouped") === th).map(rowFor),
      { unit: "requirement" })).join("");
}

const COMPETENCIES = [
  "Data Collection & Benchmarking",
  "UX Research",
  "Product Design",
  "Development & Engineering",
  "Annotation & Model Training",
  "Strategy & Transformation",
  "Cloud & Platform Engineering",
  "Data, Analytics & AI",
  "Quality & Test Automation",
  "DevSecOps & Service Management",
];
const compKey = (n) => String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const COMP_INDEX = new Map(COMPETENCIES.map((n, i) => [compKey(n), i]));
const compRank = (n) => (COMP_INDEX.has(compKey(n)) ? COMP_INDEX.get(compKey(n)) : 99);
const offMenu = (n) => !COMP_INDEX.has(compKey(n));

/* ---------- 8. Team & Burden ---------- */
function secTeam(p, d, ctx) {
  const t = p.team || {};
  /* HOURS ONLY. FTE is gone from this view, not de-emphasised: "I do not
     understand the function of 0.5 FTE — is it suggesting a headcount?" In a
     staffing company a fractional FTE reads as permanent headcount to hire, and
     the number was never that. It was always effort. `fte` is still accepted in
     the pack and is no longer rendered anywhere. */
  const comps = arr(t.competencies).slice()
    .sort((a, b) => compRank(a.name) - compRank(b.name) || String(a.name).localeCompare(String(b.name)));
  const hoursOf = (c) => (Number(c.hours) || 0);
  const aiOf = (c) => (Number(c.hoursAi) || 0);
  const totalHours = comps.reduce((s, c) => s + hoursOf(c), 0);
  const totalAi = comps.reduce((s, c) => s + (aiOf(c) || hoursOf(c)), 0);
  /* The toggle is offered only when the pack carries a second estimate. A saving
     the analysis did not calculate is not a saving, and inventing an uplift
     factor here would put a made-up number next to a real one. */
  const hasAi = comps.some((c) => aiOf(c) > 0);
  const saving = totalHours && hasAi ? Math.round((1 - totalAi / totalHours) * 100) : 0;
  const hrs = (n) => (n ? `${n.toLocaleString()} hrs` : "\u2014");
  const DIST = { front: "front-loaded", back: "back-loaded", even: "spread evenly" };
  return head("Team & burden", "To deliver, not to respond. DRAFT.") +
    (arr(p.roster).length
      ? `<div class="rb-group"><div class="rb-group-head"><span>Roster</span><span class="rb-nav-count">${p.roster.length}</span></div>
         <ul class="rb-rows">${p.roster.map((r) => `
           <li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:200px">
             <span class="rb-row-text"><b>${esc(r.name)}</b></span><span></span><span></span>
             <span class="rb-meta r">${esc(r.role || "")}</span></div></li>`).join("")}</ul></div>` : "")
    +
    (comps.length
      ? `<div class="rb-group rb-effort" data-basis="${hasAi ? "ai" : "analog"}">
           <div class="rb-group-head"><span>Competencies the RFP demands</span>
             <span class="rb-nav-count"><span class="rb-e-analog">${hrs(totalHours)}</span><span class="rb-e-ai">${
               hrs(totalAi)}</span> draft${
               has(t.distribution) ? ` \u00b7 ${esc(DIST[t.distribution] || t.distribution)}` : ""}</span></div>
           ${hasAi
             ? `<div class="rb-chips" role="group" aria-label="Estimate basis">
                  <button type="button" class="rb-chip-f" data-basis="ai" aria-pressed="true">AI-assisted<span class="rb-chip-n">${
                    hrs(totalAi)}</span></button>
                  <button type="button" class="rb-chip-f" data-basis="analog" aria-pressed="false">Analog<span class="rb-chip-n">${
                    hrs(totalHours)}</span></button>
                  ${saving > 0 ? `<span class="rb-e-saving">${saving}% less with AI in the delivery model</span>` : ""}
                </div>`
             : ""}
         <ul class="rb-rows">${comps.map((c) => `
           <li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:180px;--rb-c3:88px">
             <span class="rb-row-text">${esc(c.name)}${
               offMenu(c.name) ? ` <span class="rb-src">outside our ten areas of expertise</span>` : ""}</span><span></span>
             <span class="rb-meta r">${arr(c.requirementIds).length ? esc(c.requirementIds.join(", ")) : ""}</span>
             <b class="rb-meta r" style="color:var(--rb-ink)"><span class="rb-e-analog">${
               hrs(hoursOf(c))}</span><span class="rb-e-ai">${hrs(aiOf(c) || hoursOf(c))}</span></b></div></li>`).join("")}</ul></div>`
      : `<p class="rb-empty">No competency breakdown.</p>`)
    +
    (arr(t.keyPersonnel).length
      ? `<div class="rb-group"><div class="rb-group-head"><span>Key personnel mandates</span><span class="rb-nav-count">${t.keyPersonnel.length}</span></div>
         <ul class="rb-rows">${t.keyPersonnel.map((k) => `<li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:0px">
           <span class="rb-row-text">${esc(typeof k === "string" ? k : k.text || k.name)}</span>
           <span></span><span></span><span></span></div></li>`).join("")}</ul></div>` : "")
    +
    "";   // who is carrying what lives in Plan — this tab is about delivery, not response workload
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
      ${head("Questions for client")}
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
            ? `<a href="${goHref("compliance")}" data-goto="requirements" data-el="req-${esc(q.requirementId)}">${esc(q.requirementId)}</a>` : "")}</span>
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
      ? `<div class="rb-verdict"><p><b>Win likelihood — DRAFT</b><span><b>${esc(s.winLikelihood)}</b></span></p></div>` : "") +
    `<div class="rb-signals">
      ${group("Working against us", s.red, "red")}
      ${group("Working for us", s.green, "green")}
      ${/* "beige" tested badly — nobody could guess what it meant or which
            direction it pointed. Renamed to soft signals in schema v4; the old
            key is still read for packs cached before this deploy. */""}
      ${group("Soft signals", s.soft || s.beige, "beige")}
      ${arr(s.unknown).length ? `<p class="rb-small rb-muted">Still unknown: ${esc(s.unknown.join(", "))}</p>` : ""}
    </div>` +
    (risks.length
      ? `<div class="rb-group"><div class="rb-group-head"><span>Risks</span><span class="rb-nav-count">${risks.length}</span></div>
         <div style="margin-top:6px">${risks.map((r) => `<div class="rb-risk" data-sev="${esc(r.severity || "")}" data-el="risk-${esc(r.id || r.title)}">
            <div class="rb-sev">${esc(r.severity || "")}</div>
            <div>
              <div${edIn(ctx, `risks[id=${r.id}].title`, "rb-risk-title")}>${esc(r.title)}</div>
              ${/* Collapsed by default so the list stays scannable: "the only thing
                    maybe you could consider doing is having it minimized and then you
                    have the option to hit like a little plus". In edit mode it opens,
                    because you cannot edit what you cannot see. */""}
              ${(has(r.detail) || has(r.mitigation) || has(r.strategicResponse) || ctx.edit)
                ? `<details class="rb-expand rb-risk-more"${ctx.edit ? " open" : ""}>
                     <summary><span class="rb-caret" aria-hidden="true"></span>Detail</summary>
                     <div class="rb-expand-body">
                       ${has(r.detail) || ctx.edit ? `<p${edIn(ctx, `risks[id=${r.id}].detail`, "rb-sub rb-small")}>${esc(r.detail || "")}</p>` : ""}
                       ${has(r.mitigation) || ctx.edit ? `<p${edIn(ctx, `risks[id=${r.id}].mitigation`, "rb-mitigation")}>${esc(r.mitigation || "")}</p>` : ""}
                       ${has(r.strategicResponse)
                         ? `<p${edIn(ctx, `risks[id=${r.id}].strategicResponse`, "rb-strategy")}><b>Our response:</b> ${esc(r.strategicResponse)}</p>`
                         : ""}
                     </div></details>`
                : ""}
            </div>
            ${delBtn(ctx, "risks", r.id)}
          </div>`).join("")}</div></div>` : "") + addBtn(ctx, "risks", "Add a risk");
}

/* ---------- 11. Decisions & Parking Lot ---------- */
function secDecisions(p) {
  const ds = arr(p.decisions), pl = arr(p.parkingLot), ms = arr(p.meetings);
  if (!ds.length && !pl.length && !ms.length)
    return head("Record") +
      `<p class="rb-empty">Nothing recorded yet.</p>`;
  const row = (main, meta) => `<li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:0px">
    <span class="rb-row-text"><b>${main}</b><br><span class="rb-meta">${meta}</span></span>
    <span></span><span></span><span></span></div></li>`;
  /* "Decisions" alone was ambiguous — pending, or made? And "parking lot is a
     dumb name". Placed last in the nav because nobody reaches for it first
     ("more of an afterthought tab"), but kept, because "everybody needs to have
     one place where they have equal visibility". */
  return head("Record") +
    (ds.length ? `<div class="rb-group"><div class="rb-group-head"><span>Decisions made</span><span class="rb-nav-count">${ds.length}</span></div>
      <ul class="rb-rows">${ds.map((x) => row(esc(x.text || x.decision),
        [x.by, fmtDate(x.at), x.meeting, x.binds].filter(has).map(esc).join(" · "))).join("")}</ul></div>` : "") +
    (pl.length ? `<div class="rb-group"><div class="rb-group-head"><span>Open items</span><span class="rb-nav-count">${pl.length}</span></div>
      <ul class="rb-rows">${pl.map((x) => row(esc(x.text),
        [x.by, x.why, x.disposition || "open"].filter(has).map(esc).join(" · "))).join("")}</ul></div>` : "") +
    (ms.length ? `<div class="rb-group"><div class="rb-group-head"><span>Meetings</span><span class="rb-nav-count">${ms.length}</span></div>
      <ul class="rb-rows">${ms.map((m) => `<li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:110px;--rb-c3:110px">
        <span class="rb-row-text"><b>${esc(m.type)}</b></span><span></span>
        <span class="rb-meta r">${esc(fmtDate(m.date))}</span>
        <span class="rb-meta r">${arr(m.attendees).length} attended${m.duration ? ` · ${esc(m.duration)}` : ""}</span>
      </div></li>`).join("")}</ul></div>` : "");
}

/* ---------- 12. Document Map ---------- */
function secDocuments(p, d, ctx) {
  const docs = arr(p.documents);
  if (!docs.length) return head("Documents") + `<p class="rb-empty">No source documents recorded.</p>`;
  const anyMissing = docs.some((doc) => !doc.unreadable && !ctx.resolveDoc(doc));
  return head("Documents") +
    (anyMissing ? `<div class="rb-notice">Some of these files are not on the board. A file over
       the attachment limit stays on the machine that imported the pack — re-import the bundle,
       or open it from there.</div>` : "") +
    `<div>${docs.map((doc) => {
      const href = ctx.resolveDoc(doc);
      const name = doc.unreadable || !href
        ? `<span class="rb-doc-name">${esc(doc.file)}</span> <span class="rb-src">${
            doc.unreadable ? "unprocessed — could not be read"
            : "not on this device — open it from the machine that imported the pack"}</span>`
        : `<a class="rb-doc-name rb-doclink" href="${esc(href)}" ${docTarget(doc, href)} data-doc="${esc(doc.file)}">${esc(doc.file)}</a>`;
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
const isFetchHref = (h) => typeof h === "string" && h.startsWith("#fetch/");
const docTarget = (doc, href) => isFetchHref(href) ? ""
  : VIEWABLE.includes(String(doc.type || "").toLowerCase())
  ? 'target="_blank" rel="noopener"' : `download="${esc(doc.file)}"`;

/* ---------- shared bits ---------- */
/* A heading for a block that lives INSIDE a composite section — one h2 per
   screen, or the page grows two competing titles. */
function subhead(title, sub) {
  return `<h3 class="rb-h3 rb-subhead">${esc(title)}</h3>${
    sub ? `<p class="rb-sub rb-small">${esc(sub)}</p>` : ""}`;
}

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
    ? `<a class="rb-src rb-doclink" href="${esc(href)}" ${docTarget(doc, href)} data-doc="${esc(src.doc)}">${esc(label)}</a>`
    : `<span class="rb-src">${esc(label)}</span>`;
}

/* ============================================================
   MOUNT
   ============================================================ */

export function renderBrief(pack, mount, opts = {}) {
  const o = {
    section: "snapshot", mode: "read",
    onNavigate: () => {}, onDerive: () => {}, onMeetingStart: null,
    onEdit: null, me: "",
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
    /* What the Library card shows. Requirement COUNT is kept for the nav badge
       but is deliberately not what a card leads with: readers parsed "22 reqs"
       as Bullhorn requisitions, and an inventory total is not a reason to click.
       Unassigned and at-risk are, because they are unfinished work. */
    counts: {
      requirements: arr(pack.requirements).length,
      openItems: arr(pack.actionItems).filter((i) => i.status !== "done").length,
      questions: arr(pack.questions).length,
      unassigned: arr(pack.actionItems).filter((i) => i.status !== "done" && !i.owner).length,
      atRisk: [...arr(pack.actionItems), ...arr(pack.requirements)]
        .filter((r) => rowStatus(r, { mandatoryMatters: true }) === "atRisk").length,
    },
    responseLift: pack.responseLift && pack.responseLift.size
      ? { size: pack.responseLift.size, basis: pack.responseLift.basis || "" } : null,
  });

  const docsByName = Object.fromEntries(arr(pack.documents).map((x) => [x.file, x]));
  const ctx = {
    edit: o.mode === "edit" && !!o.onEdit,
    roster: [...new Set(arr(pack.roster).map((r) => r.name).filter(Boolean))],
    /* Collapsed groups and "Mine" are viewing preferences, not content — they
       belong to the person, not the pack. me is supplied by the host app; with
       no name the Mine chip is simply not offered rather than shown broken. */
    collapsed: readCollapsed(pack.briefId),
    me: o.me || "",
    canTick: !!o.onEdit,
    docByName: (n) => docsByName[n] || null,
    resolveDoc: (doc, page) => {
      if (!doc || doc.unreadable) return null;
      if (o.resolveDoc) return o.resolveDoc(doc, page);
      if (pack.docLinks === "none" || !doc.href) return null;
      const base = o.baseHref || "";
      return base + doc.href + (page && String(doc.type).toLowerCase() === "pdf" ? `#page=${page}` : "");
    },
  };

  BASE_ROUTE = pack.briefId ? `#/b/${encodeURIComponent(pack.briefId)}` : "#";

  const live = SECTIONS.filter((s) => (s.when ? s.when(pack) : true));

  mount.className = "rb" + (ctx.edit ? " is-editing" : "");
  mount.style.setProperty("--rb-head-h", (o.headerHeight || 0) + "px");
  mount.innerHTML = `
    <div class="rb-shell">
      <nav class="rb-nav" aria-label="Brief sections">
        <div class="rb-nav-eyebrow">${esc(pack.client || "Brief")}</div>
        ${live.filter((s) => !s.chrome).map((s) => {
          const c = s.count ? s.count(pack) : null;
          return `<a href="${goHref(s.id)}" data-goto="${s.id}"><span>${esc(s.label)}</span>${
            c ? `<span class="rb-nav-count">${c}</span>` : ""}</a>`;
        }).join("")}
        ${live.some((s) => s.chrome && s.id === "documents")
          ? `<a href="${goHref("documents")}" data-goto="documents" class="rb-nav-chrome"><span>Documents</span><span class="rb-nav-count">${arr(pack.documents).length}</span></a>`
          : ""}
      </nav>
      <main class="rb-main"><div class="rb-col">
        ${live.map((s) => `<section class="rb-section" id="rb-${s.id}" data-section="${s.id}"></section>`).join("")}
      </div></main>
    </div>
    <div class="rb-pop" hidden role="tooltip"></div>`;

  // Render section bodies once. They are cheap, and pre-rendering makes deep
  // links and print-all work without a second code path.
  for (const s of live) mount.querySelector(`#rb-${s.id}`).innerHTML = s.render(pack, d, ctx);

  /* Filtering is a CSS state flip, not a re-render: re-rendering would destroy
     focus and any half-typed value in edit mode, and would fight the live-sync
     guard in the host app. Nothing about the pack changes when you filter. */
  on("click", (e) => {
    const chip = e.target.closest("[data-lchip]");
    if (chip) {
      e.preventDefault();
      const list = chip.closest(".rb-list");
      if (!list) return;
      const want = chip.dataset.lchip;
      list.dataset.filter = want;
      list.querySelectorAll("[data-lchip]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b === chip)));
      if (want === "mine" && ctx.me) list.dataset.mine = ctx.me;
      // Tell the reader when a filter has hidden everything, rather than
      // showing an empty box that reads as missing data.
      const vis = [...list.querySelectorAll(".rb-rows > li")]
        .filter((li) => getComputedStyle(li).display !== "none").length;
      const empty = list.querySelector(".rb-filter-empty");
      if (empty) empty.hidden = vis > 0;
      return;
    }
    const tchip = e.target.closest("[data-tchip]");
    if (tchip) {
      e.preventDefault();
      const wrap = tchip.closest(".rb-section")?.querySelector(".rb-timewrap");
      if (!wrap) return;
      wrap.dataset.kind = tchip.dataset.tchip;
      tchip.parentElement.querySelectorAll("[data-tchip]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b === tchip)));
      const vis = [...wrap.querySelectorAll(".rb-timeline > li")]
        .filter((li) => getComputedStyle(li).display !== "none").length;
      const empty = wrap.querySelector(".rb-filter-empty");
      if (empty) empty.hidden = vis > 0;
      return;
    }
    const basis = e.target.closest("[data-basis]");
    if (basis && basis.tagName === "BUTTON") {
      e.preventDefault();
      const box = basis.closest(".rb-effort");
      if (!box) return;
      box.dataset.basis = basis.dataset.basis;
      basis.parentElement.querySelectorAll("[data-basis]").forEach((btn) =>
        btn.setAttribute("aria-pressed", String(btn === basis)));
      return;
    }
    const col = e.target.closest("[data-lcollapse]");
    if (col) {
      e.preventDefault();
      const key = col.dataset.lcollapse;
      const list = col.closest(".rb-list");
      const body = list?.querySelector(".rb-list-body");
      const nowOpen = col.getAttribute("aria-expanded") !== "true";
      col.setAttribute("aria-expanded", String(nowOpen));
      if (body) body.hidden = !nowOpen;
      if (nowOpen) ctx.collapsed.delete(key); else ctx.collapsed.add(key);
      writeCollapsed(pack.briefId, ctx.collapsed);
    }
  });

  const show = (id, elId) => {
    const asked = SECTION_ALIASES[id] || id;
    const target = live.some((s) => s.id === asked) ? asked : "snapshot";
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

  /* Closing a row is not editing. It is the commonest act on the page, so it is
     bound outside the ctx.edit block and writes through the same override path
     as the status select — one code path, one audit trail. */
  if (o.onEdit) {
    on("change", (e) => {
      const t = e.target.closest("[data-tick]");
      if (!t) return;
      const coll = t.dataset.tick, id = t.dataset.id, field = t.dataset.tickf || "status";
      const value = field === "checked" ? t.checked : (t.checked ? "done" : "open");
      o.onEdit({
        kind: "set", coll, itemId: id, field,
        path: `${coll}[id=${id}].${field}`, value,
        elementId: `${coll}-${id}.${field}`,
        label: `${id} · ${t.checked ? "done" : "reopened"}`,
      });
    });
  }

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
      ${!href ? "" : isFetchHref(href)
        ? `<div class="rb-pop-actions">
             <a class="rb-btn" href="${esc(href)}">Get the file</a></div>`
        : `<div class="rb-pop-actions">
             <a class="rb-btn" href="${esc(href)}" target="_blank" rel="noopener">Open</a>
             <a class="rb-btn" href="${esc(href)}" download="${esc(doc.file)}">Download</a></div>`}`;
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
