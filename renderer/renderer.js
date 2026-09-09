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

export const RENDERER_VERSION = "3.6.2";
export const SCHEMA_SUPPORT = { min: 1, max: 5 };

/* ---------------- small helpers ---------------- */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const arr = (v) => (Array.isArray(v) ? v : []);
const has = (v) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length);

const DAY = 864e5;
const today = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const parseDate = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : d; };
/* LOCAL CALENDAR DAYS. Math.ceil over a millisecond difference returns -0 for a
   date that passed less than a day ago at any positive UTC offset, and `-0 < 0`
   is FALSE — which is the test every "late" check on this page makes. And a
   date-only pack value ("2026-01-30") parses as UTC midnight, so it was off by
   the reader's offset in either direction. Parse date-only as local, reduce
   everything else to the local day it falls on, and round, because a DST day is
   23 or 25 hours long. Kept in step with localDay() in the hub's app.js. */
const localDay = (v) => {
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = parseDate(s);
  return d === null ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
};
const daysFromNow = (v) => { if (!v) return null; const a = localDay(v); return a === null ? null : Math.round((a - today()) / DAY); };

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
    mix: deriveMix(pack),
    people: derivePeople(pack),
    rail: deriveRail(pack),
  };
}

/* ---------- competency mix ----------
   The question this answers is not "what work is in this bid" — it is "am I in
   this, and how much of me does it need". A competency leader who can see they
   are 5% of the work stands down, and that is a WIN: it is the "too many cooks"
   problem the board exists to solve, solved by giving people grounds to leave.

   Two sources, always labeled. `competencyMix` in the pack is /RFP's read of the
   requirement split and is what we prefer. Absent, we derive one from the hour
   estimates in team.competencies and SAY SO — an hours split answers a slightly
   different question (what it costs to deliver, not what the RFP demands) and a
   reader arguing with the number needs to know which one they are arguing with.

   Never invented. No competencies and no hours means no mix, and the section
   says the pack does not carry one rather than drawing an empty ring. */
function deriveMix(pack) {
  const stated = arr(pack.competencyMix?.areas).filter((a) => a && has(a.area));
  if (stated.length) {
    const areas = stated.map((a) => ({
      area: a.area,
      canonical: canonicalComp(a.area),
      weight: Math.max(0, Math.round(Number(a.weight) || 0)),
      basis: a.basis || "",
      requirementIds: arr(a.requirementIds),
      lead: a.lead || "",
    })).sort((x, y) => y.weight - x.weight || compRank(x.area) - compRank(y.area));
    const total = areas.reduce((t, a) => t + a.weight, 0);
    return {
      ok: true, source: pack.competencyMix.source === "human" ? "human" : "pack",
      note: pack.competencyMix.note || "", areas, total,
      /* Stated weights are NEVER rebalanced. /RFP is instructed to emit what it
         believes rather than normalise a number it is unsure of, so a total that
         is not 100 is a finding to show, not an error to correct silently. */
      off: total !== 100,
    };
  }

  /* Hours first. Failing that, the dead `fte` field — and this is not a
     resurrection of it. FTE was killed as a DISPLAYED NUMBER, because "0.3 of a
     full-time employee" reads as permanent headcount in a staffing company and
     nobody could act on it. What was never wrong about it is the RATIO between
     the entries, and a ratio is all a share is. Every pursuit imported before v5
     carries fte and nothing else; the alternative is that the board's flagship
     new section is empty on the entire existing library, which is how a feature
     gets written off in the first week. The provenance line says which basis
     produced the number, so nobody has to guess. */
  const byHours = arr(pack.team?.competencies).filter((c) => Number(c.hours) > 0);
  const byFte = byHours.length ? [] : arr(pack.team?.competencies).filter((c) => Number(c.fte) > 0);
  const comps = byHours.length ? byHours : byFte;
  const basis = byHours.length ? "hours" : "fte";
  if (!comps.length) return { ok: false, why: "This pack does not carry a competency split." };

  const val = (c) => Number(basis === "hours" ? c.hours : c.fte);
  const totalV = comps.reduce((t, c) => t + val(c), 0);
  const raw = comps.map((c) => ({
    area: c.name, canonical: canonicalComp(c.name),
    exact: (val(c) / totalV) * 100,
    basis: basis === "hours"
      ? `${Math.round(val(c)).toLocaleString()} of ${Math.round(totalV).toLocaleString()} estimated hours`
      : `${(val(c) / totalV * 100).toFixed(0)}% of the effort estimate on file`,
    requirementIds: arr(c.requirementIds), lead: c.lead || "",
  }));
  /* Largest remainder, so the derived weights total exactly 100. This is
     arithmetic, not a judgment call — the "never normalise" rule above governs
     numbers a human or /RFP asserted, not rounding drift we introduced here by
     turning hours into percentages. */
  const areas = raw.map((r) => ({ ...r, weight: Math.floor(r.exact) }));
  let short = 100 - areas.reduce((t, a) => t + a.weight, 0);
  areas.slice().sort((a, b) => (b.exact % 1) - (a.exact % 1)).forEach((a) => { if (short-- > 0) a.weight += 1; });
  areas.sort((x, y) => y.weight - x.weight || compRank(x.area) - compRank(y.area));

  return { ok: true, source: basis, areas, total: 100, off: false,
    note: "derived from Effort & team, not from the requirement split" };
}

/* ---------- the people, for the persistent header ----------
   "Maybe it's less about who's involved, but WHAT's involved — because people
   change." The competency mix took the top of Summary; the people moved here,
   where they are true on every tab instead of being a zone you scroll past once.

   pointPerson is v5 and is the honest answer to "who's running this thing". A v4
   pack has no such field, so we fall back to a roster entry whose role reads as
   a lead and LABEL it as read from the roster — a guessed wrangler presented as
   a stated one is exactly the kind of quiet fiction that costs the board trust. */
function derivePeople(pack) {
  const items = arr(pack.actionItems);
  const open = (n) => items.filter((i) => i.owner === n && i.status !== "done").length;
  const late = (n) => items.filter((i) => i.owner === n && i.status !== "done" && daysFromNow(i.due) < 0).length;

  const stated = pack.pointPerson && has(pack.pointPerson.name) ? pack.pointPerson : null;
  const fromRoster = arr(pack.roster).find((r) => /lead|owner|manager|captain/i.test(r.role || ""));
  const point = stated
    ? { name: stated.name, role: stated.role || "", source: "stated" }
    : fromRoster ? { name: fromRoster.name, role: fromRoster.role || "", source: "roster" } : null;

  const names = [...new Set([
    ...arr(pack.roster).map((r) => r.name),
    ...items.map((i) => i.owner),
  ].filter(Boolean))].filter((n) => !point || n !== point.name);

  const people = names
    .map((n) => ({ name: n, open: open(n), late: late(n) }))
    .sort((a, b) => b.open - a.open || String(a.name).localeCompare(String(b.name)));

  return {
    ok: !!(point || people.length),
    point: point ? { ...point, open: open(point.name), late: late(point.name) } : null,
    people,
    unassigned: items.filter((i) => !i.owner && i.status !== "done").length,
  };
}

/* ---------- the header date rail ----------
   RESPONSE dates only. The rail shows POSITION IN TIME and never progress —
   that constraint is what makes it possible at all: "unless you have somebody
   whose job it is to check things off, the timeline is just going to be static
   and not trustworthy." Nothing on it is hand-maintained, so nothing on it can
   rot. Do not add completion state to this; that is what Our readiness is for. */
function deriveRail(pack) {
  const all = arr(pack.dates)
    .filter((x) => parseDate(x.date))
    .map((x) => ({ label: x.label || "Date", date: x.date, days: daysFromNow(x.date), kind: dateKind(x) }));
  if (pack.submission?.date && parseDate(pack.submission.date))
    all.push({ label: "Submission", date: pack.submission.date, days: daysFromNow(pack.submission.date),
               kind: "response", submission: true });
  if (!all.length) return { ok: false, why: "No dates in the pack." };
  all.sort((a, b) => a.days - b.days);

  const ours = all.filter((r) => r.kind === "response");
  const theirs = all.filter((r) => r.kind !== "response");

  /* AN ORDINAL SEQUENCE, NOT A LINEAR AXIS — and every name sits on its own dot.

     Three designs have now failed on the same rock. Names ON a linear axis were
     truncated at every width, because real dates cluster: three inside one week
     and one nineteen months out. Moving them into a key underneath made them
     legible and cut the tie to the dots — eleven rows wrapping into three ragged
     columns, with no way to tell which row was which dot. Making the axis scroll
     at a fixed pixels-per-day fixed the far dates and did nothing for the
     cluster: at 7px a day, three dates in one week sit 21px apart and their
     labels still cannot coexist. No pixels-per-day both fits a 19-month
     programme on a screen and gives a one-week cluster room to write in.

     So the x-axis stops being linear time. Items sit in DATE ORDER, evenly, each
     carrying its own dot, name, date and days-from-now, and the interval to the
     next is STATED on the connector rather than implied by distance. Stating it
     is strictly more honest than drawing it: "+19mo" cannot be misread the way a
     long empty stretch can, which is the same reason the two-clock split exists
     — to stop a far date reading as slack on a near one. Nothing here is
     hand-maintained, so nothing can rot.

     TODAY is an item in the sequence at its true place in the order, so what has
     passed is still read off the rail at a glance. */
  const seq = [];
  let inserted = false;
  for (const r of all) {
    if (!inserted && r.days > 0) { seq.push({ today: true }); inserted = true; }
    seq.push(r);
  }
  if (!inserted) seq.push({ today: true });          // every date is behind us
  /* Gaps are measured against the previous ITEM, today included — the interval
     that matters on the next date is the one from now, not from whatever
     happened last month. */
  let prev = null;
  for (const it of seq) {
    const d = it.today ? 0 : it.days;
    it.gap = prev === null ? null : d - prev;
    prev = d;
  }
  return { ok: true, seq, all, ours, theirs, total: all.length };
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
  /* "Next" means the next thing WE have to do. A client program milestone a
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
/* DECIDE FIRST. "Should we bid" outranks "can we build it" — the bid decision is
   the question that gates every other question, and a reader who opens the board
   is triaging before they are scoping. Reading order here is PRIORITY, not
   chronology; the labels are intents, so nothing about this implies you passed
   through Decide on your way to Understand. */
/* ---------- nav: five entries, sections as tabs ----------
   Ten sections under four group headings was still read as overload, and the
   density sat in the wrong place. A sidebar is for choosing a JOB, not for
   enumerating every view that job might need — so the jobs are the nav and the
   views are tabs inside them.

   Summary is entry one rather than chrome floating above the groups, because
   ungrouped meant skipped: "it's not inside a substructure." It is also no
   longer called TLDR, which told a first-time reader nothing about what was
   behind it.

   DECIDE COMES BEFORE UNDERSTAND. "Should we bid at all" outranks "can we
   deliver it" — the bid decision gates every other question, and the reader who
   opens a brief cold is triaging, not scoping. Understand briefly led on the
   grounds that the triage read already happens on Summary; that is true and it
   is still not a reason to put the evidence for the call AFTER the work that
   only matters if the call goes our way. Reading order here is PRIORITY, not
   chronology.

   BUILD IS CALLED "BID". Build named the wrong noun: on a pursuit the thing
   being built is the RESPONSE, and "Build" invited people to read it as the
   delivery work we would do if we won — which is Understand's Delivery scope,
   two entries away. Bid says whose work it is. The entry id stays `build` so
   every shared #/b/<pursuit>/build link keeps landing here.

   THE LABELS NAME INTENTS, NEVER STATES. No active entry, no progress, no
   checkmarks, no numbering, and nothing in the pack may drive how an entry
   looks. A lifecycle vocabulary in a nav wants to become a progress tracker,
   and that is precisely how the six-step stage stepper became a lie. If someone
   asks for a "current phase" indicator here, the answer is no — the countdown
   and the readiness score already say where we are and both are derived. This
   paragraph is the reason. Do not delete it and then add the indicator. */
const ENTRIES = [
  { id: "summary",    label: "Summary" },
  { id: "decide",     label: "Decide" },
  { id: "understand", label: "Understand" },
  { id: "build",      label: "Bid" },
  { id: "submit",     label: "Submit" },
];

const SECTIONS = [
  /* Summary answers all five intents at once and is the one screen everybody
     reads, so it is an entry with a single tab — and an entry with one tab
     renders no tab bar, because a lone tab is a label pretending to be a
     choice. */
  { id: "snapshot",     label: "Summary",              render: secScope, entry: "summary" },

  /* Delivery scope keeps the `compliance` id. #/b/<pursuit>/compliance links are
     already shared in Teams threads and they were pointing at requirements, so
     the id follows the content rather than the label. */
  { id: "compliance",   label: "Delivery scope",       render: secRequirementsTab, entry: "understand",
    when: (p) => has(p.requirements) || arr(p.dates).some((x) => dateKind(x) === "program"),
    count: (p) => arr(p.requirements).length || null },
  /* Was "Rules of the bid" — a title that named the container rather than the
     job. Nobody could tell from it whether the section held the scoring rules,
     the contract terms or the page limit. It holds the page limit. */
  { id: "rules",        label: "How to submit",        render: secRulesTab, entry: "understand",
    when: (p) => has(p.rules),
    count: (p) => arr(p.rules).length || null },

  { id: "risks",        label: "Risks & signals",      render: secRisks, entry: "decide",
    when: (p) => has(p.risks) || has(p.signals) },
  { id: "team",         label: "Effort & team",        render: secTeam, entry: "decide",
    when: (p) => has(p.team) || has(p.roster) },
  { id: "evaluation",   label: "Scoring & fit",        render: secEvaluation, entry: "decide",
    when: (p) => has(p.scorecard) || has(p.evaluation) },

  /* Our readiness leads Build: it is the tab people live in. The timeline is
     the frame around that work, not the work. */
  { id: "plan",         label: "Our readiness",        render: secPlan, entry: "build",
    when: (p) => has(p.actionItems) || has(p.dates) || has(p.submission),
    count: (p) => arr(p.actionItems).filter((i) => i.status !== "done").length || null },
  /* Both clocks on one rail. They used to be two folds in two different
     sections — "Our clock" inside Our readiness, "Their program" inside
     Delivery scope — so the one question a timeline exists to answer, how the
     two run against each other, could not be asked at all. */
  { id: "timeline",     label: "Timeline",             render: secTimeline, entry: "build",
    when: (p) => has(p.dates) || has(p.submission),
    count: (p) => arr(p.dates).length || null },
  { id: "questions",    label: "Questions to client",  render: secQuestions, entry: "build",
    when: (p) => has(p.questions), count: (p) => arr(p.questions).length || null },

  { id: "preflight",    label: "Submission check",     render: secPreflight, entry: "submit",
    when: (p) => has(p.rules) || has(p.submission) },
  { id: "decisions",    label: "Decision log",         render: secDecisions, entry: "submit",
    when: (p) => has(p.decisions) || has(p.parkingLot) || has(p.meetings), count: (p) => arr(p.decisions).length || null },
  /* Documents is a LAUNCHER, not a page: the way it gets used is "bam, bam,
     bam, you can get the docs you need". chrome:true keeps it out of the entry
     list and reachable from below it, which removes a tab and makes it
     available from every section instead of one. */
  { id: "documents",    label: "Documents",            render: secDocuments,    chrome: true, when: (p) => has(p.documents), count: (p) => arr(p.documents).length || null },
];

/* Old routes keep working. */
/* Set once per render, before section bodies are built. */
let BASE_ROUTE = "#";
const goHref = (id) => (BASE_ROUTE === "#" ? "#" : `${BASE_ROUTE}/${id}`);

/* `rules` is NOT in here and must never be. It is a live section id in its own
   right; aliasing it would send every data-goto="rules" to the wrong half of
   the old merged Rules & Requirements tab. */
const SECTION_ALIASES = { ask: "snapshot", tldr: "snapshot", checklist: "plan", dates: "timeline", requirements: "compliance", scorecard: "evaluation", record: "decisions" };

/* Which entry a section is a tab of, and what the reader last had open in each.
   The remembered tab is per person and per pursuit: it is a viewing preference,
   not content, so it lives in localStorage and never in the pack. */
const entryOf = (id) => (SECTIONS.find((x) => x.id === id) || {}).entry || null;
const tabKey = (briefId) => `rb.tab.${briefId || "brief"}`;
function readTabs(briefId) {
  try { return JSON.parse(localStorage.getItem(tabKey(briefId))) || {}; } catch { return {}; }
}
function writeTab(briefId, entry, section) {
  if (!entry) return;
  try {
    const all = readTabs(briefId);
    all[entry] = section;
    localStorage.setItem(tabKey(briefId), JSON.stringify(all));
  } catch { /* private browsing — the tab simply does not persist */ }
}

/* ---------- date kinds ----------
   Two clocks were being drawn on one rail and read as one sequence. A RESPONSE
   date is something we must hit to stay in the process — questions due,
   submission, orals, award. A PROGRAM date is something the client has told us
   about their own world — contract start, go-live, phase gates. Mixed together
   you get a timeline where "in 4 days" and "in 14 months" share a rail, and the
   eye reads the far date as slack on the near one.

   So: classify, color, and show ONE kind at a time by default. The pack may
   state `kind` outright; where it does not the label decides. Unclassifiable
   falls to "response", because an unlabeled date on an RFP brief is far more
   likely to belong to the submission clock than to the client's program. */
const PROGRAM_WORDS = /(start|commenc|kick[- ]?off|kickoff|go[- ]?live|golive|launch|transition|onboard|mobilis|mobiliz|ramp|cut[- ]?over|phase|milestone|contract|renewal|expir|implementation|steady state|hand[- ]?over)/i;
const RESPONSE_WORDS = /(q&a|q ?and ?a|question|clarification|addend|amend|intent|nda|submi|due|proposal|bid|tender|oral|present|demo|shortlist|award|notif|evaluat|interview|registration|portal|deadline|pre[- ]?bid|site visit|conference|response)/i;

const KIND_LABEL = { response: "Response", program: "Program" };

function dateKind(d) {
  const stated = String((d && d.kind) || "").toLowerCase();
  if (stated === "program" || stated === "program") return "program";
  if (stated === "response" || stated === "procurement") return "response";
  const t = String((d && d.type) || "").toLowerCase();
  if (t === "program" || t === "program" || t === "milestone") return "program";
  if (t === "qa" || t === "submission" || t === "award" || t === "orals") return "response";
  const label = `${(d && d.label) || ""} ${(d && d.ourAction) || ""}`;
  if (RESPONSE_WORDS.test(label)) return "response";
  return PROGRAM_WORDS.test(label) ? "program" : "response";
}

/* ---------- 1. Snapshot ---------- */

function mineStrip(p, ctx) {
  if (!ctx.me) return "";
  const mine = arr(p.actionItems).filter((i) => i.owner === ctx.me && i.status !== "done");
  if (!mine.length) return "";
  const late = mine.filter((i) => daysFromNow(i.due) < 0).length;
  return `<a class="rb-mine" href="${goHref("plan")}" data-goto="plan" data-el="action-${esc(mine[0].id)}">
    <b>${plural(mine.length, "item")}</b> waiting on you${late ? ` \u00b7 <span class="rb-mine-late">${late} late</span>` : ""}
    <span class="rb-mine-go" aria-hidden="true">\u2192</span></a>`;
}

/* ---------- competency mix ----------
   The most-requested addition from the 2026-09-02 review, and the reason is
   specific: a competency leader opens the brief to answer "am I in this, and
   how much of me does it need", and then either engages or hands it on. "I look
   at it, I see that I'm representing 5% of the bid. I'm going to back off."

   ONE HUE AT DESCENDING TINTS. Not a categorical palette — a competency palette
   would be the priority rainbow with a new name, and the two-color rule exists
   precisely to stop that. Tints carry magnitude, which is what the number means.

   The donut is drawn only where a donut is honest: five slices or fewer and
   nothing under 5%. Past that, arcs a reader cannot compare and labels that will
   not fit — the bar tells the same truth and keeps telling it. */
const MIX_A = [82, 65, 181];        /* --rb-accent  */
const MIX_B = [240, 239, 246];      /* --rb-line-2  */
const mixTint = (i, n) => {
  const t = n <= 1 ? 0 : (i / (n - 1)) * 0.72;
  const c = MIX_A.map((a, k) => Math.round(a + (MIX_B[k] - a) * t));
  return `rgb(${c[0]} ${c[1]} ${c[2]})`;
};

function donut(areas) {
  const R = 52, C = 2 * Math.PI * R;
  let at = 0;
  const rings = areas.map((a, i) => {
    const len = (a.weight / 100) * C;
    const el = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${mixTint(i, areas.length)}"
      stroke-width="15" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"
      stroke-dashoffset="${(-at).toFixed(2)}" transform="rotate(-90 60 60)"></circle>`;
    at += len;
    return el;
  }).join("");
  return `<svg class="rb-mix-donut" viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">${rings}</svg>`;
}

function secMix(p, d, ctx) {
  const m = d.mix;
  const head = `<div class="rb-zone-head"><span>What this bid demands</span></div>`;

  if (!m.ok) {
    return `<div class="rb-zone rb-mix">${head}
      <p class="rb-empty">${esc(m.why)} Add competency hours in Effort &amp; team and the split
      appears here, or re-run /RFP to read it from the requirements.</p></div>`;
  }

  const n = m.areas.length;
  const showDonut = n <= 5 && m.areas.every((a) => a.weight >= 5);

  const bar = `<div class="rb-mix-bar" role="img"
    aria-label="${esc(m.areas.map((a) => `${a.area} ${a.weight}%`).join(", "))}">
    ${m.areas.map((a, i) => `<span style="width:${a.weight}%;background:${mixTint(i, n)}"
      title="${esc(a.area)} — ${a.weight}%"></span>`).join("")}</div>`;

  /* Every weight is a number input. Editing one flips competencyMix.source to
     "human" — handled by the host, which watches for this collection — so the
     provenance line below stops claiming a derivation that a person has since
     overruled. */
  const rows = m.areas.map((a, i) => `
    <li class="rb-mix-row" data-el="mix-${esc(a.area)}">
      <span class="rb-mix-swatch" style="background:${mixTint(i, n)}" aria-hidden="true"></span>
      <span class="rb-mix-area">
        <b${edIn(ctx, `competencyMix.areas[area=${a.area}].area`, "")}>${esc(a.area)}</b>
        ${a.basis || ctx.edit
          ? `<i${edIn(ctx, `competencyMix.areas[area=${a.area}].basis`, "rb-mix-basis")}>${esc(a.basis)}</i>` : ""}
        ${a.requirementIds.length
          ? `<span class="rb-mix-reqs">${a.requirementIds.map((id) =>
              `<a href="${goHref("compliance")}" data-goto="compliance" data-el="req-${esc(id)}">${esc(id)}</a>`).join("")}</span>` : ""}
      </span>
      <span class="rb-mix-lead">${a.lead || ctx.edit
        ? `<span${edIn(ctx, `competencyMix.areas[area=${a.area}].lead`, "")}>${esc(a.lead || "no lead")}</span>` : ""}</span>
      <span class="rb-mix-w num">${ctx.edit
        ? numIn(ctx, "competencyMix.areas", a.area, "weight", a.weight, "area")
        : `${a.weight}%`}</span>
    </li>`).join("");

  /* Provenance, always stated. A weight read from the requirement split and a
     weight inferred from an hour estimate are answers to different questions,
     and this number exists to be argued with — you cannot argue with it without
     knowing which one you have. */
  const prov = {
    human: "Weights set by hand.",
    pack: "Read from the requirement split.",
    hours: "Derived from the hour estimates in Effort & team, not from the requirements.",
    /* Named plainly. A reader who knows this pursuit predates v5 should be able
       to see that from the line, and a reader who does not should still know the
       number came from an old effort estimate rather than the RFP itself. */
    fte: "Derived from the older effort estimates on this pack, not from the requirements. Re-run /RFP for a split read from the requirements.",
  }[m.source];

  /* One provenance sentence, not two. Packs routinely carry a note that
     restates the basis — "read from the requirement split" — which is already
     what prov says, and printing both makes the line stutter. Whichever of the
     two contains the other is the one that survives, so a note that genuinely
     adds a judgment call still gets said, and in the pack author's own words. */
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const note = m.source === "pack" ? String(m.note || "") : "";
  const line = !note ? prov
    : norm(note).includes(norm(prov).replace(/\.$/, "")) ? note.charAt(0).toUpperCase() + note.slice(1)
    : norm(prov).includes(norm(note)) ? prov
    : `${prov} ${note}`;

  return `<div class="rb-zone rb-mix">
    ${head}
    <p class="rb-sub rb-small">Effort share of the delivery, by area of expertise. If your area is
      small here, that is your answer.</p>
    <div class="rb-mix-viz">
      ${showDonut ? donut(m.areas) : ""}
      <div class="rb-mix-main">
        ${bar}
        <ul class="rb-mix-list${m.areas.some((a) => a.lead) || ctx.edit ? "" : " no-leads"}">${rows}</ul>
      </div>
    </div>
    <p class="rb-mix-prov rb-small">${esc(line)}
      ${m.off ? `<b class="rb-mix-off">These weights total ${m.total}%, not 100%.</b>` : ""}
      ${m.source !== "human" && m.source !== "pack" ? ` <a href="${goHref("team")}" data-goto="team">Effort &amp; team&nbsp;→</a>` : ""}</p>
  </div>`;
}

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
         ${has(p.submission.format) || has(p.submission.method) || ctx.edit
            ? `<dl class="rb-deadline-meta">${[
                 ["Submission format", p.submission.format, "submission.format"],
                 ["Submit via", p.submission.method, "submission.method"],
               ].filter(([, v]) => has(v) || ctx.edit)
                .map(([k, v, path]) =>
                  `<dt>${k}</dt><dd${ed(ctx, path)}>${esc(v)}</dd>`).join("")}</dl>` : ""}
       </div>`
    : `<p class="rb-empty" style="margin-bottom:var(--rb-s4)">No submission deadline captured in the pack.</p>`;

  // Editable in place, like every other piece of prose in the brief. Shown even
  // when empty in edit mode, or there is nothing to click to start writing.
  const askParas = [["ask.summary", p.ask?.summary], ["ask.background", p.ask?.background]]
    .filter(([, t]) => has(t) || ctx.edit)
    .map(([path, t]) => `<p${edIn(ctx, path, "rb-ask")}>${esc(t)}</p>`).join("");

  const cc = p.clientContext || {};
  const team = cc.team || {};
  const contacts = arr(cc.contacts);
  const hasClient = has(cc.business) || has(cc.problem) || has(team.name) || contacts.length;

  /* "reporting to" was inline prose, and /RFP legitimately writes a sentence
     into reportsTo when the documents do not say — which rendered as
     "…reporting to Not stated in the documents." A labelled value reads
     correctly whatever the field holds, including a real name, so the fix is the
     grammar rather than a guess at which strings mean "absent". */
  const teamLine = [
    has(team.name) ? `<span${ed(ctx, "clientContext.team.name")}>${esc(team.name)}</span>` : "",
    has(team.reportsTo)
      ? `<span class="rb-reports">Reports to: <span${ed(ctx, "clientContext.team.reportsTo")}>${esc(team.reportsTo)}</span></span>`
      : "",
  ].filter(Boolean).join("");

  /* Contacts are named people, so they key on `name` and every one is
     add/edit/deletable — a pursuit gains contacts as it runs, and a list you
     cannot append to stops being maintained on the first new introduction.

     Name on its own line, role beneath in helper text. They used to run inline
     on one baseline, which works right until a name wraps: "Angela Galmarini"
     broke to two lines and the role started level with its SECOND line, so the
     block read as a ragged staircase with no line clearly belonging to anyone.
     These stay <span>s and are made block by CSS — the whole thing sits inside a
     <p>, and a <ul> there is hoisted out by the parser. */
  const contactRows = contacts.map((c) => `
    <span class="rb-contact" data-el="contact-${esc(c.name)}">
      <b${edIn(ctx, `clientContext.contacts[name=${c.name}].name`, "")}>${esc(c.name)}</b>
      <span${edIn(ctx, `clientContext.contacts[name=${c.name}].role`, "rb-contact-role")}>${esc(c.role || "role")}</span>
      ${delBtn(ctx, "clientContext.contacts", c.name, "name")}
    </span>`).join("");

  const clientBlock = hasClient || ctx.edit
    ? `<div class="rb-zone">
         <div class="rb-zone-head"><span>The client</span></div>
         <div class="rb-verdict">
           ${has(cc.business) || ctx.edit
             ? `<p><b>What they do</b><span${ed(ctx, "clientContext.business")}>${esc(cc.business || "")}</span></p>` : ""}
           ${teamLine || contacts.length || ctx.edit
             ? `<p><b>Who we're talking to</b><span>${teamLine}${
                 contactRows ? `<span class="rb-contacts">${contactRows}</span>` : ""}${
                 addBtn(ctx, "clientContext.contacts", "Add a contact")}</span></p>` : ""}
           ${has(cc.problem) || ctx.edit
             ? `<p><b>The problem they're solving</b><span${ed(ctx, "clientContext.problem")}>${esc(cc.problem || "")}</span></p>` : ""}
         </div>
       </div>` : "";

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

  /* No stage label. It was self-reported and nothing kept it honest, so it went
     stale and taught people to distrust the board. And no "what's needed next"
     list: it restated the top of the Our readiness checklist in a second row
     shape, on the one tab that is meant to be a read-out. */
  const outlook = p.signals?.winLikelihood
    ? `<div class="rb-zone rb-outlook">Outlook: <b>${esc(p.signals.winLikelihood)}</b>${
        summarizeSignals(p.signals)} <a href="${goHref("risks")}" data-goto="risks">Details&nbsp;→</a></div>`
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
      ${mineStrip(p, ctx)}
      ${askParas ? `<div class="rb-zone" style="margin-top:0">${askParas}</div>` : ""}

      ${clientBlock}
      ${verdict}

      ${/* "Who's involved" used to sit here. The people moved to the persistent
            header, where they are true on every tab: "maybe it's less about who's
            involved, but WHAT's involved — because people change." What replaced
            them is the question a competency leader actually opens this brief to
            ask, and it now leads the tab rather than trailing it. */""}
      ${secMix(p, d, ctx)}

      ${/* No "what's needed next" zone. It listed three open action items with
            owner and due date — which is the top of the Our readiness checklist,
            rendered a second time in a bespoke row shape, on the one tab that is
            supposed to be a read-out. The reader who needs it is the person who
            owns an item, and they already have the strip at the top of this tab
            that links straight to their rows. Nothing is lost; one place gained. */""}
      ${outlook}
    </div>`;
}

function summarizeSignals(s) {
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
    ${/* This fold used to redraw every response milestone, which made three
          renderings of the same dates on one brief — here, in the Our clock
          fold below it, and in Their program two sections over. All three are
          gone now: what is unique to this tile is the slack arithmetic and what
          is already late, and the dates themselves belong on the rail. */""}
    <details class="rb-expand"><summary>How this is counted</summary>
      <div class="rb-expand-body">
        ${c.late.length ? `<p class="rb-small" style="margin:0 0 10px;color:var(--rb-urgent)">Late: ${
          c.late.map((i) => esc(i.task)).join("; ")}</p>` : ""}
        <div class="rb-formula">slack = due date − today, from Key Dates and item due dates</div>
        <p class="rb-small" style="margin-top:10px"><a href="${goHref("timeline")}" data-goto="timeline">Every milestone on one rail&nbsp;→</a></p>
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

const delBtn = (ctx, coll, id, key) => (ctx.edit
  ? `<button class="rb-del" data-del="${coll}" data-id="${esc(id)}"${
      key ? ` data-delkey="${esc(key)}"` : ""} title="Delete" aria-label="Delete ${esc(id)}">×</button>`
  : "");

/* A number field. Hours are the only numeric input in the brief and they were
   read-only, which made the whole Effort & team tab read-only for no reason
   other than nobody having written this. */
const numIn = (ctx, coll, id, field, value, key) => `
  <input class="rb-in rb-in-num" type="number" min="0" step="10"
    data-edit="${field}" data-coll="${coll}" data-id="${esc(id)}"${key ? ` data-key="${esc(key)}"` : ""}
    value="${value ? esc(String(value)) : ""}" aria-label="${esc(field)}">`;

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
   a status. It is a pattern, not a per-section judgment — there are nine lists
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
  const sev = opts.axis === "sev";
  const n = (v) => rows.filter((r) => (sev ? r.sev : r.status) === v).length;
  const owners = new Set(rows.map((r) => r.owner).filter(Boolean));
  const open = ctx.opened.has(key);

  const chip = (id, label, count, on) => count === 0 && id !== "all" ? "" :
    `<button type="button" class="rb-chip-f" data-lchip="${id}" data-list="${esc(key)}"
       aria-pressed="${on}">${label}<span class="rb-chip-n">${count}</span></button>`;

  const showMine = !sev && !!ctx.me && owners.has(ctx.me);
  const controls = `<div class="rb-chips" role="group" aria-label="Filter ${esc(title)}">
      ${chip("all", "All", rows.length, true)}
      ${sev
        ? `${chip("high", "High", n("high"), false)}${chip("med", "Medium", n("med"), false)}${chip("low", "Low", n("low"), false)}`
        : `${chip("open", "Open", n("open"), false)}${chip("atRisk", "At risk", n("atRisk"), false)}${chip("done", "Done", n("done"), false)}`}
      ${showMine ? chip("mine", "Mine", rows.filter((r) => r.owner === ctx.me).length, false) : ""}
    </div>`;

  return `<div class="rb-group rb-list" data-list="${esc(key)}" data-filter="all">
    <div class="rb-group-head">
      <button type="button" class="rb-collapse" data-lcollapse="${esc(key)}"
        aria-expanded="${open}">${esc(title)}</button>
      <span class="rb-nav-count">${plural(rows.length, opts.unit || "item")}</span>
    </div>
    <div class="rb-list-body"${open ? "" : " hidden"}>
      ${/* Standing rule: every list gets filters. Offer them when there is
            actually something to filter BY — more than one status present, or a
            list long enough that scanning it is work. A single chip row over
            three identical rows is noise, not affordance. */""}
      ${(rows.length > 3 || new Set(rows.map((r) => (sev ? r.sev : r.status))).size > 1 || showMine) ? controls : ""}
      ${/* data-mine is stamped at RENDER time, on the rows that are actually
            this reader's. It has to be: CSS cannot compare one attribute's value
            to another's, so the old rule — [data-filter="mine"][data-mine] li[data-owner]
            — matched every row that had ANY owner. "Mine" showed the whole
            assigned list to everybody, and silently: the chip lit up, rows
            disappeared, and the ones left behind looked plausible. Stamping the
            match keeps filtering a pure CSS state flip, which is the actual
            constraint (focus survives; nothing re-renders). */""}
      <ul class="rb-rows">${rows.map((r) =>
        `<li${r.status ? ` data-status="${r.status}"` : ""}${r.sev ? ` data-sev="${esc(r.sev)}"` : ""}${
          r.owner ? ` data-owner="${esc(r.owner)}"` : ""}${
          ctx.me && r.owner === ctx.me ? ` data-mine=""` : ""}${
          r.el ? ` data-el="${esc(r.el)}"` : ""}>${r.html}</li>`).join("")}</ul>
      <p class="rb-empty rb-filter-empty" hidden>Nothing matches that filter.</p>
    </div>
  </div>`;
}

const statusPill = (s) => `<span class="rb-status" data-s="${s}">${STATUS_LABEL[s]}</span>`;

/* Column headers. Several tables were a grid of values with nothing naming the
   columns — "competencies this RFP demands has no headers above the R-001 R-002
   column". Same grid as the rows beneath it, so the labels sit exactly over what
   they label; cells are passed in the same order and count as the row's. */
/* A group that is not a list still opens collapsed, through the same control
   and the same stored set — so a section reads as one set of headings whether
   its blocks happen to be filterable lists or plain tables. `.rb-list-body` is
   reused deliberately: one class, one hidden attribute, one toggle handler. */
function groupBlock(ctx, key, title, countHtml, body, cls = "", attrs = "") {
  const open = ctx.opened.has(key);
  return `<div class="rb-group rb-list${cls ? " " + cls : ""}" data-list="${esc(key)}"${attrs ? " " + attrs : ""}>
    <div class="rb-group-head">
      <button type="button" class="rb-collapse" data-lcollapse="${esc(key)}"
        aria-expanded="${open}">${title}</button>
      ${countHtml || ""}
    </div>
    <div class="rb-list-body"${open ? "" : " hidden"}>${body}</div>
  </div>`;
}

function colHead(cols, gridVars, opts = {}) {
  return `<div class="rb-colhead ${opts.noId ? "rb-row no-id" : "rb-row"}" style="${gridVars}" aria-hidden="true">${
    cols.map((c) => `<span class="${c && c.r ? "r" : ""}">${esc(c && c.t !== undefined ? c.t : (c || ""))}</span>`).join("")}</div>`;
}
const R = (t) => ({ t, r: true });

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
  /* No dates fold. Both clocks live in Timeline now — this section is about
     whether we are ready, which is a different question from when things fall
     due, and answering both here is what made either one hard to find. */
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

  return head("Our readiness") +
    `<div class="rb-zone rb-pulse" style="margin-top:var(--rb-s3)">
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
    secChecklist(p, d, ctx);
}

/* Delivery scope — what we would be on the hook for if we win, and over what
   timeline. The program dates live HERE and not in readiness: they are dates
   the client tells us about, not dates we hit, and on one rail with our
   submission clock a milestone fourteen months out reads as slack on something
   due Friday.

   Note the tab is NOT called "the ask". The ask is two sentences of prose on
   TLDR and appears exactly once; this is the itemised scope. Naming both "the
   ask" is the collision that got a fold deleted from TLDR already. */
function secRequirementsTab(p, d, ctx) {
  const n = arr(p.requirements).length;
  /* No "Their program" fold. The client's dates are not scope, and reading them
     here meant reading them apart from our own clock — see Timeline. */
  return head("Delivery scope", n ? `${plural(n, "requirement")} — the scope we are committing to` : "") +
    secRequirements(p, d, ctx);
}

/* How to submit — the constraints to read before anyone writes. Read-only:
   a rule is not a task, and the confirmation pass over these lives in
   Pre-flight, where ticking one means something. */
/* Both clocks, one rail, filterable by whose clock it is. The CSS already knew
   how to draw two kinds on one timeline and hide either — that was built and
   then never given a surface, because the two folds kept them apart. */
function secTimeline(p, d, ctx) {
  const c = d.criticalPath;
  if (!c.ok) return head("Timeline") + `<p class="rb-empty">${esc(c.why)}</p>`;

  const ms = c.milestones;
  const ours = ms.filter((m) => m.kind === "response").length;
  const theirs = ms.filter((m) => m.kind === "program").length;
  const chip = (k, label, n) => (n === 0 && k !== "all") ? "" :
    `<button type="button" class="rb-chip-f" data-tlchip="${k}"
       aria-pressed="${String(k === "all")}">${label}<span class="rb-chip-n">${n}</span></button>`;

  /* No color names in the copy. The accent is indigo, not red, and a subtitle
     that miscalls it is worse than one that says nothing — the key below is
     what carries the mapping, and it cannot drift from the stylesheet. */
  return head("Timeline",
    "Our response clock and the client's program on one rail, in date order.") +
    /* The key is not decoration. Two dot colors on one rail is meaningless
       until something says which is which, and this legend was written for
       exactly that and then stranded when the rail was split in two. Only the
       kinds actually on the rail are listed — a legend entry for a track with
       no dates on it reads as missing data rather than as an absent track. */
    `<div class="rb-key">${[
       ["response", "Our response clock", ours],
       ["program", "Their program", theirs],
     ].filter(([, , n]) => n > 0)
      .map(([k, label]) => `<span class="rb-key-i" data-kind="${k}"><i></i>${label}</span>`)
      .join("")}</div>` +
    ((ours && theirs)
      ? `<div class="rb-chips" role="group" aria-label="Filter the timeline">
           ${chip("all", "All", ms.length)}${chip("response", "Ours", ours)}${chip("program", "Theirs", theirs)}
         </div>`
      : "") +
    timeline(ms, "all");
}

function secRulesTab(p, d, ctx) {
  const n = arr(p.rules).length;
  return head("How to submit",
    `${plural(n, "rule")} governing the submission — miss one and the bid is discarded unread`) +
    secRules(p, d, ctx);
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
/* ONE timeline component, ONE kind per call.
   The kind filter chips and the two-color key were the right answer while both
   clocks shared a rail; splitting the clocks across two tabs makes both
   redundant, and a legend explaining a distinction that is not on screen is
   exactly the explanatory helper text we keep removing. Color stays — it is now
   the only thing carrying which clock you are looking at.

   The six-step stage stepper is still gone and still not coming back. It moved
   only when a human remembered to move it, and a pursuit reading "Drafting"
   three weeks after submission teaches people the board is stale. What the
   stepper was genuinely good for — "where are we today" — is the TODAY marker
   and the muted past rows here, both derived from dates, so neither can rot. */
function timeline(rows, kind) {
  if (!rows.length) return `<p class="rb-empty">No dates captured.</p>`;
  /* Mark the next upcoming row of EACH kind, not just the next response one.
     On the combined rail both markers exist and the wrapper's data-kind decides
     which one is painted — in "all" the response marker wins, because that is
     the clock that can lose you the bid. */
  const nextOf = Object.create(null);
  rows.forEach((m, i) => {
    const k = m.kind || kind;
    if (m.days >= 0 && nextOf[k] === undefined) nextOf[k] = i;
  });
  return `<div class="rb-timewrap" data-kind="${kind}">
    <ul class="rb-timeline">${rows.map((m, i) => `
      <li data-kind="${m.kind || kind}"${nextOf[m.kind || kind] === i ? ` data-next="${esc(m.kind || kind)}"` : ""}
          class="${m.days < 0 ? "is-past" : ""}" data-el="date-${esc(m.id || i)}">
        <div class="rb-tl-date">${esc(m.id === "submission" ? fmtDeadline(m.date) : fmtDate(m.date))} \u00b7 ${
          m.days < 0 ? `${Math.abs(m.days)} days ago` : `in ${plural(m.days, "day")}`}</div>
        <div class="rb-tl-title">${esc(m.label)}</div>
        ${has(m.ourAction) && m.ourAction !== "\u2014" ? `<div class="rb-sub rb-small">We must: ${esc(m.ourAction)}</div>` : ""}
      </li>`).join("")}</ul>
  </div>`;
}

/* ---------- 5. Rules & Constraints ---------- */
const RULE_CATEGORIES = [
  "Eligibility",
  "Format & limits",
  "Required forms",
  "Delivery",
  "Unclassified",
];
const RULE_HINTS = [
  ["Eligibility",     /(eligib|qualif|registrat|certif|licen[cs]|insur|clearance|incorporat|sam\.gov|dun|accredit|minority|diversity)/i],
  ["Format & limits", /(page|word|font|margin|pdf|docx|file type|file size|\bmb\b|\bpp\b|template|form factor|appendix|attachment limit|format)/i],
  ["Required forms",  /(form|w-?9|signature|signed|notaris|notariz|affidavit|schedule|exhibit|annex|questionnaire|pricing sheet|cover letter)/i],
  ["Delivery",        /(portal|ariba|coupa|email|upload|submit via|deliver|address|hand deliver|courier|sealed|copies)/i],
];
function ruleCategory(r) {
  const stated = String((r && r.category) || "");
  const hit = RULE_CATEGORIES.find((c) => c.toLowerCase() === stated.toLowerCase());
  if (hit) return hit;
  const label = `${(r && r.label) || ""} ${(r && r.detail) || ""}`;
  for (const [cat, re] of RULE_HINTS) if (re.test(label)) return cat;
  return "Unclassified";
}

function secRules(p, d, ctx) {
  const rules = arr(p.rules);
  if (!rules.length) return "";

  /* A rule carrying a date is a deadline, and a deadline is timeline content.
     It renders through the SAME component as the client's program dates on
     Delivery scope — one timeline in the brief, not one per tab. */
  const dated = rules
    .filter((r) => parseDate(r.date))
    .map((r) => ({ id: r.id, label: r.label, date: r.date, days: daysFromNow(r.date), kind: "response" }))
    .sort((a, b) => a.days - b.days);
  const plain = rules.filter((r) => !parseDate(r.date));

  const row = (r) => ({
    owner: "",
    el: `rule-${r.id}`,
    html: `<div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:170px">
        <span${edIn(ctx, `rules[id=${r.id}].label`, "rb-row-text")}>${esc(r.label)}</span>
        <span></span>
        <span></span>
        <span class="rb-meta r">${ctx.edit ? delBtn(ctx, "rules", r.id) : srcLink(r.source, ctx)}</span>
      </div>`,
  });

  const groups = RULE_CATEGORIES
    .map((cat) => [cat, plain.filter((r) => ruleCategory(r) === cat)])
    .filter(([, rs]) => rs.length);

  return groups.map(([cat, rs]) =>
      listBlock(ctx, `rule:${cat}`, cat, rs.map(row), { unit: "rule" })).join("") +
    (dated.length
      ? `<details class="rb-fold" data-el="rule-dates">
           <summary>Dates that bind the bid</summary>
           <div class="rb-fold-body">${timeline(dated, "response")}</div>
         </details>`
      : "") +
    addBtn(ctx, "rules", "Add a rule");
}

function secPreflight(p, d, ctx) {
  const sub = p.submission || {};
  const rules = arr(p.rules);
  const done = rules.filter((r) => r.checked).length;
  const openItems = arr(p.actionItems).filter((i) => i.status !== "done");
  const risky = arr(p.requirements).filter((r) => rowStatus(r, { mandatoryMatters: true }) === "atRisk");
  const docs = arr(p.documents);
  const days = sub.date ? daysFromNow(sub.date) : null;

  const mech = [
    ["Deadline", sub.date ? fmtDeadline(sub.date) : ""],
    ["Format", sub.format],
    ["Delivered by", sub.method],
  ].filter((x) => has(x[1]));

  return head("Submission check") +
    (days !== null
      ? `<div class="rb-deadline ${days <= 2 && days >= 0 ? "is-urgent" : ""} ${days < 0 ? "is-past" : ""}">
           <span class="rb-deadline-label">${days < 0 ? "Closed" : days === 0 ? "Due today" : `${plural(days, "day")} left`}</span>
           <span class="rb-deadline-value">${esc(fmtDeadline(sub.date))}</span>
         </div>`
      : "") +
    (mech.length
      ? `<ul class="rb-rows" style="margin-top:var(--rb-s4)">${mech.map(([k, v]) => `
          <li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:0px">
            <span class="rb-row-text"><b>${esc(k)}</b> \u00b7 ${esc(v)}</span>
            <span></span><span></span><span></span></div></li>`).join("")}</ul>`
      : "") +

    (rules.length
      ? subhead("Confirm every rule", `${done} of ${rules.length} confirmed`) +
        `<ul class="rb-rows">${rules.map((r) => `
          <li data-el="pf-${esc(r.id)}"><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:150px">
            <span class="rb-row-text ${r.checked ? "rb-muted" : ""}">${
              tick(ctx, "rules", r.id, !!r.checked, r.label, "checked")}${esc(r.label)}</span>
            <span></span><span></span>
            <span class="rb-meta r">${srcLink(r.source, ctx)}</span>
          </div></li>`).join("")}</ul>`
      : "") +

    ((openItems.length || risky.length)
      ? subhead("Still open") +
        `<ul class="rb-blockers" style="margin-bottom:var(--rb-s4)">${[
          openItems.length ? `<li><a href="${goHref("plan")}" data-goto="plan" data-el="action-${esc(openItems[0].id)}">${
            plural(openItems.length, "action item")} not closed</a></li>` : "",
          risky.length ? `<li><a href="${goHref("compliance")}" data-goto="compliance" data-el="req-${esc(risky[0].id)}">${
            plural(risky.length, "requirement")} at risk</a></li>` : "",
        ].join("")}</ul>`
      : subhead("Still open") + `<p class="rb-small rb-muted">Nothing outstanding.</p>`) +

    (docs.length
      ? subhead("Attachments", `${plural(docs.length, "file")} carried with this pursuit`) +
        `<ul class="rb-rows">${docs.map((doc) => `
          <li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:180px">
            <span class="rb-row-text">${esc(doc.file)}</span><span></span><span></span>
            <span class="rb-meta r">${[doc.type, bytes(doc.bytes)].filter(has).map(esc).join(" \u00b7 ")}</span>
          </div></li>`).join("")}</ul>`
      : "");
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
  const root = p.scorecard ? "scorecard" : "evaluation";
  return head("Scoring & fit", mechanic) +
    (crit.length || ctx.edit
      ? `<ul class="rb-weights">${crit.slice().sort((a, b) => (b.weight || 0) - (a.weight || 0)).map((c) => `
          <li><span${edIn(ctx, `${root}.criteria[name=${c.name}].name`, "")}>${esc(c.name)}</span>
            <span class="rb-weight-bar"><i style="width:${((c.weight || 0) / max) * 100}%"></i></span>
            <span class="rb-weight-num">${ctx.edit
              ? numIn(ctx, `${root}.criteria`, c.name, "weight", c.weight, "name")
              : `${esc(c.weight)}%`}</span>
            ${ctx.edit ? `<span>${delBtn(ctx, `${root}.criteria`, c.name, "name")}</span>` : ""}</li>`).join("")}</ul>
         ${addBtn(ctx, `${root}.criteria`, "Add a criterion")}`
      : `<p class="rb-empty">No scoring weights stated.</p>`) +
    /* Was "Pass / fail gates" — a misleading name over mis-modeled content.
       Nobody could relate it to the weights beside it ("what percentage means
       that I fail?") because these are not thresholds: they are stated
       must-haves and explicit rule-outs, often said aloud at kickoff rather
       than written in the RFP. */
    (success.length || ctx.edit
      ? groupBlock(ctx, "success", "Criteria for success", `<span class="rb-nav-count">${success.length}</span>`, `
         <ul class="rb-rows">${success.map((g, i) => `
           <li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:${ctx.edit ? "40px" : "0px"}">
             <span${edIn(ctx, typeof g === "string"
               ? `${root}.successCriteria[${i}]`
               : `${root}.successCriteria[${i}].text`, "rb-row-text")}>${
               esc(typeof g === "string" ? g : (g.text || g.basis || ""))}</span>
             <span></span><span></span>
             <span class="rb-meta r">${delBtn(ctx, `${root}.successCriteria`, String(i), "@index")}</span>
           </div></li>`).join("")}</ul>
         ${addBtn(ctx, `${root}.successCriteria`, "Add a criterion")}`) : "") +
    (has(e.guidance)
      ? `<div class="rb-verdict" style="margin-top:var(--rb-s4)"><p><b>Where to over-invest</b><span${
          ed(ctx, p.scorecard ? "scorecard.guidance" : "evaluation.guidance")}>${esc(e.guidance)}</span></p></div>` : "");
}

/* ---------- 7. Requirements ---------- */
function secRequirements(p, d, ctx) {
  const reqs = arr(p.requirements);
  if (!reqs.length) return "";
  const themes = [...new Set(reqs.map((r) => r.theme || "Ungrouped"))];

  /* Q-### BACK-REFERENCES. A question has always carried the R-### it came from;
     the requirement carried nothing back, so the thread could only be followed
     one way — you could get from a question to its requirement and then had to
     find your own way back, which on a 47-row list means scrolling for a number
     you already had. Both ends now link, so reading the two together is what
     deepens a position on the bid rather than what costs you your place.

     The numbering comes from orderedQuestions(), the same function the Questions
     tab numbers with, so Q-7 is the same row on both screens. The stable q.id
     addresses the row; the running number is only what is printed — renumbering
     the display can never break a link. */
  const qByReq = new Map();
  for (const q of orderedQuestions(p).rows) {
    if (!q.requirementId) continue;
    if (!qByReq.has(q.requirementId)) qByReq.set(q.requirementId, []);
    qByReq.get(q.requirementId).push(q);
  }
  const qRefs = (id) => {
    const list = qByReq.get(id) || [];
    if (!list.length) return "";
    return `<span class="rb-qrefs">${list.map((q) =>
      `<a href="${goHref("questions")}" data-goto="questions" data-el="question-${esc(q.id)}"
          title="${esc(q.text)}">Q-${q.no}</a>`).join("")}</span>`;
  };

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
          : esc(r.text)}${qRefs(r.id)}</span>
        <span class="rb-meta r">${ctx.edit
          ? ownerSelect(ctx, r.id, "requirements", r.owner)
          : esc(r.owner || "unowned")}</span>
        ${ctx.edit
          ? statusSelect(r.id, "requirements", r.status) + delBtn(ctx, "requirements", r.id)
          : statusPill(rowStatus(r, { mandatoryMatters: true }))}
      </div>`,
  });

  /* `return` on its own line let ASI insert a semicolon and the map below became
     dead code — Delivery scope rendered a heading and nothing else. Caught by a
     browser check; a syntax pass would never have flagged it. */
  return themes.map((th) => listBlock(ctx, `req:${th}`, th,
      reqs.filter((r) => (r.theme || "Ungrouped") === th).map(rowFor),
      { unit: "requirement" })).join("") + addBtn(ctx, "requirements", "Add a requirement");
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

/* Read-time synonyms. Ordered: the first pattern that matches wins, so the
   narrow ones come before the broad ones — "model training" must beat "data",
   and "test automation" must beat "automation" reaching DevSecOps. */
const COMP_SYNONYMS = [
  ["Annotation & Model Training",    /(annotat|label(l)?ing|model train|rlhf|ground truth|fine[- ]?tun)/i],
  ["UX Research",                    /(ux research|user research|usability|discovery research|ethnograph)/i],
  ["Product Design",                 /(product design|\bux\b|\bui\b|interaction design|service design|prototyp|design system|brand system)/i],
  ["Quality & Test Automation",      /(\bqa\b|quality|test|sdet|performance engineer|resilien|release quality)/i],
  ["Data, Analytics & AI",           /(analytic|\bbi\b|forecast|machine learning|\bml\b|\bai\b|data platform|data scien|reporting|insight)/i],
  ["Data Collection & Benchmarking", /(benchmark|data collection|competitive intel|market scan|signal collection|survey)/i],
  ["Cloud & Platform Engineering",   /(cloud|azure|\baws\b|\bgcp\b|platform|migration|modernis|moderniz|\bapi\b|infrastructure|kubernetes)/i],
  ["DevSecOps & Service Management", /(devsecops|devops|security|cyber|\bci\/cd\b|\biac\b|observab|\bitsm\b|service management|service desk|digital workspace|compliance engineer)/i],
  ["Strategy & Transformation",      /(strateg|transformation|roadmap|operating model|\bpmo\b|governance|change management|advisory)/i],
  ["Development & Engineering",      /(develop|engineer|software|full[- ]?stack|front[- ]?end|back[- ]?end|build|integration|mobile|web app)/i],
];

/* Returns the canonical area, or null when nothing plausibly matches — a wrong
   mapping is worse than an honest "outside our ten areas", because it hides a
   demand we may not actually be able to sell. */
function canonicalComp(name) {
  const k = compKey(name);
  if (COMP_INDEX.has(k)) return COMPETENCIES[COMP_INDEX.get(k)];
  for (const [area, re] of COMP_SYNONYMS) if (re.test(String(name || ""))) return area;
  return null;
}
const compRank = (n) => {
  const c = canonicalComp(n);
  return c ? COMP_INDEX.get(compKey(c)) : 99;
};

/* ---------- 8. Team & Burden ---------- */
/* ============================================================
   EFFORT & TEAM — a proposed team, sized lean
   ============================================================
   This was a list of competency hours, and a reader could not tell what it was
   for: "I do want a little bit more clarity on what this does." Hours are an
   abstraction. A TEAM is the thing a bid actually proposes and the thing a
   competency lead can argue with.

   So the primary read is now a staffing plan — role, level, geography, remote or
   on-site, heads, hours, and the rates those four attributes imply. Sized LEAN by
   instruction, because in the bid space the smallest credible team is the
   competitive one and a naive estimate runs about 3x heavy.

   The competency table stays underneath as the mapping layer. It is what routes
   requirement IDs to the right lead, which is the "too many cooks" problem the
   whole tool exists for — if one person owns one requirement, they do not need to
   be in the meeting. That purpose is now stated on the screen instead of needing
   someone to explain it.

   Everything here is DRAFT and everything is editable. The rates are a market
   estimate from /RFP, not a quote. */

const GEOS = {
  us:    "US onshore",
  latam: "Nearshore — LATAM",
  india: "Offshore — India",
  emea:  "EMEA",
};
const LEVELS = { junior: "Junior", mid: "Mid", senior: "Senior" };
const MODES = { remote: "Remote", onsite: "On-site" };

const money = (n) => (Number(n) ? `$${Math.round(Number(n)).toLocaleString()}` : "—");
const rateOf = (r, k) => Number((r && r.rate && r.rate[k]) || 0);

function selIn(ctx, coll, id, field, value, map, key) {
  if (!ctx.edit) return esc(map[value] || value || "—");
  return `<select class="rb-in" data-edit="${field}" data-coll="${coll}" data-id="${esc(id)}"${
    key ? ` data-key="${esc(key)}"` : ""} aria-label="${esc(field)}">${
    Object.entries(map).map(([k, label]) =>
      `<option value="${esc(k)}"${k === value ? " selected" : ""}>${esc(label)}</option>`).join("")}${
    value && !map[value] ? `<option selected>${esc(value)}</option>` : ""}</select>`;
}

function secTeam(p, d, ctx) {
  const t = p.team || {};
  const plan = arr(t.plan);
  const comps = arr(t.competencies).slice()
    .sort((a, b) => compRank(a.name) - compRank(b.name) || String(a.name).localeCompare(String(b.name)));

  const hoursOf = (c) => (Number(c.hours) || 0);
  const aiOf = (c) => (Number(c.hoursAi) || 0);
  const eff = (c) => (aiOf(c) || hoursOf(c));

  /* Totals are computed for BOTH bases and both are rendered, because the toggle
     is a CSS flip — recomputing on click would re-render and eat an edit. */
  const sum = (rows, f) => rows.reduce((n, x) => n + f(x), 0);
  const planAnalog = sum(plan, hoursOf), planAi = sum(plan, eff);
  const compAnalog = sum(comps, hoursOf), compAi = sum(comps, eff);
  const heads = sum(plan, (r) => Number(r.count) || 1);

  const cost = (rows, hf) => sum(rows, (r) => hf(r) * rateOf(r, "pay"));
  const rev  = (rows, hf) => sum(rows, (r) => hf(r) * rateOf(r, "bill"));
  const costA = cost(plan, hoursOf), costI = cost(plan, eff);
  const revA  = rev(plan, hoursOf),  revI  = rev(plan, eff);
  const marginPct = (r, c) => (r > 0 ? Math.round(((r - c) / r) * 100) : 0);

  const hasAi = plan.some((r) => aiOf(r) > 0) || comps.some((c) => aiOf(c) > 0);
  const hasRates = plan.some((r) => rateOf(r, "pay") || rateOf(r, "bill"));
  const totalAnalog = planAnalog || compAnalog;
  const totalAi = planAi || compAi;
  const saving = totalAnalog && hasAi ? Math.round((1 - totalAi / totalAnalog) * 100) : 0;

  const hrs = (n) => (n ? `${n.toLocaleString()} hrs` : "—");
  const DIST = { front: "front-loaded", back: "back-loaded", even: "spread evenly" };
  const basisPair = (analog, ai) =>
    `<span class="rb-e-analog">${analog}</span><span class="rb-e-ai">${ai}</span>`;

  const planGrid = ctx.edit
    ? "--rb-c1:300px;--rb-c2:190px;--rb-c3:190px"
    : "--rb-c1:150px;--rb-c2:132px;--rb-c3:186px";

  return head("Effort & team",
    "The smallest credible team that can win this, and what it costs. Every figure is DRAFT.") +

    /* ---------- the proposed team ---------- */
    (plan.length || ctx.edit
      ? groupBlock(ctx, "team:plan", "Proposed team",
          `<span class="rb-nav-count">${plural(heads, "person", "people")} · ${
             basisPair(hrs(planAnalog), hrs(planAi))}${
             has(t.distribution) ? ` · ${esc(DIST[t.distribution] || t.distribution)}` : ""}</span>`, `
           ${hasAi
             ? `<div class="rb-chips" role="group" aria-label="Estimate basis">
                  <button type="button" class="rb-chip-f" data-basis="ai" aria-pressed="true">AI-assisted<span class="rb-chip-n">${
                    hrs(planAi || compAi)}</span></button>
                  <button type="button" class="rb-chip-f" data-basis="analog" aria-pressed="false">Analog<span class="rb-chip-n">${
                    hrs(planAnalog || compAnalog)}</span></button>
                  ${saving > 0 ? `<span class="rb-e-saving">${saving}% less with AI in the delivery model</span>` : ""}
                </div>`
             : ""}

           ${colHead(["Role", "Level · where", R("Heads · hours"), R(ctx.edit ? "Pay · bill" : "Pay · bill · margin")],
                     planGrid, { noId: true })}

           <ul class="rb-rows">${plan.map((r) => `
             <li data-el="role-${esc(r.id)}"><div class="rb-row no-id" style="${planGrid}">
               <span class="rb-row-text">
                 <b${edIn(ctx, `team.plan[id=${r.id}].role`, "")}>${esc(r.role || "Role")}</b>
                 ${has(r.competency) ? `<br><span class="rb-meta">${esc(canonicalComp(r.competency) || r.competency)}</span>` : ""}
                 ${/* The rate basis is why the number is what it is. It belongs
                       under the role as quiet secondary text — as a full-width
                       block per row it was three code-styled bars down the table. */""}
                 ${has(r.rate && r.rate.basis) && !ctx.edit
                   ? `<br><span class="rb-meta rb-basis">${esc(r.rate.basis)}</span>` : ""}
               </span>
               <span class="rb-meta">${selIn(ctx, "team.plan", r.id, "level", r.level, LEVELS)} ${
                 selIn(ctx, "team.plan", r.id, "geo", r.geo, GEOS)} ${
                 selIn(ctx, "team.plan", r.id, "mode", r.mode, MODES)}</span>
               <span class="rb-meta r">${ctx.edit
                 ? `${numIn(ctx, "team.plan", r.id, "count", r.count)}${
                     numIn(ctx, "team.plan", r.id, "hours", r.hours)}${
                     numIn(ctx, "team.plan", r.id, "hoursAi", r.hoursAi)}`
                 : `${Number(r.count) || 1} · ${basisPair(hrs(hoursOf(r)), hrs(eff(r)))}`}</span>
               <span class="rb-meta r">${ctx.edit
                 ? `${numIn(ctx, "team.plan", r.id, "rate.pay", rateOf(r, "pay"))}${
                     numIn(ctx, "team.plan", r.id, "rate.bill", rateOf(r, "bill"))}${
                     delBtn(ctx, "team.plan", r.id)}`
                 : `${money(rateOf(r, "pay"))} · ${money(rateOf(r, "bill"))}${
                     rateOf(r, "bill") ? ` · <b style="color:var(--rb-ink)">${
                       marginPct(rateOf(r, "bill"), rateOf(r, "pay"))}%</b>` : ""}`}</span>
             </div></li>`).join("")}</ul>

           ${hasRates
             ? `<div class="rb-totals">
                  <span><b>Cost</b> ${basisPair(money(costA), money(costI))}</span>
                  <span><b>Revenue</b> ${basisPair(money(revA), money(revI))}</span>
                  <span><b>Margin</b> ${basisPair(`${marginPct(revA, costA)}%`, `${marginPct(revI, costI)}%`)}</span>
                </div>`
             : ""}
           ${ctx.edit
             ? `<p class="rb-formula">Boxes, left to right: heads, analog hours, AI-assisted hours, pay rate, bill rate. Rates are a market estimate from /RFP — correct them.</p>`
             : ""}
           ${addBtn(ctx, "team.plan", "Add a role")}`, "rb-effort", `data-basis="${hasAi ? "ai" : "analog"}"`)
      : `<p class="rb-empty">No team proposed yet.</p>`)

    /* ---------- who is already named ---------- */
    + (arr(p.roster).length || ctx.edit
      ? groupBlock(ctx, "team:roster", "Named so far",
          `<span class="rb-nav-count">${plural(arr(p.roster).length, "person", "people")}</span>`, `
         ${/* The role sits in the THIRD cell, so it is --rb-c2 that has to carry
               it. These vars read c1:0 c2:0 c3:200 with the header label in the
               fourth cell, which put "Role on the bid" over the delete-button
               column and the role values themselves in a column 0px wide: every
               role broke one word per line down a 40px gutter while its own
               heading sat to the right of it. Cells and vars now line up, and
               the role reads left-aligned because it is a phrase, not a
               figure. */""}
         ${colHead(["Person", "", "Role on the bid", ""],
                   `--rb-c1:0px;--rb-c2:minmax(0,260px);--rb-c3:${ctx.edit ? "40px" : "0px"}`, { noId: true })}
         <ul class="rb-rows">${arr(p.roster).map((r) => `
           <li data-el="roster-${esc(r.name)}"><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:minmax(0,260px);--rb-c3:${ctx.edit ? "40px" : "0px"}">
             <span class="rb-row-text"><b${edIn(ctx, `roster[name=${r.name}].name`, "")}>${esc(r.name)}</b>${
               ctx.edit ? `<br><span${edIn(ctx, `roster[name=${r.name}].role`, "rb-meta")}>${esc(r.role || "role")}</span>` : ""}</span>
             <span></span>
             <span class="rb-meta">${ctx.edit ? "" : esc(r.role || "")}</span>
             <span class="rb-meta r">${delBtn(ctx, "roster", r.name, "name")}</span>
           </div></li>`).join("")}</ul>${addBtn(ctx, "roster", "Add a person")}`)
      : "")

    /* ---------- the mapping layer ---------- */
    + (comps.length || ctx.edit
      ? groupBlock(ctx, "team:comps", "Competencies this RFP demands",
          `<span class="rb-nav-count">${basisPair(hrs(compAnalog), hrs(compAi))} draft</span>`, `
           <p class="rb-sub rb-small" style="margin:2px 0 0">Which of our areas each requirement falls to — so the right lead is in the room, and nobody else has to be.</p>
           ${colHead(["Area", "", R("Requirements"), R("Hours")],
                     `--rb-c1:0px;--rb-c2:${ctx.edit ? "200px" : "150px"};--rb-c3:${ctx.edit ? "150px" : "88px"}`,
                     { noId: true })}
         <ul class="rb-rows">${comps.map((c) => {
            /* The row LEADS with our area of expertise, not with whatever the RFP
               happened to call it. A pack written before the vocabulary closed
               says "Cyber"; the reader needs to see "DevSecOps & Service
               Management", and the original wording kept underneath so the
               mapping is auditable rather than magic.

               No "outside our ten areas" flag any more: it was read as "we can't
               do that" — a capability denial — when it only ever meant the name
               did not match our taxonomy. An unmapped name simply renders as
               stated. */
            const canon = canonicalComp(c.name);
            const mapped = canon && compKey(canon) !== compKey(c.name);
            return `
           <li data-el="comp-${esc(c.name)}"><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:${
             ctx.edit ? "200px" : "150px"};--rb-c3:${ctx.edit ? "150px" : "88px"}">
             <span class="rb-row-text">${ctx.edit
               ? `<span${edIn(ctx, `team.competencies[name=${c.name}].name`, "")}>${esc(c.name)}</span>`
               : esc(canon || c.name)}${
               canon && mapped ? `<br><span class="rb-meta">stated as “${esc(c.name)}”</span>` : ""}</span>
             <span></span>
             <span class="rb-meta r">${arr(c.requirementIds).length ? esc(c.requirementIds.join(", ")) : ""}</span>
             ${ctx.edit
               ? `<span class="rb-meta r rb-hourpair">${
                   numIn(ctx, "team.competencies", c.name, "hours", c.hours, "name")}${
                   numIn(ctx, "team.competencies", c.name, "hoursAi", c.hoursAi, "name")}${
                   delBtn(ctx, "team.competencies", c.name, "name")}</span>`
               : `<b class="rb-meta r" style="color:var(--rb-ink)">${basisPair(hrs(hoursOf(c)), hrs(eff(c)))}</b>`}
           </div></li>`;
          }).join("")}</ul>
          ${addBtn(ctx, "team.competencies", "Add a competency")}`, "rb-effort", `data-basis="${hasAi ? "ai" : "analog"}"`)
      : "")

    + (arr(t.keyPersonnel).length || ctx.edit
      ? groupBlock(ctx, "team:keyp", "Key personnel mandates",
          `<span class="rb-nav-count">${arr(t.keyPersonnel).length}</span>`, `
         <ul class="rb-rows">${arr(t.keyPersonnel).map((k, i) => `
           <li><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:${ctx.edit ? "40px" : "0px"}">
             <span${edIn(ctx, typeof k === "string" ? `team.keyPersonnel[${i}]` : `team.keyPersonnel[${i}].text`, "rb-row-text")}>${
               esc(typeof k === "string" ? k : k.text || k.name)}</span>
             <span></span><span></span>
             <span class="rb-meta r">${delBtn(ctx, "team.keyPersonnel", String(i), "@index")}</span>
           </div></li>`).join("")}</ul>${addBtn(ctx, "team.keyPersonnel", "Add a mandate")}`)
      : "");
}

/* Collapsed sections are a viewing preference, not content — they belong to the
   person, not the pack. localStorage can throw in a sandboxed frame, so every
   access is guarded rather than assumed. */
/* EVERYTHING OPENS COLLAPSED, and the set records what this person has OPENED.
   It used to record what they had closed, which made expanded the default —
   so Our readiness opened as eight owner groups of rows, Effort & team as four
   full tables, and Delivery scope as every theme at once. A tab that opens as a
   wall is a tab you scroll rather than read; collapsed, the same tab opens as
   its own contents page — every heading with its count, and you open the one
   you came for. Nothing is hidden that a click does not reveal, deep links
   open what they land on, and the choice is remembered per person per pursuit,
   so the second visit opens where you work.

   The storage key changed with the meaning. Reusing rb.qcollapse would have read
   every previously-closed group as a request to open it — an inverted
   preference is worse than none. */
const collapseKey = (briefId) => `rb.gopen.${briefId || "brief"}`;
function readOpened(briefId) {
  try { return new Set(JSON.parse(localStorage.getItem(collapseKey(briefId)) || "[]")); }
  catch { return new Set(); }
}
function writeOpened(briefId, set) {
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
   Topic is the organizing idea here, and questions get re-filed constantly as
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
      ${head("Questions to client")}
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
            ? `<a href="${goHref("compliance")}" data-goto="compliance" data-el="req-${esc(q.requirementId)}">${esc(q.requirementId)}</a>` : "")}</span>
      </div></li>`).join("");

  const opened = ctx.opened;
  return headBlock + topics.map((t) => {
    const n = qs.filter((q) => topicOf(q) === t).length;
    // An empty section is only shown while editing — a reader has no use for a
    // heading with nothing under it.
    if (!n && !ctx.edit) return "";
    return `<details class="rb-group rb-qgroup" data-topic="${esc(t)}"${opened.has(t) ? " open" : ""}>
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
/* Risks and signals both go through listBlock now. They used to be two bespoke
   components — a grid with its own severity column, and a signal list with
   colored dashes for bullets that appeared nowhere else in the brief. Every
   section is supposed to be learnable once; a reader should not have to work out
   a new row shape on arrival. Direction is carried by the group NAME ("Working
   against us"), which is unambiguous, rather than by a color a reader has to
   decode. */
function secRisks(p, d, ctx) {
  const s = p.signals || {};
  const order = { high: 0, med: 1, medium: 1, low: 2 };
  const norm = (v) => (String(v || "").toLowerCase() === "medium" ? "med" : String(v || "").toLowerCase());
  const risks = arr(p.risks).slice().sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

  /* Signals are plain strings or {basis, source} objects depending on the pack's
     age, and neither carries an id — so they are addressed by position. The one
     place that matters: an override written against a row that has since moved
     lands in applyOverrides' orphan branch instead of editing the wrong signal. */
  const signalRows = (items, dir) => arr(items).map((x, i) => {
    const text = typeof x === "string" ? x : x.basis;
    const src = typeof x === "object" && x.source ? x.source : "";
    const path = typeof x === "string" ? `signals.${dir}[${i}]` : `signals.${dir}[${i}].basis`;
    return {
      el: `signal-${dir}-${i}`,
      html: `<div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:${ctx.edit ? "190px" : "150px"}">
          <span${edIn(ctx, path, "rb-row-text")}>${esc(text)}</span>
          <span></span><span></span>
          <span class="rb-meta r">${src ? esc(src) : ""}${delBtn(ctx, `signals.${dir}`, String(i), "@index")}</span>
        </div>`,
    };
  });

  const riskRow = (r) => ({
    sev: norm(r.severity),
    el: `risk-${r.id || r.title}`,
    html: `<div class="rb-row" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:${ctx.edit ? "40px" : "0px"}">
        <span class="rb-id rb-sev" data-sev="${esc(norm(r.severity))}">${esc(r.severity || "")}</span>
        <span class="rb-row-text">
          <span${edIn(ctx, `risks[id=${r.id}].title`, "rb-risk-title")}>${esc(r.title)}</span>
          ${(has(r.detail) || has(r.mitigation) || has(r.strategicResponse) || ctx.edit)
            ? `<details class="rb-expand rb-risk-more"${ctx.edit ? " open" : ""}>
                 <summary>Detail</summary>
                 <div class="rb-expand-body">
                   ${has(r.detail) || ctx.edit
                     ? `<p${edIn(ctx, `risks[id=${r.id}].detail`, "rb-sub rb-small")}>${esc(r.detail || "")}</p>` : ""}
                   ${/* Both of these were unlabelled blocks of prose, so it was not
                         obvious that the indented one was a proposal rather than more
                         description. They are labeled, and named for what they are:
                         one is what we would DO about it, the other is what we would
                         WRITE about it. */""}
                   ${has(r.mitigation) || ctx.edit
                     ? `<div class="rb-labeled"><span class="rb-microlabel">Proposed mitigation</span>
                          <p${edIn(ctx, `risks[id=${r.id}].mitigation`, "rb-mitigation")}>${esc(r.mitigation || "")}</p></div>` : ""}
                   ${has(r.strategicResponse)
                     ? `<div class="rb-labeled"><span class="rb-microlabel">How we answer it in the proposal</span>
                          <p${edIn(ctx, `risks[id=${r.id}].strategicResponse`, "rb-mitigation")}>${esc(r.strategicResponse)}</p></div>` : ""}
                 </div></details>`
            : ""}
        </span>
        <span></span><span></span>
        <span class="rb-meta r">${ctx.edit ? delBtn(ctx, "risks", r.id) : ""}</span>
      </div>`,
  });

  return head("Risks & signals",
    "Two questions live here, and they have different answers. Keep them apart.") +

    half("Can we deliver it?",
      "If we win, these are the ways the work itself could go wrong \u2014 scope, scale, SLAs, skills. Each one needs a mitigation we can defend in the response.") +
    (risks.length
      ? listBlock(ctx, "risk:all", "Delivery risks", risks.map(riskRow), { unit: "risk", axis: "sev" })
      : `<p class="rb-empty">No delivery risks captured.</p>`) +

    half("Should we bid at all?",
      "Nothing below is about the work. It is about whether we are positioned to win it \u2014 incumbents, relationships, timing, fit. Read this before anyone spends a day on the response.") +
    (has(s.winLikelihood)
      ? `<div class="rb-verdict"><p><b>Win likelihood — DRAFT</b><span><b>${esc(s.winLikelihood)}</b></span></p></div>` : "") +
    listBlock(ctx, "sig:red", "Working against us", signalRows(s.red, "red"), { unit: "signal" }) +
    addBtn(ctx, "signals.red", "Add a signal") +
    listBlock(ctx, "sig:green", "Working for us", signalRows(s.green, "green"), { unit: "signal" }) +
    addBtn(ctx, "signals.green", "Add a signal") +
    /* "beige" tested badly — nobody could guess what it meant or which direction
       it pointed. Renamed to soft signals in schema v4; the old key is still read
       for packs cached before that deploy. */
    listBlock(ctx, "sig:soft", "Soft signals", signalRows(s.soft || s.beige, s.soft ? "soft" : "beige"), { unit: "signal" }) +
    addBtn(ctx, "signals.soft", "Add a soft signal") +
    (arr(s.unknown).length
      ? `<p class="rb-small rb-muted" style="margin-top:var(--rb-s3)">Still unknown: ${esc(s.unknown.join(", "))}</p>` : "") +
    addBtn(ctx, "risks", "Add a risk");
}

/* ---------- 11. Decisions & Parking Lot ---------- */
/* "Decisions" alone was ambiguous — pending, or made? And "parking lot is a dumb
   name". Placed last in the nav because nobody reaches for it first ("more of an
   afterthought tab"), but kept, because "everybody needs to have one place where
   they have equal visibility".

   It took ctx late: the whole tab was read-only, which meant the one place the
   team was told to record a decision was the one place they could not type. */
function secDecisions(p, d, ctx) {
  const ds = arr(p.decisions), pl = arr(p.parkingLot), ms = arr(p.meetings);
  if (!ds.length && !pl.length && !ms.length && !ctx.edit)
    return head("Decision log") + `<p class="rb-empty">Nothing recorded yet.</p>`;

  const row = (coll, x, path, main, meta) => `
    <li data-el="${coll}-${esc(x.id || "")}"><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:0px;--rb-c3:${ctx.edit ? "40px" : "0px"}">
      <span class="rb-row-text"><b${edIn(ctx, path, "")}>${main}</b><br><span class="rb-meta">${meta}</span></span>
      <span></span><span></span>
      <span class="rb-meta r">${delBtn(ctx, coll, x.id)}</span>
    </div></li>`;

  const group = (title, n, body, coll, addLabel) =>
    groupBlock(ctx, `dec:${coll}`, title, `<span class="rb-nav-count">${n}</span>`,
      `<ul class="rb-rows">${body}</ul>${addBtn(ctx, coll, addLabel)}`);

  return head("Decision log") +
    (ds.length || ctx.edit
      ? group("Decisions made", ds.length, ds.map((x) => row("decisions", x,
          `decisions[id=${x.id}].text`, esc(x.text || x.decision),
          [x.by, fmtDate(x.at), x.meeting, x.binds].filter(has).map(esc).join(" \u00b7 "))).join(""),
        "decisions", "Record a decision")
      : "") +
    (pl.length || ctx.edit
      ? group("Open items", pl.length, pl.map((x) => row("parkingLot", x,
          `parkingLot[id=${x.id}].text`, esc(x.text),
          [x.by, x.why, x.disposition || "open"].filter(has).map(esc).join(" \u00b7 "))).join(""),
        "parkingLot", "Park something")
      : "") +
    (ms.length || ctx.edit
      ? group("Meetings", ms.length, ms.map((m) => `
          <li data-el="meeting-${esc(m.id || "")}"><div class="rb-row no-id" style="--rb-c1:0px;--rb-c2:110px;--rb-c3:${ctx.edit ? "150px" : "110px"}">
            <span class="rb-row-text"><b${edIn(ctx, `meetings[id=${m.id}].type`, "")}>${esc(m.type)}</b></span><span></span>
            <span class="rb-meta r">${ctx.edit
              ? `<input class="rb-in" type="date" data-edit="date" data-coll="meetings" data-id="${esc(m.id)}"
                        value="${esc(dateVal(m.date))}" aria-label="Date">`
              : esc(fmtDate(m.date))}</span>
            <span class="rb-meta r">${arr(m.attendees).length} attended${m.duration ? ` \u00b7 ${esc(m.duration)}` : ""}${
              delBtn(ctx, "meetings", m.id)}</span>
          </div></li>`).join(""), "meetings", "Log a meeting")
      : "");
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
/* A hard divider between two questions that share a section.
   "Risk" was doing two jobs: a four-day turnaround is a reason we might not WIN,
   a 96% fill-rate SLA with liquidated damages is a reason we might not DELIVER.
   Same word, opposite decisions, one undifferentiated list. Each half now states
   its question as a heading and says in one line what belongs under it. */
function half(question, gloss) {
  return `<div class="rb-half">
    <h2 class="rb-half-q">${esc(question)}</h2>
    <p class="rb-half-gloss">${esc(gloss)}</p>
  </div>`;
}

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

/* ---------- the persistent pursuit header ----------
   Two things are true on every tab: who is on this, and where we are in time.
   They used to be a zone on TLDR, which meant they were true everywhere and
   visible in one place. Now they sit above the tabs and never move.

   The rail is RESPONSE dates only and shows position, never progress. See
   deriveRail for why that constraint is what makes it trustworthy. */
/* "in 13 days" beats "Sep 21" alone and both beat neither. The absolute date is
   what you put in a calendar; the relative one is what tells you to move. */
const relDays = (n) =>
  n === 0 ? "today"
  : n === 1 ? "tomorrow"
  : n === -1 ? "yesterday"
  : n > 0 ? `in ${n} days`
  : `${Math.abs(n)} days ago`;

const initials = (n) => String(n || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();

function pursuitHeader(p, d, ctx) {
  const ppl = d.people, rail = d.rail;
  if (!ppl.ok && !rail.ok) return "";

  const person = (x, isPoint) => `
    <button type="button" class="rb-who${isPoint ? " is-point" : ""}${x.late ? " is-late" : ""}"
      data-who="${esc(x.name)}"
      title="${esc(x.name)}${x.role ? ` — ${esc(x.role)}` : ""} · ${plural(x.open, "open item")}${
        x.late ? `, ${x.late} past due` : ""}. Show their items.">
      <span class="rb-who-av" aria-hidden="true">${esc(initials(x.name))}</span>
      <span class="rb-who-name">${esc(x.name)}</span>
      ${x.open ? `<span class="rb-who-n">${x.open}</span>` : ""}
    </button>`;

  const people = ppl.ok ? `
    <div class="rb-hdr-people">
      ${ppl.point ? `<span class="rb-hdr-lab">${ppl.point.source === "stated" ? "Point person" : "Response lead"}</span>${person(ppl.point, true)}` : ""}
      ${ppl.people.length ? `<span class="rb-hdr-sep" aria-hidden="true"></span>${ppl.people.map((x) => person(x, false)).join("")}` : ""}
      ${ppl.unassigned ? `<button type="button" class="rb-who is-unassigned" data-who=""
          title="${plural(ppl.unassigned, "open item")} with no owner. Show them.">
          <span class="rb-who-name">Unassigned</span><span class="rb-who-n">${ppl.unassigned}</span></button>` : ""}
    </div>` : "";

  /* The rail carries POSITION; the key carries NAMES and every date we hold.
     Splitting them is what lets both be true at once — the dots stay
     proportional, so a cluster still looks like a cluster and TODAY still means
     something, while the names get a full-width row where nothing has to be
     truncated. Before this the names sat on the axis: measured across
     1100-1680px, three of four were cut off at every width and the two at the
     ends hung past the track. Lanes stopped them colliding; nothing could make
     them legible in that space. */
  const marks = (r) => `${r.submission ? " is-sub" : ""}${r.kind === "program" ? " is-theirs" : ""}${
    r.days < 0 ? " is-done" : ""}`;

  /* The interval to the previous item, printed on the connector. Days up to a
     fortnight, then weeks, then months: "+19mo" is the shape of the fact, where
     "+570d" is arithmetic left for the reader to do. */
  const gapText = (n) => {
    const a = Math.abs(n);
    if (a === 0) return "same day";
    if (a <= 14) return `${a}d`;
    if (a < 60) return `${Math.round(a / 7)}w`;
    return `${Math.round(a / 30.4)}mo`;
  };

  const item = (r, i) => {
    const gap = i === 0 || r.gap === null || r.gap === undefined ? ""
      : `<span class="rb-rail-gap" aria-hidden="true">${esc(gapText(r.gap))}</span>`;
    if (r.today) return `<li class="rb-rail-i is-today">${gap}
      <span class="rb-rail-dot" aria-hidden="true"></span>
      <b>Today</b></li>`;
    return `<li class="rb-rail-i${marks(r)}">${gap}
      <a href="${goHref("timeline")}" data-goto="timeline"
         title="${esc(r.label)} · ${esc(fmtDate(r.date))} · ${relDays(r.days)}">
        <span class="rb-rail-dot" aria-hidden="true"></span>
        <b>${esc(r.label)}</b>
        <span class="rb-rail-when">${esc(fmtDate(r.date))} · ${relDays(r.days)}</span>
      </a></li>`;
  };

  /* ONE instrument. There is no key underneath any more: a name that was not on
     a dot was the whole complaint, and two lists describing one calendar made
     the reader hold two orderings at once to answer a question about either. The
     arrows are for the mouse — the strip scrolls with a trackpad, a shift-wheel
     and the keyboard regardless — and they hide themselves when it all fits. */
  const track = rail.ok ? `
    <div class="rb-rail">
      <button type="button" class="rb-rail-nav is-prev" data-railnav="-1"
              aria-label="Earlier dates" hidden>&#8249;</button>
      <div class="rb-rail-scroll">
        <ol class="rb-rail-seq">${rail.seq.map(item).join("")}</ol>
      </div>
      <button type="button" class="rb-rail-nav is-next" data-railnav="1"
              aria-label="Later dates" hidden>&#8250;</button>
    </div>` : "";

  return `<div class="rb-hdr">${people}${track}</div>`;
}

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
    opened: readOpened(pack.briefId),
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
  /* Entries that have at least one live tab. An entry whose every section is
     absent from this pack emits nothing — no empty heading, no dead tab. */
  const page = live.filter((x) => !x.chrome);
  const entries = ENTRIES
    .map((e) => ({ ...e, tabs: page.filter((x) => x.entry === e.id) }))
    .filter((e) => e.tabs.length);
  const remembered = readTabs(pack.briefId);

  mount.innerHTML = `
    <div class="rb-shell">
      <nav class="rb-nav" aria-label="Brief sections">
        <div class="rb-nav-eyebrow">${esc(pack.client || "Brief")}</div>
        ${entries.map((e) => {
          /* The count on an entry is the sum of its tabs' counts — the reader is
             choosing a job here, and "Build 14" is the size of the job. It is a
             quantity, never a state: see the ENTRIES comment. */
          const c = e.tabs.reduce((t, x) => t + (x.count ? (x.count(pack) || 0) : 0), 0);
          const first = remembered[e.id] && e.tabs.some((t) => t.id === remembered[e.id])
            ? remembered[e.id] : e.tabs[0].id;
          return `<a href="${goHref(first)}" data-goto="${first}" data-entry="${e.id}"><span>${esc(e.label)}</span>${
            c ? `<span class="rb-nav-count">${c}</span>` : ""}</a>`;
        }).join("")}
        ${live.some((s) => s.chrome && s.id === "documents")
          ? `<a href="${goHref("documents")}" data-goto="documents" class="rb-nav-chrome"><span>Documents</span><span class="rb-nav-count">${arr(pack.documents).length}</span></a>`
          : ""}
      </nav>
      <main class="rb-main"><div class="rb-col">
        ${pursuitHeader(pack, d, ctx)}
        ${entries.filter((e) => e.tabs.length > 1).map((e) => `
          <div class="rb-tabs" data-tabsfor="${e.id}" role="tablist" aria-label="${esc(e.label)} views" hidden>
            ${e.tabs.map((t) => {
              const c = t.count ? t.count(pack) : null;
              return `<a role="tab" href="${goHref(t.id)}" data-goto="${t.id}" aria-selected="false">${esc(t.label)}${
                c ? `<span class="rb-tab-n">${c}</span>` : ""}</a>`;
            }).join("")}
          </div>`).join("")}
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
  /* Timeline kind filter. Same principle as the list chips: a CSS state flip on
     the wrapper, never a re-render — the kind rules already live in the
     stylesheet, so this only has to move one attribute. */
  on("click", (e) => {
    const tl = e.target.closest("[data-tlchip]");
    if (tl) {
      e.preventDefault();
      const wrap = tl.closest(".rb-section")?.querySelector(".rb-timewrap");
      if (!wrap) return;
      wrap.dataset.kind = tl.dataset.tlchip;
      tl.parentElement.querySelectorAll("[data-tlchip]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b === tl)));
      return;
    }
    const chip = e.target.closest("[data-lchip]");
    if (chip) {
      e.preventDefault();
      const list = chip.closest(".rb-list");
      if (!list) return;
      const want = chip.dataset.lchip;
      list.dataset.filter = want;
      list.querySelectorAll("[data-lchip]").forEach((b) =>
        b.setAttribute("aria-pressed", String(b === chip)));
      // Tell the reader when a filter has hidden everything, rather than
      // showing an empty box that reads as missing data.
      const vis = [...list.querySelectorAll(".rb-rows > li")]
        .filter((li) => getComputedStyle(li).display !== "none").length;
      const empty = list.querySelector(".rb-filter-empty");
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
      if (nowOpen) ctx.opened.add(key); else ctx.opened.delete(key);
      writeOpened(pack.briefId, ctx.opened);
    }
  });

  const show = (id, elId) => {
    /* Resolve in three steps, most specific first: an alias to its section, an
       ENTRY id to whichever of its tabs this reader last had open, then the
       section itself. Resolving entry ids means #/b/<pursuit>/decide is a
       working link, which is what people type when they paste a job rather
       than a view. */
    let asked = SECTION_ALIASES[id] || id;
    const asEntry = entries.find((e) => e.id === asked);
    if (asEntry) {
      const seen = readTabs(pack.briefId)[asEntry.id];
      asked = seen && asEntry.tabs.some((t) => t.id === seen) ? seen : asEntry.tabs[0].id;
    }
    const target = live.some((s) => s.id === asked) ? asked : "snapshot";
    const ent = entryOf(target);
    writeTab(pack.briefId, ent, target);

    mount.querySelectorAll(".rb-section").forEach((el) =>
      el.setAttribute("data-active", String(el.dataset.section === target)));
    /* The nav marks the ENTRY, and its href follows the reader so that clicking
       away and back returns to the tab they were on rather than the first one. */
    mount.querySelectorAll(".rb-nav a[data-entry]").forEach((a) => {
      const on = a.dataset.entry === ent;
      a.setAttribute("aria-current", String(on));
      if (on) { a.dataset.goto = target; a.setAttribute("href", goHref(target)); }
    });
    mount.querySelectorAll(".rb-nav-chrome").forEach((a) =>
      a.setAttribute("aria-current", String(a.dataset.goto === target)));
    mount.querySelectorAll(".rb-tabs").forEach((bar) => {
      bar.hidden = bar.dataset.tabsfor !== ent;
      bar.querySelectorAll("[role=tab]").forEach((t) =>
        t.setAttribute("aria-selected", String(t.dataset.goto === target)));
    });
    if (elId) {
      /* Look inside the DESTINATION section, and skip anything that is itself a
         link. A cross-reference carries its target's id — <a data-goto="questions"
         data-el="question-Q-1"> — so a document-wide querySelector for that id
         matched the LINK, which sits earlier in the DOM than the row it points
         at. The jump then "landed" on the anchor the reader had just clicked,
         in a section that was no longer displayed: nothing scrolled, nothing
         flashed, and the link read as dead. Every navigation link has data-goto
         and no target row does, so that is the thing to filter on. */
      const scope = mount.querySelector(`#rb-${CSS.escape(target)}`) || mount;
      const cands = [...scope.querySelectorAll(`[data-el="${CSS.escape(elId)}"]`)];
      const el = cands.find((n) => !n.hasAttribute("data-goto")) || cands[0];
      if (el) {
        reveal(el);
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("rb-flash"); void el.offsetWidth; el.classList.add("rb-flash");
      }
    } else {
      scrollTo({ top: 0, behavior: "instant" });
    }
    o.onNavigate(target);
  };

  /* A JUMP HAS TO LAND. An R-### link, a Q-### link, a readiness blocker or a
     shared deep link can address a row sitting inside a collapsed group, inside
     a closed disclosure, or filtered out of the visible set — and now that every
     group opens collapsed, that is the common case rather than the edge one.
     scrollIntoView on a hidden element scrolls nowhere and the flash lands on
     something nobody can see, so the link reads as broken when it worked
     perfectly. Open every container between the section and the row, clear a
     filter that would hide it, and open the row's OWN disclosure — following a
     link to a requirement means you want the requirement, not its one-line
     summary. */
  const reveal = (el) => {
    for (let n = el.parentElement; n && n !== mount; n = n.parentElement) {
      if (n.tagName === "DETAILS" && !n.open) n.open = true;
      if (n.classList.contains("rb-list-body") && n.hidden) {
        n.hidden = false;
        const btn = n.closest(".rb-list")?.querySelector("[data-lcollapse]");
        if (btn) {
          btn.setAttribute("aria-expanded", "true");
          ctx.opened.add(btn.dataset.lcollapse);
          writeOpened(pack.briefId, ctx.opened);
        }
      }
      if (n.classList.contains("rb-list") && n.dataset.filter && n.dataset.filter !== "all") {
        n.dataset.filter = "all";
        n.querySelectorAll("[data-lchip]").forEach((b) =>
          b.setAttribute("aria-pressed", String(b.dataset.lchip === "all")));
        const empty = n.querySelector(".rb-filter-empty");
        if (empty) empty.hidden = true;
      }
    }
    const own = el.querySelector("details:not([open])");
    if (own) own.open = true;
  };

  /* A person in the header is a way into their work. The action checklist is
     already grouped BY OWNER, so "filter to this person" is: open Our readiness,
     make sure their group is expanded, and put it under the reader's eye. No
     second filtering mechanism, and nobody else's collapse preference is
     disturbed on the way. */
  on("click", (e) => {
    const who = e.target.closest("[data-who]");
    if (!who) return;
    e.preventDefault();
    const key = `act:${who.dataset.who || "Unassigned"}`;
    show("plan");
    const list = mount.querySelector(`.rb-list[data-list="${CSS.escape(key)}"]`);
    if (!list) return;
    const btn = list.querySelector("[data-lcollapse]");
    const body = list.querySelector(".rb-list-body");
    if (btn && btn.getAttribute("aria-expanded") !== "true") {
      btn.setAttribute("aria-expanded", "true");
      if (body) body.hidden = false;
      ctx.opened.add(key);
      writeOpened(pack.briefId, ctx.opened);
    }
    list.scrollIntoView({ behavior: "smooth", block: "center" });
    list.classList.remove("rb-flash"); void list.offsetWidth; list.classList.add("rb-flash");
  });

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
      const sel = f.dataset.key || "id";
      o.onEdit({
        kind: "set", coll: f.dataset.coll, itemId: f.dataset.id, field,
        path: `${f.dataset.coll}[${sel}=${f.dataset.id}].${field}`,
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
                   itemKey: del.dataset.delkey || "id",
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

  /* Remember which sections this person has opened, per brief. */
  on("toggle", (e) => {
    const g = e.target.closest?.(".rb-qgroup[data-topic]");
    if (!g || g.dataset.topic === "__new") return;
    if (g.open) ctx.opened.add(g.dataset.topic); else ctx.opened.delete(g.dataset.topic);
    writeOpened(current.briefId, ctx.opened);
  }, true);

  /* The rail opens where the reader is, and the arrows stay honest about what is
     off-screen. A pursuit carrying a client programme runs to a dozen items, so a
     strip that starts at scrollLeft 0 opens on dates that have already passed and
     hides the submission off the right edge. Put TODAY one item in from the left. */
  const railScroll = mount.querySelector(".rb-rail-scroll");
  if (railScroll) {
    const prevBtn = mount.querySelector(".rb-rail-nav.is-prev");
    const nextBtn = mount.querySelector(".rb-rail-nav.is-next");
    const sync = () => {
      const max = railScroll.scrollWidth - railScroll.clientWidth;
      /* Two pixels of slack. Sub-pixel layout leaves a strip scrollable by half a
         pixel, which lights an arrow that does nothing when you click it. */
      if (prevBtn) prevBtn.hidden = max <= 2 || railScroll.scrollLeft <= 2;
      if (nextBtn) nextBtn.hidden = max <= 2 || railScroll.scrollLeft >= max - 2;
    };
    on("click", (e) => {
      const b = e.target.closest("[data-railnav]");
      if (!b) return;
      e.preventDefault();
      railScroll.scrollBy({ left: Number(b.dataset.railnav) * railScroll.clientWidth * 0.8,
                            behavior: "smooth" });
    });
    railScroll.addEventListener("scroll", sync, { passive: true, signal: rbAC.signal });
    addEventListener("resize", sync, { signal: rbAC.signal });
    /* Two frames, not one. The first only guarantees the nodes are in the tree;
       the widths this position is computed from are not final until the frame
       after layout, and a scrollLeft written against provisional widths lands
       somewhere arbitrary. */
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const today = railScroll.querySelector(".rb-rail-i.is-today");
      /* Measured from rects, not offsetLeft. Every item is position:relative, so
         offsetLeft is reported against whatever positioned ancestor happens to be
         nearest — which included the sidebar, and put the opening scroll a couple
         of hundred pixels past where it was told to go. One item of the recent
         past stays visible to the left of TODAY: what just happened is the
         context for what is next. */
      if (today) {
        const x = today.getBoundingClientRect().left
          - railScroll.getBoundingClientRect().left + railScroll.scrollLeft;
        railScroll.scrollLeft = Math.max(0, x - 200);
      }
      sync();
    }));
  }

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
