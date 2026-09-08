/* ============================================================
   BID BOARD — hub shell
   Hash router, Library, Import, Brief chrome, Skills, Help.
   The shell finds a pursuit. The renderer draws it. No overlap.
   ============================================================ */

import { initStore, store, listPursuits, getPack, getPackBase, applyOverrides, getPursuit, putPursuit, updateIndex, deletePursuit, appendActivity, getAssetBytes, getAssetBytesLocal, ASSET_MAX_BYTES, getElements, setElement, replaceElements, listActivity, saveCheckpoint, listCheckpoints, deleteElement, subscribeBrief, subscribePursuits } from "./store.js";
import { validate, askLine, coverage, CURRENT_SCHEMA, MIN_SCHEMA } from "./schema.js";
import { unzip, asJson } from "./unzip.js";
import { renderBrief, derive, RENDERER_VERSION } from "./renderer/renderer.js";
import { mountComments, unmountComments, refreshComments } from "./comments.js";

const $ = (s, r = document) => r.querySelector(s);
const screen = $("#screen");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let CONFIG = { hubName: "Bid Board", baseUrl: "", hubVersion: "1.1.0" };
let LIBRARY = [];
let LIB_UNSUB = null;
const view = { filter: "all", phase: "any", owner: "any", sort: "deadline", q: "" };

const DAY = 864e5;

/* Whole days from today to a date, counted in LOCAL CALENDAR DAYS.
   Two faults this replaces, and they compounded. (1) Math.ceil over a raw
   millisecond difference returns -0 for a deadline that passed less than a day
   ago at any positive UTC offset, and `-0 < 0` is FALSE — so a deadline that
   passed yesterday still read as open, in the card state, the deadline sort,
   the "due this week" chip and the derived phase, all at once. (2) A date-only
   string ("2026-02-20") parses as UTC midnight, so comparing it against local
   midnight was off by the offset in either direction. Date-only values are
   therefore read as local dates, anything with a time is reduced to the local
   calendar day it falls on, and the subtraction is ROUNDED because a DST day
   is 23 or 25 hours long. */
const localDay = (v) => {
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s);
  return isNaN(d) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate());
};
const days = (v) => {
  if (!v) return null;
  const a = localDay(v);
  if (a === null) return null;
  const b = new Date(); b.setHours(0, 0, 0, 0);
  return Math.round((a - b) / DAY);
};
const fmtDate = (v) => { const d = new Date(v); return isNaN(d) ? "" : d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" }).replace(",", ""); };
const ago = (v) => {
  const n = Math.floor((Date.now() - new Date(v)) / DAY);
  return isNaN(n) ? "" : n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
};
const STAGE_LABEL = {
  ingested: "Ingested", "bid-decision": "Bid decision", workshop: "Workshop",
  drafting: "Drafting", review: "Review", submitted: "Submitted", "no-bid": "No-bid",
};

/* ---------------- boot ---------------- */
(async function boot() {
  try { CONFIG = { ...CONFIG, ...(await (await fetch("config.json", { cache: "no-store" })).json()) }; } catch {}
  document.title = CONFIG.hubName;
  $(".hub-brand span:last-child").textContent = CONFIG.hubName;
  initAnalytics();

  await initStore();
  // Demo/preview build: sample packs are baked into the page. Same code path as
  // a real import, so what you click here is what the deployed site does.
  if (globalThis.__DEMO_PACKS__) {
    for (const d of globalThis.__DEMO_PACKS__) {
      await putPursuit({ index: indexFromPack(d.pack, { who: d.importedBy || "Jess", importedAt: d.importedAt }), pack: d.pack, assets: new Map() });
    }
    document.body.dataset.demo = "1";
  }
  paintConnection();
  LIBRARY = await listPursuits();

  addEventListener("hashchange", route);
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) $("#morePop").hidden = true; });
  route();
})();

/* ---------------- analytics ----------------
   GA4, and only if a measurement ID is configured. With the field empty no
   Google script is requested at all, which is the state the site ships in.
   Client names are the sensitive part of a URL here, so page_view is sent with
   a normalized path — "/brief" not "/b/allianz-partners". You get section and
   funnel data; GA never receives who Experis is bidding for. */
function initAnalytics() {
  const id = CONFIG.analytics?.measurementId?.trim();
  if (!id || !/^G-[A-Z0-9]+$/i.test(id) || globalThis.__DEMO_PACKS__) return;

  const s = document.createElement("script");
  s.async = true;
  s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () { window.dataLayer.push(arguments); };
  gtag("js", new Date());
  gtag("config", id, { send_page_view: false, anonymize_ip: true });

  ANALYTICS.on = true;
  addEventListener("hashchange", trackView);
  trackView();
}

const ANALYTICS = { on: false };

const safePath = () => {
  const [, head, a] = (location.hash.replace(/^#/, "") || "/").split("/");
  if (head === "b") return a ? "/brief" : "/brief";
  return { import: "/import", skills: "/skills", help: "/help" }[head] || "/library";
};

function trackView() {
  if (!ANALYTICS.on) return;
  gtag("event", "page_view", {
    page_path: safePath(),
    page_title: `${CONFIG.hubName} — ${safePath().slice(1)}`,
    page_location: location.origin + location.pathname + "#" + safePath(),
  });
}

/* Named events for the things worth knowing: is anyone importing, is anyone
   editing. Never carries a client name, a brief id, or field content. */
function track(name, params = {}) {
  if (!ANALYTICS.on) return;
  try { gtag("event", name, params); } catch {}
}

function paintConnection() {
  if (globalThis.__DEMO_PACKS__) {
    for (const el of [$("#connPill"), $("#briefConn")]) {
      el.textContent = CONFIG.hubVersion ? `v${CONFIG.hubVersion} demo` : "Demo";
      el.dataset.mode = "local";
      el.setAttribute("aria-label", `Demo build, version ${CONFIG.hubVersion || "unknown"}`);
      el.title = "Sample data baked into this file. Nothing is saved and nobody else sees it.";
    }
    return;
  }
  /* The pill shows the deployed VERSION; the dot shows the state.
     "Shared" was the right word exactly once — the first time you read it. After
     that it is a constant, and a constant tells you nothing. What people
     actually need from this corner is "am I looking at the build I just pushed?",
     which is unanswerable on a static site with no other stamp.

     The mode is not lost, it moves to the dot: green shared, red offline, gray
     local-only. Color alone is never the only carrier — the tooltip still says
     it in words, and the version is prefixed for screen readers. */
  const mode = !navigator.onLine ? "offline" : store.mode;
  const label = { shared: "Shared", local: "Local only", offline: "Offline" }[mode];
  const ver = CONFIG.hubVersion ? `v${CONFIG.hubVersion}` : "—";
  for (const el of [$("#connPill"), $("#briefConn")]) {
    el.textContent = ver;
    el.dataset.mode = mode;
    el.setAttribute("aria-label", `${label} · version ${CONFIG.hubVersion || "unknown"}`);
    el.title = (mode === "shared" ? "Shared — imports are visible to everyone on this site."
      : mode === "local" ? "Local only — no shared storage configured, so imports stay in this browser."
      : "Offline — showing what's cached in this browser.")
      + `\nBid Board ${ver}`;
  }
}

/* ---------------- router ---------------- */
function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [, head, a, b] = hash.split("/");
  const inBrief = head === "b";

  // inside the help-page embed, drop the hub chrome so the frame reads as the brief
  const embedded = window.top !== window.self;
  if (embedded) document.body.dataset.embed = "1";

  // Leaving a brief takes the review layer with it — the button and panel are
  // body-level chrome and would otherwise follow you to the Library.
  // Leaving a view takes its live listeners with it. An orphaned onSnapshot keeps
  // firing against a BRIEF that no longer exists, which reads as a ghost re-render.
  if (!inBrief) { unmountComments(); BRIEF?.unsub?.(); BRIEF = null; }
  if (head !== "" && head !== undefined) { LIB_UNSUB?.(); LIB_UNSUB = null; }

  $("#hubHead").hidden = inBrief || embedded;
  $("#briefBar").hidden = !inBrief || embedded;
  $("#morePop").hidden = true;

  // Match on the first segment, not the whole hash — otherwise a sub-route like
  // #/help/deck un-highlights its own nav item.
  document.querySelectorAll(".hub-nav a").forEach((el) => {
    const target = el.getAttribute("href").replace(/^#\/?/, "").split("/")[0];
    el.setAttribute("aria-current", String(target === (head || "")));
  });

  if (inBrief) return screenBrief(a, b);
  if (head === "analytics") return screenAnalytics();
  if (head === "import") return screenImport();
  if (head === "skills") return screenSkills();
  if (head === "help") return screenHelp();
  return screenLibrary();
}

const wrap = (html, narrow) => `<div class="wrap ${narrow ? "wrap-narrow" : ""}">${html}</div>`;

/* ============================================================
   LIBRARY
   ============================================================ */
async function screenLibrary() {
  screen.innerHTML = wrap(`
    <div class="page-head"><div class="eyebrow">Library</div><h1 class="h1">Opportunities</h1></div>
    <div class="cards">${'<div class="skel"></div>'.repeat(3)}</div>`);

  LIBRARY = await listPursuits();
  if (!LIBRARY.length) paintEmpty(); else paintLibrary();

  /* The Library is shared state — somebody else importing a pursuit should make
     it appear here without a refresh. Repaint only when the set actually differs,
     so a readiness recalculation elsewhere doesn't flicker the whole grid. */
  LIB_UNSUB?.();
  LIB_UNSUB = subscribePursuits((rows) => {
    if (location.hash.replace(/^#\/?/, "").split("/")[0] !== "") return;
    if (JSON.stringify(rows) === JSON.stringify(LIBRARY)) return;
    LIBRARY = rows;
    if (!LIBRARY.length) paintEmpty(); else paintLibrary();
  });
}

function paintEmpty() {
  screen.innerHTML = wrap(`
    <div class="page-head">
      <div class="eyebrow">Library</div>
      <h1 class="h1">No opportunities yet</h1>
      <p class="sub" style="margin-top:8px">Four steps. The first is a one-time setup.</p>
    </div>
    ${STEPS}
    ${modeNote() ? `<div style="margin-top:26px">${modeNote()}</div>` : ""}`);
  // full-width wrap on purpose: the empty state and the populated library must
  // share a left edge, or importing the first pursuit makes the page jump.
}

const STEPS = `
  <ol class="steps">
    <li>Download the <code>/rfp</code> skill from <a href="#/skills">Get the skills</a> and load it
      into your AI assistant. <span class="muted">Once — not per pursuit.</span></li>
    <li>Open the folder with the RFP documents in your assistant and say <code>run /rfp</code>.</li>
    <li>You'll get a file whose name ends in <code>-rfp-bundle.zip</code>.</li>
    <li>Click <b>Import a pursuit</b> at the top of this page, and drop that file in.</li>
  </ol>`;

const modeNote = () => globalThis.__DEMO_PACKS__ ? DEMO_NOTE : store.mode === "local" ? LOCAL_NOTE : "";

const DEMO_NOTE = `<div class="notice notice-quiet">
  <b>Demo.</b> Sample opportunities are baked into this file so you can click around. Nothing is
  saved, nothing is shared, and the Import screen works on real /RFP bundles if you have one.</div>`;

const LOCAL_NOTE = `<div class="notice notice-quiet">
  <b>Local only.</b> No shared storage is configured, so anything you import stays in this
  browser and nobody else sees it in the list. Everything else works. Whoever set the site
  up can turn sharing on by adding the Firebase config.</div>`;

function paintLibrary() {
  const counts = (s) => LIBRARY.filter((p) => matchFilter(p, s)).length;
  const soon = LIBRARY.filter((p) => { const d = days(p.deadline); return d !== null && d >= 0 && d <= 7; }).length;
  screen.innerHTML = wrap(`
    <div class="page-head">
      <div class="eyebrow">Library</div>
      <h1 class="h1">Opportunities</h1>
      ${soon ? `<p class="sub" style="margin-top:6px"><b style="color:var(--urgent)">${soon} due this week</b></p>` : ""}
    </div>
    <div class="filters">
      ${["all", "open", "soon", "closed"].map((f) => `
        <button class="chip" data-libfilter="${f}" aria-pressed="${view.filter === f}"
          ${counts(f) ? "" : "disabled"}>${
          { all: "All", open: "Open", soon: "Due this week", closed: "Closed" }[f]
        }<b>${counts(f)}</b></button>`).join("")}
      <span class="spacer"></span>
      <select id="phase" aria-label="Phase">
        <option value="any"${view.phase === "any" ? " selected" : ""}>Any phase</option>
        ${Object.entries(PHASES).map(([k, label]) => {
          const n = LIBRARY.filter((x) => phaseOf(x) === k).length;
          return `<option value="${k}"${view.phase === k ? " selected" : ""}${n ? "" : " disabled"}>${label} (${n})</option>`;
        }).join("")}
      </select>
      <select id="owner" aria-label="Owner">
        <option value="any"${view.owner === "any" ? " selected" : ""}>Anyone</option>
        ${allOwners().map((n) => {
          const c = LIBRARY.filter((x) => ownersOf(x).includes(n)).length;
          return `<option value="${esc(n)}"${view.owner === n ? " selected" : ""}>${esc(n)} (${c})</option>`;
        }).join("")}
      </select>
      <input type="search" id="q" placeholder="Search client or id" value="${esc(view.q)}">
      <select id="sort">
        <option value="deadline"${view.sort === "deadline" ? " selected" : ""}>Deadline</option>
        <option value="recent"${view.sort === "recent" ? " selected" : ""}>Recently imported</option>
        <option value="client"${view.sort === "client" ? " selected" : ""}>Client A–Z</option>
      </select>
    </div>
    <p class="lib-note muted small" id="libNote"></p>
    <div class="cards" id="cards"></div>
    ${modeNote() ? `<div style="margin-top:26px">${modeNote()}</div>` : ""}`);

  paintCards();

  screen.querySelector(".filters").addEventListener("click", (e) => {
    const c = e.target.closest("[data-libfilter]");
    if (c) { view.filter = c.dataset.libfilter; paintLibrary(); }
  });
  $("#q").addEventListener("input", (e) => { view.q = e.target.value; paintCards(); });
  $("#sort").addEventListener("change", (e) => { view.sort = e.target.value; paintCards(); });
  $("#phase").addEventListener("change", (e) => { view.phase = e.target.value; paintCards(); });
  $("#owner").addEventListener("change", (e) => { view.owner = e.target.value; paintCards(); });
}

/* Every name the library knows, from the roster, the action items and the point
   person of every pursuit. Built from the index docs, so opening the filter
   costs no reads. */
function allOwners() {
  return [...new Set(LIBRARY.flatMap(ownersOf))].sort((a, b) => String(a).localeCompare(String(b)));
}

/* Filters derive from the DEADLINE, never from a stage field.
   The six-step pipeline was removed because nothing keeps it honest: it only
   moves when a human remembers to move it, and a stale "Drafting" on a pursuit
   submitted three weeks ago is worse than no label at all. A deadline is in the
   documents, so these buckets are always true without anyone maintaining them. */
/* ---------- derived phase ----------
   "Group it by stage" was never a question about one bid: "if I filter to
   Andreas, I've got one RFP in early phase, two in middle, one in late." So
   phase is a PORTFOLIO lens, and like every other bucket on this page it is
   derived and never written down. The six-step stage field was removed for
   exactly this reason — it only moved when somebody remembered to move it.

   Two honest signals, and we take the further along of the two: how much of the
   window from import to deadline has elapsed, and how ready we actually are.
   Time alone would call a finished bid "early" the week it was imported; readiness
   alone would never move on a pursuit nobody has touched. Neither is editable
   and neither can go stale, because both recompute on every render. */
const PHASES = { early: "Early", mid: "Mid", late: "Late", closed: "Closed" };

function phaseOf(p) {
  const d = days(p.deadline);
  if (d !== null && d < 0) return "closed";
  if (p.outcome && p.outcome.status && p.outcome.status !== "pending") return "closed";

  const ready = typeof p.readiness === "number" ? p.readiness : 0;
  let elapsed = 0;
  const start = p.importedAt ? new Date(p.importedAt).getTime() : NaN;
  const end = p.deadline ? new Date(p.deadline).getTime() : NaN;
  if (!isNaN(start) && !isNaN(end) && end > start) {
    elapsed = Math.max(0, Math.min(1, (Date.now() - start) / (end - start)));
  }
  /* No deadline and no readiness is not "early", it is unknown — but a bucket
     called unknown would collect every thin pack and tell nobody anything, and
     a freshly imported pursuit genuinely is early. Say early, and let the
     readiness column on the card carry the caveat. */
  const progress = Math.max(elapsed, ready);
  return progress >= 0.67 ? "late" : progress >= 0.34 ? "mid" : "early";
}

const ownersOf = (p) => (Array.isArray(p.owners) && p.owners.length ? p.owners
  : [p.pointPerson].filter(Boolean));

function matchFilter(p, f) {
  if (f === "all") return true;
  const d = days(p.deadline);
  if (f === "soon")   return d !== null && d >= 0 && d <= 7;
  if (f === "closed") return d !== null && d < 0;
  return d === null || d >= 0;                 // "open"
}

function paintCards() {
  const q = view.q.trim().toLowerCase();
  let rows = LIBRARY.filter((p) => matchFilter(p, view.filter))
    .filter((p) => view.phase === "any" || phaseOf(p) === view.phase)
    .filter((p) => view.owner === "any" || ownersOf(p).includes(view.owner))
    .filter((p) => !q || `${p.client} ${p.title} ${p.briefId}`.toLowerCase().includes(q));

  rows.sort((a, b) => {
    if (view.sort === "client") return String(a.client).localeCompare(String(b.client));
    if (view.sort === "recent") return String(b.importedAt).localeCompare(String(a.importedAt));
    const da = days(a.deadline), db_ = days(b.deadline);
    const rank = (d) => (d === null ? 2 : d < 0 ? 1 : 0);              // past deadlines sink
    return rank(da) - rank(db_) || (da ?? 0) - (db_ ?? 0);
  });

  $("#cards").innerHTML = rows.length
    ? rows.map(card).join("")
    : `<p class="muted">Nothing matches that.</p>`;

  /* Say what is being hidden and offer the way back. A filtered list that looks
     like the whole list is how somebody concludes the board is missing a
     pursuit that is sitting right there behind a select they forgot. */
  const narrowed = [
    view.filter !== "all" ? { k: "filter", v: "all", t: { open: "Open", soon: "Due this week", closed: "Closed" }[view.filter] } : null,
    view.phase !== "any" ? { k: "phase", v: "any", t: PHASES[view.phase] + " phase" } : null,
    view.owner !== "any" ? { k: "owner", v: "any", t: view.owner } : null,
    q ? { k: "q", v: "", t: `"${view.q.trim()}"` } : null,
  ].filter(Boolean);
  const note = $("#libNote");
  if (note) {
    note.innerHTML = narrowed.length
      ? `Showing <b>${rows.length}</b> of ${LIBRARY.length} · ${narrowed.map((x) => esc(x.t)).join(" · ")}
         <button class="linkish" id="clearFilters">Clear</button>`
      : "";
    const clear = $("#clearFilters");
    if (clear) clear.addEventListener("click", () => {
      view.filter = "all"; view.phase = "any"; view.owner = "any"; view.q = "";
      paintLibrary();
    });
  }
}

function card(p) {
  const d = days(p.deadline);
  const stale = p.schemaVersion > CURRENT_SCHEMA || p.schemaVersion < MIN_SCHEMA;
  const state = d === null ? "" : d < 0 ? "is-past" : d <= 7 ? "is-urgent" : "";
  const ready = typeof p.readiness === "number" ? Math.round(p.readiness * 100) : null;
  const c = p.counts || {};

  /* WHAT IS OUTSTANDING, not how many requirements exist.
     The old line read "22 reqs · 16 open" and two separate readers parsed it as
     Bullhorn requisitions — "that would be number of job opportunities… that's
     how we would qualify in Bullhorn" — then could not say what the 22 meant.
     In a staffing company "reqs" is a reserved word, and a raw inventory count
     is not a reason to click anyway. What earns the space is what is unfinished
     and whether anyone owns it. */
  const bits = [];
  if (typeof c.openItems === "number") {
    bits.push(c.openItems
      ? `${c.openItems} open item${c.openItems === 1 ? "" : "s"}`
      : "nothing outstanding");
  }
  if (c.unassigned) bits.push(`<b class="card-warn">${c.unassigned} unassigned</b>`);
  if (c.atRisk) bits.push(`<b class="card-warn">${c.atRisk} at risk</b>`);
  const lift = p.responseLift && p.responseLift.size
    ? `<span class="card-lift" title="Effort to respond">${esc(p.responseLift.size)}</span>` : "";

  return `<a class="card ${stale ? "stale" : ""} ${state}" href="#/b/${esc(p.briefId)}">
    <div class="card-client">${esc(p.client)}</div>
    <div class="card-ask">${p.askLine ? esc(p.askLine) : "<span class='muted'>No summary in the pack.</span>"}</div>
    <div class="card-due">${p.deadline
      ? `<span>${d < 0 ? "Closed" : "Due"} ${esc(fmtDate(p.deadline))}</span>
         <span class="card-days">${d < 0 ? `${Math.abs(d)}d ago` : d === 0 ? "today" : `${d}d left`}</span>`
      : `<span class="muted" style="font-weight:400">No deadline captured</span>`}</div>

    ${stale
      ? `<div class="small muted">Needs a newer pack — built for schema v${esc(p.schemaVersion)}.</div>`
      : bits.length || lift
      ? `<div class="card-state">${lift}<span>${bits.join(" · ")}</span></div>`
      : ""}

    <div class="card-foot">
      ${ready !== null && !stale ? `<div class="card-ready">
        <span class="num">${ready}%</span>
        <span class="bar"><i style="width:${ready}%"></i></span>
        <span>ready</span></div>` : ""}
      <div class="card-prov" title="${esc(p.importedBy || "unknown")} · imported ${esc(ago(p.importedAt))}">${esc(ago(p.importedAt))}</div>
    </div></a>`;
}

/* ============================================================
   IMPORT
   ============================================================ */
let staged = null;

/* Never surface a raw JSON.parse message. "No number after minus sign at
   position 1" tells a proposal writer nothing they can act on. */
function parsePack(text) {
  try { return JSON.parse(text); }
  catch { throw new Error("That file isn't pursuit data — it doesn't read as a pack."); }
}

function screenImport() {
  staged = null;
  screen.innerHTML = wrap(`
    <div class="page-head">
      <div class="eyebrow">Import</div>
      <h1 class="h1">Add a pursuit</h1>
      <p class="sub" style="margin-top:6px">Drop the zip that /RFP produced. Nothing is saved until you confirm.</p>
    </div>
    <div class="stepstrip">
      <span data-s="1" aria-current="true">1 · Choose the file</span>
      <span data-s="2">2 · Check it</span>
      <span data-s="3">3 · Confirm</span>
      <span data-s="4">4 · Done</span>
    </div>
    <div id="importBody"></div>`, true);
  importStep(1);
}

function importStep(n, html) {
  document.querySelectorAll(".stepstrip span").forEach((s) =>
    s.setAttribute("aria-current", String(+s.dataset.s === n)));
  const body = $("#importBody");

  if (n === 1) {
    body.innerHTML = `
      <div class="drop" id="drop">
        <h2>Drop the bundle here</h2>
        <p class="sub small">A <code>-rfp-bundle.zip</code>, or a bare <code>pack.json</code>.</p>
        <p style="margin-top:16px"><label class="btn btn-primary">Choose a file
          <input type="file" id="file" accept=".zip,.json" hidden></label></p>
      </div>
      <p class="buildline">reads pack schema v${MIN_SCHEMA}–v${CURRENT_SCHEMA} · renderer ${RENDERER_VERSION} · hub ${esc(CONFIG.hubVersion)}</p>`;
    const drop = $("#drop");
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault(); drop.classList.remove("over");
      if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]);
    });
    $("#file").addEventListener("change", (e) => e.target.files[0] && readFile(e.target.files[0]));
    return;
  }
  body.innerHTML = html;
}

async function readFile(file) {
  importStep(2, `<p class="sub">Reading ${esc(file.name)}…</p>`);
  try {
    let pack = null, assets = new Map(), manifest = null;

    if (/\.json$/i.test(file.name)) {
      pack = parsePack(await file.text());
    } else {
      const files = await unzip(await file.arrayBuffer());
      const mf = [...files.keys()].find((k) => k.replace(/^.*\//, "") === "manifest.json");
      if (mf) manifest = asJson(files.get(mf));
      const packName = manifest?.pack
        ? [...files.keys()].find((k) => k.endsWith(manifest.pack))
        : [...files.keys()].find((k) => /pack\.json$/i.test(k))
          || [...files.keys()].filter((k) => /\.json$/i.test(k) && !/manifest\.json$/i.test(k))[0];
      if (!packName) throw new Error("That zip has no pack.json in it — it may not be a /RFP bundle.");
      pack = parsePack(new TextDecoder().decode(files.get(packName)));
      for (const [k, v] of files) {
        if (/^(.*\/)?(assets|docs)\//.test(k)) assets.set(k.replace(/^.*?(assets|docs)\//, "$1/"), v);
      }
    }

    const res = validate(pack);
    if (!res.ok) return importRefused(res);

    const existing = await getPursuit(res.summary.briefId);
    staged = { ...res, assets, existing, fileName: file.name };
    importReview();
  } catch (e) {
    importRefused({ reason: e.message || "That file couldn't be read.", hint: "If it isn't the zip /RFP produced, re-run /RFP and try that file." });
  }
}

function importRefused(r) {
  importStep(2, `
    <div class="notice bad"><b>Can't import that.</b><br>${esc(r.reason)}
      ${r.hint ? `<p style="margin-top:8px">${esc(r.hint)}</p>` : ""}</div>
    <p style="margin-top:18px;display:flex;gap:8px"><a class="btn" href="#/import">Try another file</a>
      <a class="btn" href="#/skills">Get the current /RFP skill</a></p>
    <p class="buildline">reads pack schema v${MIN_SCHEMA}–v${CURRENT_SCHEMA} · renderer ${RENDERER_VERSION} · hub ${
      esc(CONFIG.hubVersion)} — quote this line if you report it</p>`);
}

const SECTION_NAMES = {
  ask: "the ask", verdict: "our read", clientContext: "the client",
  competencyMix: "competency mix", submission: "how to submit", dates: "key dates",
  rules: "rules of the bid", scorecard: "scoring & fit", requirements: "delivery scope",
  actionItems: "our readiness", roster: "the people", team: "effort & team",
  questions: "questions to client", signals: "bid signals", risks: "risks",
  decisions: "decisions", parkingLot: "open items", meetings: "meetings",
  documents: "documents",
};

function importReview() {
  const s = staged.summary, up = !!staged.existing;
  const cov = coverage(staged.pack);
  importStep(3, `
    <div class="notice ${up ? "" : "good"}">
      <b>${up ? "Update an existing pursuit" : "New pursuit"}</b><br>
      ${esc(s.client)}${s.title ? ` — ${esc(s.title)}` : ""}
    </div>
    <dl class="kv">
      <dt>Pursuit id</dt><dd><code>${esc(s.briefId)}</code></dd>
      <dt>Deadline</dt><dd>${s.deadline ? esc(fmtDate(s.deadline)) : "<span class='muted'>not captured</span>"}</dd>
      <dt>Contents</dt><dd>${s.counts.requirements} requirements · ${s.counts.actionItems} action items ·
        ${s.counts.questions} questions · ${s.counts.documents} documents</dd>
      <dt>Built by /RFP</dt><dd>${s.generatedAt ? esc(fmtDate(s.generatedAt)) : "<span class='muted'>unknown</span>"}</dd>
      <dt>Populates</dt><dd>${cov.present} of ${cov.total} sections${
        cov.thin ? "" : cov.missing.length ? ` <span class="muted small">— ${
          esc(cov.missing.map((k) => SECTION_NAMES[k] || k).join(", "))} empty</span>` : ""}</dd>
      ${/* The portfolio fields. Stated here because a pack without them imports
            perfectly and then contributes nothing to Analytics, and the runner
            should learn that now rather than as a gap in a chart weeks later. */""}
      <dt>Portfolio</dt><dd>${[
        s.industry ? esc(s.industry) : null,
        s.bidValue ? `$${Math.round(Number(s.bidValue.amount)).toLocaleString()}` : null,
        s.competencyMix ? `${s.competencyMix} competencies` : null,
        s.pointPerson ? esc(s.pointPerson) : null,
      ].filter(Boolean).join(" · ") || `<span class="muted">no industry, bid value or competency split — this pursuit won't appear in the Analytics charts</span>`}</dd>
      ${staged.migratedFrom ? `<dt>Schema</dt><dd>migrated from v${staged.migratedFrom} to v${CURRENT_SCHEMA}</dd>` : ""}
      ${staged.assets.size ? `<dt>Files</dt><dd>${staged.assets.size} attached${
        CONFIG.carryDocuments === false ? " — kept in this browser only" : " — carried by the site"}${
        [...staged.assets.values()].some((b) => b.byteLength > ASSET_MAX_BYTES)
          ? `<br><span class="muted small">Anything over ${Math.round(ASSET_MAX_BYTES / 1048576)} MB stays local — too large for a Firestore document set.</span>` : ""}</dd>` : ""}
    </dl>
    ${cov.thin ? `<div class="notice bad" style="margin-top:16px">
      <b>This pack fills ${cov.present} of ${cov.total} sections.</b>
      Empty: ${esc(cov.missing.map((k) => SECTION_NAMES[k] || k).join(", "))}.
      A genuinely thin RFP looks like this and imports fine. So does a pack whose content
      is in a shape this site does not read${cov.hidden.length
        ? ` — and this one carries <code>${esc(cov.hidden.join("</code>, <code>"))}</code> at the root,
            which usually means the content is nested inside it` : ""}.
      Worth opening the brief straight after importing to check.</div>` : ""}
    ${up ? `<div class="notice" style="margin-top:16px">
      Edits the team has made here since the last import are kept — they layer on top of the
      new pack rather than being replaced by it. Only the imported content changes.</div>` : ""}
    ${s.carriesSourceDocs ? `<div class="notice" style="margin-top:12px">
      This bundle carries the client's source documents. Once imported they are readable by
      anyone with this site's URL. Confirm that's intended.</div>` : ""}
    ${modeNote() ? `<div style="margin-top:12px">${modeNote()}</div>` : ""}
    <p style="margin-top:24px;display:flex;gap:8px">
      <button class="btn btn-primary" id="doImport">${up ? "Update the opportunity" : "Import it"}</button>
      <a class="btn" href="#/import">Cancel</a></p>`);

  $("#doImport").addEventListener("click", doImport);
}

/* The Library card's whole content, derived from the pack. Shared by import and
   by the demo seeder so a preview build can never drift from the real thing. */
function indexFromPack(pack, o = {}) {
  const r = derive(pack).readiness;
  return {
    briefId: pack.briefId, client: pack.client, title: o.title ?? pack.title ?? "",
    askLine: askLine(pack),
    deadline: o.deadline ?? pack.submission?.date ?? null,
    stage: o.stage ?? pack.stage ?? "ingested",
    readiness: r.ok ? r.value : null,   // computed now, so the card is honest before anyone opens the brief
    counts: {
      requirements: (pack.requirements || []).length,
      openItems: (pack.actionItems || []).filter((i) => i.status !== "done").length,
      questions: (pack.questions || []).length,
    },
    /* Portfolio fields, denormalised onto the INDEX doc on purpose. The
       Analytics page asks questions across every pursuit at once; reading a
       whole pack per card to answer "win rate by industry" would be one Storage
       fetch per pursuit on a page that exists to be glanced at. These are small,
       flat, and refreshed on every import and every brief open. */
    industry: pack.industry || null,
    bidValue: pack.bidValue && Number(pack.bidValue.amount)
      ? { amount: Number(pack.bidValue.amount), currency: pack.bidValue.currency || "USD" } : null,
    outcome: pack.outcome && pack.outcome.status
      ? { status: pack.outcome.status, closedAt: pack.outcome.closedAt || null, reason: pack.outcome.reason || "" }
      : { status: "pending", closedAt: null, reason: "" },
    pointPerson: (pack.pointPerson && pack.pointPerson.name) || null,
    /* The mix as the board needs it: area and weight, nothing else. Derived
       through the renderer so a v4 pack contributes its hours-based split
       rather than nothing at all. */
    mix: (derive(pack).mix.areas || []).map((a) => ({ area: a.canonical || a.area, weight: a.weight })),
    owners: [...new Set([
      ...(pack.roster || []).map((r) => r.name),
      ...(pack.actionItems || []).map((i) => i.owner),
      (pack.pointPerson && pack.pointPerson.name) || null,
    ].filter(Boolean))],
    schemaVersion: CURRENT_SCHEMA, rendererVersionAtImport: RENDERER_VERSION,
    packBytes: JSON.stringify(pack).length,
    assets: o.assets || [],
    importedBy: o.existing?.importedBy || o.who || "unknown",
    importedAt: o.existing?.importedAt || o.importedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    generatedAt: pack.generatedAt || null,
    ...(o.migratedFrom ? { migratedFrom: o.migratedFrom } : {}),
  };
}

async function doImport() {
  const btn = $("#doImport"); btn.disabled = true; btn.textContent = "Saving…";
  const { pack, summary: s, assets, existing } = staged;
  const who = localStorage.getItem("hub.editor") || prompt("Your name (so the team knows who imported this):") || "unknown";
  localStorage.setItem("hub.editor", who);

  const index = indexFromPack(pack, {
    who, assets: [...assets.keys()], existing,
    migratedFrom: staged.migratedFrom, deadline: s.deadline, stage: s.stage, title: s.title,
  });

  try {
    await putPursuit({ index, pack, assets, carryDocuments: CONFIG.carryDocuments !== false });
    track("pursuit_import", { schema_version: pack.schemaVersion, requirements: (pack.requirements || []).length });
    await appendActivity(s.briefId, { kind: "import", editor: who, section: "—", after: `${staged.fileName} (schema v${CURRENT_SCHEMA})` });
    LIBRARY = await listPursuits();
    const url = `${location.origin}${location.pathname}#/b/${s.briefId}`;
    importStep(4, `
      <div class="notice good"><b>Imported.</b> ${esc(s.client)} is in the library.</div>
      <p style="margin-top:18px;display:flex;gap:8px"><a class="btn btn-primary" href="#/b/${esc(s.briefId)}">Open the brief</a>
        <a class="btn" href="#/">Back to the library</a></p>
      <p class="small muted" style="margin-top:24px">Share this link with the team:</p>
      <div class="copyrow"><input type="text" id="shareUrl" readonly value="${esc(url)}">
        <button class="btn" id="copyUrl">Copy</button></div>`);
    $("#shareUrl").select();
    $("#copyUrl").addEventListener("click", () => {
      navigator.clipboard.writeText(url); $("#copyUrl").textContent = "Copied";
    });
  } catch (e) {
    importRefused({ reason: "Saving failed: " + (e.message || e), hint: "Nothing was changed. Check the connection and try again." });
  }
}

/* ============================================================
   ANALYTICS — the questions no single brief can answer
   ------------------------------------------------------------
   Everything here reads the INDEX docs the Library already has in
   memory. No pack fetches, no second source of truth, no sample
   data ever.

   SMALL-n HONESTY IS THE FEATURE. This board will run for a long
   time on a handful of real pursuits, and it has to look useful and
   truthful at four, because four is what it has. So: every chart
   states its n; a win rate over fewer than three closed pursuits is
   not drawn at all — the bucket says how many it has and that this
   is too few to rate; trends need three distinct months or the
   section shows the raw counts and says why. A confident-looking
   100% built on one win is the single fastest way to make this page
   worthless, because the first person to notice stops believing the
   rest of it.

   Charts are hand-drawn — inline SVG for the trend, CSS bars for
   everything horizontal. No library, no CDN, no build step, same as
   the rest of the site.
   ============================================================ */

const MIN_RATE_N = 3;      /* below this we report the count, never a rate */
const MIN_TREND_MONTHS = 3;

const CLOSED = new Set(["won", "lost", "no-bid"]);
const outcomeOf = (p) => (p.outcome && p.outcome.status) || "pending";
const isClosed = (p) => CLOSED.has(outcomeOf(p));
const money0 = (n) => (Number(n) ? `$${Math.round(Number(n)).toLocaleString()}` : "—");

/* Won / (won + lost). A no-bid is a decision, not a loss: counting it as one
   would punish the board for the thing it is most useful for — helping somebody
   walk away early. It is reported separately and never inside the rate. */
function rate(rows) {
  const won = rows.filter((p) => outcomeOf(p) === "won").length;
  const lost = rows.filter((p) => outcomeOf(p) === "lost").length;
  const n = won + lost;
  return { won, lost, n, value: n ? won / n : null,
    noBid: rows.filter((p) => outcomeOf(p) === "no-bid").length };
}

const BID_BANDS = [
  { id: "u250", label: "Under $250k",  test: (v) => v < 250e3 },
  { id: "m",    label: "$250k – $1M",  test: (v) => v >= 250e3 && v < 1e6 },
  { id: "l",    label: "$1M – $5M",    test: (v) => v >= 1e6 && v < 5e6 },
  { id: "xl",   label: "$5M and up",   test: (v) => v >= 5e6 },
];

function analyticsScreen() {
  const all = LIBRARY;
  if (!all.length) {
    return wrap(`
      <div class="page-head"><div class="eyebrow">Analytics</div>
        <h1 class="h1">Nothing to analyse yet</h1>
        <p class="sub">This page reads every pursuit in the library. Import one and it starts
          answering questions a single brief cannot — what we keep winning, what we keep losing,
          and which competencies the pipeline is actually asking for.</p></div>
      <p><a class="btn btn-primary" href="#/import">Import a pursuit</a></p>`, true);
  }

  const closed = all.filter(isClosed);
  const r = rate(closed);
  const soon = all.filter((p) => { const d = days(p.deadline); return d !== null && d >= 0 && d <= 7; }).length;

  return wrap(`
    <div class="page-head">
      <div class="eyebrow">Analytics</div>
      <h1 class="h1">The portfolio</h1>
      <p class="sub">Every pursuit in the library, together. ${all.length === 1
        ? "One pursuit so far — most of this page needs a few more before it can say anything honest."
        : `${all.length} pursuits, ${closed.length} closed.`}</p>
    </div>

    <div class="kpis">
      ${kpi("Pursuits", all.length, "in the library")}
      ${kpi("Open", all.length - closed.length, soon ? `${soon} due this week` : "none due this week")}
      ${kpi("Closed", closed.length, r.noBid ? `${r.noBid} no-bid` : "")}
      ${r.value === null || r.n < MIN_RATE_N
        ? kpi("Win rate", "—", `${r.n} decided — too few to rate`)
        : kpi("Win rate", `${Math.round(r.value * 100)}%`, `${r.won} of ${r.n} decided`)}
    </div>

    ${sectionTrend(all)}
    ${sectionStatus(all)}
    ${sectionCompetency(all)}
    ${sectionRate("Win rate by industry", byIndustry(all), "No pursuit carries an industry yet. /RFP emits it at ingest from schema v5 on.")}
    ${sectionRate("Win rate by bid size", byBand(all), "No pursuit carries a disclosed bid value. That is often the RFP's doing, not a gap in the pack.")}
    ${sectionReasons(closed)}
    ${sectionClosures(closed)}
  `);
}

const kpi = (label, value, note) => `
  <div class="kpi"><span class="kpi-l">${esc(label)}</span>
    <span class="kpi-v num">${esc(String(value))}</span>
    ${note ? `<span class="kpi-n">${esc(note)}</span>` : ""}</div>`;

const secHead = (title, n) => `
  <div class="an-head"><h2 class="h2">${esc(title)}</h2>${
    n ? `<span class="an-n">${esc(n)}</span>` : ""}</div>`;

/* ---- monthly trend ---- */
function sectionTrend(all) {
  const key = (v) => (v ? String(v).slice(0, 7) : null);
  const months = {};
  for (const p of all) {
    const k = key(p.importedAt);
    if (!k) continue;
    months[k] = months[k] || { in: 0, won: 0, lost: 0 };
    months[k].in++;
  }
  for (const p of all.filter(isClosed)) {
    const k = key(p.outcome && p.outcome.closedAt);
    if (!k) continue;
    months[k] = months[k] || { in: 0, won: 0, lost: 0 };
    if (outcomeOf(p) === "won") months[k].won++;
    if (outcomeOf(p) === "lost") months[k].lost++;
  }
  const keys = Object.keys(months).sort();

  if (keys.length < MIN_TREND_MONTHS) {
    return `<section class="an-sec">${secHead("Over time", `${keys.length} month${keys.length === 1 ? "" : "s"} of data`)}
      <p class="muted">A trend needs at least ${MIN_TREND_MONTHS} distinct months before a line
        through it means anything. So far: ${keys.length
          ? keys.map((k) => `<b>${esc(monthLabel(k))}</b> ${months[k].in} imported`).join(" · ")
          : "nothing dated yet"}.</p></section>`;
  }

  const max = Math.max(...keys.map((k) => months[k].in), 1);
  const W = 720, H = 150, PAD = 26;
  const x = (i) => PAD + (i / (keys.length - 1)) * (W - PAD * 2);
  const y = (v) => H - PAD - (v / max) * (H - PAD * 2);
  const line = keys.map((k, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(months[k].in).toFixed(1)}`).join(" ");

  return `<section class="an-sec">
    ${secHead("Over time", `${keys.length} months · ${all.length} pursuits`)}
    <svg class="an-svg" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Pursuits imported per month: ${esc(keys.map((k) => `${monthLabel(k)} ${months[k].in}`).join(", "))}">
      <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="var(--line)" />
      <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round" />
      ${keys.map((k, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(months[k].in).toFixed(1)}" r="3.5"
        fill="var(--accent)"><title>${esc(monthLabel(k))} — ${months[k].in} imported</title></circle>`).join("")}
      ${keys.map((k, i) => `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle"
        font-size="10" fill="var(--gray-2)">${esc(monthLabel(k, true))}</text>`).join("")}
    </svg>
    <p class="small muted">Pursuits imported per month. Peak ${max} in one month.</p>
  </section>`;
}

function monthLabel(k, short) {
  const [y, m] = k.split("-");
  const name = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m) - 1] || k;
  return short ? name : `${name} ${y}`;
}

/* ---- status split ---- */
function sectionStatus(all) {
  const order = [["pending", "Open"], ["won", "Won"], ["lost", "Lost"], ["no-bid", "No-bid"]];
  const counts = order.map(([k, label]) => ({ k, label, n: all.filter((p) => outcomeOf(p) === k).length }));
  const total = all.length || 1;
  return `<section class="an-sec">
    ${secHead("Where they stand", `${all.length} pursuits`)}
    <div class="an-split" role="img" aria-label="${esc(counts.map((c) => `${c.label} ${c.n}`).join(", "))}">
      ${counts.filter((c) => c.n).map((c) =>
        `<span data-k="${c.k}" style="width:${((c.n / total) * 100).toFixed(2)}%" title="${esc(c.label)} — ${c.n}"></span>`).join("")}
    </div>
    <ul class="an-key">${counts.map((c) =>
      `<li><i data-k="${c.k}"></i>${esc(c.label)} <b class="num">${c.n}</b></li>`).join("")}</ul>
  </section>`;
}

/* ---- competency demand ---- */
function sectionCompetency(all) {
  const withMix = all.filter((p) => Array.isArray(p.mix) && p.mix.length);
  if (!withMix.length) {
    return `<section class="an-sec">${secHead("What the pipeline is asking for")}
      <p class="muted">No pursuit carries a competency split yet. Re-import from a schema v5 pack,
        or add competency hours in Effort &amp; team on any brief, and the demand appears here.</p></section>`;
  }
  /* Mean weight across the pursuits that HAVE a mix — not a sum, and not a mean
     over all pursuits. A sum would say more about how many bids we logged than
     about what they demanded, and dividing by pursuits with no mix at all would
     quietly deflate every area toward zero as the library grows. */
  const tally = {};
  for (const p of withMix) for (const a of p.mix) {
    tally[a.area] = tally[a.area] || { area: a.area, sum: 0, seen: 0 };
    tally[a.area].sum += Number(a.weight) || 0;
    tally[a.area].seen++;
  }
  const rows = Object.values(tally)
    .map((t) => ({ area: t.area, mean: t.sum / withMix.length, seen: t.seen }))
    .sort((a, b) => b.mean - a.mean);
  const max = Math.max(...rows.map((r) => r.mean), 1);

  return `<section class="an-sec">
    ${secHead("What the pipeline is asking for", `${withMix.length} of ${all.length} pursuits carry a split`)}
    <ul class="an-bars">${rows.map((r) => `
      <li><span class="an-bar-l">${esc(r.area)}</span>
        <span class="an-bar"><i style="width:${((r.mean / max) * 100).toFixed(1)}%"></i></span>
        <span class="an-bar-v num">${r.mean.toFixed(0)}%</span>
        <span class="an-bar-n">${r.seen} bid${r.seen === 1 ? "" : "s"}</span></li>`).join("")}</ul>
    <p class="small muted">Average share of delivery effort across the pursuits that carry a split.</p>
  </section>`;
}

/* ---- win rate by bucket ---- */
function byIndustry(all) {
  const g = {};
  for (const p of all) {
    const k = p.industry;
    if (!k) continue;
    (g[k] = g[k] || []).push(p);
  }
  return Object.entries(g).map(([label, rows]) => ({ label, rows, ...rate(rows) }))
    .sort((a, b) => b.n - a.n || b.rows.length - a.rows.length);
}

function byBand(all) {
  return BID_BANDS.map((b) => {
    const rows = all.filter((p) => p.bidValue && b.test(Number(p.bidValue.amount)));
    return { label: b.label, rows, ...rate(rows) };
  }).filter((b) => b.rows.length);
}

/* What the bucket holds beyond its decided pursuits. A no-bid is closed, so
   calling it "still open" — which this did — misreports the one outcome the
   board most wants people to feel free to choose. Count the two separately. */
function remainder(b) {
  const open = b.rows.length - b.n - b.noBid;
  const bits = [];
  if (b.noBid) bits.push(`${b.noBid} no-bid`);
  if (open > 0) bits.push(`${open} still open`);
  return bits.length ? `, ${bits.join(", ")}` : "";
}

function sectionRate(title, buckets, emptyNote) {
  if (!buckets.length) {
    return `<section class="an-sec">${secHead(title)}<p class="muted">${esc(emptyNote)}</p></section>`;
  }
  const rateable = buckets.filter((b) => b.n >= MIN_RATE_N);
  return `<section class="an-sec">
    ${secHead(title, `${buckets.length} bucket${buckets.length === 1 ? "" : "s"}`)}
    <ul class="an-bars">${buckets.map((b) => `
      <li><span class="an-bar-l">${esc(b.label)}</span>
        ${b.n >= MIN_RATE_N
          ? `<span class="an-bar"><i style="width:${(b.value * 100).toFixed(1)}%"></i></span>
             <span class="an-bar-v num">${Math.round(b.value * 100)}%</span>
             <span class="an-bar-n">${b.won} of ${b.n} decided${remainder(b)}</span>`
          : `<span class="an-bar is-thin"></span>
             <span class="an-bar-v num">—</span>
             <span class="an-bar-n">${b.n} decided — too few to rate${remainder(b)}</span>`}
      </li>`).join("")}</ul>
    ${rateable.length
      ? `<p class="small muted">Won divided by won plus lost. No-bids are a decision, not a loss,
          and are counted separately.</p>`
      : `<p class="small muted">Nothing here has ${MIN_RATE_N} decided pursuits yet, so no rate is drawn.
          The counts are real; the percentages would not be.</p>`}
  </section>`;
}

/* ---- why we win, why we lose ---- */
function sectionReasons(closed) {
  const pick = (st) => closed.filter((p) => outcomeOf(p) === st && (p.outcome.reason || "").trim());
  const won = pick("won"), lost = pick("lost");
  if (!won.length && !lost.length) {
    return `<section class="an-sec">${secHead("Why we win, why we lose")}
      <p class="muted">No closed pursuit records a reason yet. Set the outcome and its reason on a
        brief when a bid closes — this is the section that pays that back.</p></section>`;
  }
  const col = (title, rows) => `
    <div class="an-col"><h3 class="h3">${esc(title)}</h3>
      ${rows.length
        ? `<ul class="an-reasons">${rows.map((p) => `
            <li><a href="#/b/${esc(p.briefId)}">${esc(p.client)}</a>
              <span>${esc(p.outcome.reason)}</span></li>`).join("")}</ul>`
        : `<p class="muted small">Nothing recorded.</p>`}</div>`;
  return `<section class="an-sec">
    ${secHead("Why we win, why we lose", `${won.length + lost.length} with a reason`)}
    <div class="an-cols">${col("Won", won)}${col("Lost", lost)}</div>
  </section>`;
}

/* ---- recent closures ---- */
function sectionClosures(closed) {
  if (!closed.length) {
    return `<section class="an-sec">${secHead("Recently closed")}
      <p class="muted">Nothing has closed yet.</p></section>`;
  }
  const rows = closed.slice()
    .sort((a, b) => String(b.outcome.closedAt || "").localeCompare(String(a.outcome.closedAt || "")))
    .slice(0, 10);
  return `<section class="an-sec">
    ${secHead("Recently closed", `${closed.length} total`)}
    <ul class="an-closures">
      <li class="an-closure an-closure-h" aria-hidden="true">
        <span>Client</span><span>Outcome</span><span>Value</span><span>Closed</span></li>
      ${rows.map((p) => `
        <li class="an-closure">
          <span><a href="#/b/${esc(p.briefId)}">${esc(p.client)}</a></span>
          <span><b class="an-out" data-k="${esc(outcomeOf(p))}">${esc(outcomeOf(p))}</b></span>
          <span class="num">${p.bidValue ? esc(money0(p.bidValue.amount)) : "—"}</span>
          <span class="num">${p.outcome.closedAt ? esc(fmtDate(p.outcome.closedAt)) : "—"}</span>
        </li>`).join("")}
    </ul>
  </section>`;
}

async function screenAnalytics() {
  paintConnection();
  screen.innerHTML = wrap(`<p class="sub">Loading…</p>`);
  LIBRARY = await listPursuits();
  screen.innerHTML = analyticsScreen();
}

/* ============================================================
   BRIEF
   ============================================================ */
async function screenBrief(briefId, section) {
  paintConnection();
  screen.innerHTML = wrap(`<p class="sub">Loading…</p>`);
  const idx = await getPursuit(briefId);
  if (!idx) {
    $("#hubHead").hidden = false; $("#briefBar").hidden = true;
    return (screen.innerHTML = wrap(`
      <div class="page-head"><div><h1 class="h1">Not found</h1>
        <p class="sub">No opportunity called <code>${esc(briefId)}</code> is in this library.</p></div></div>
      <p><a class="btn" href="#/">Back to the library</a>
         <a class="btn" href="#/import">Import it</a></p>`, true));
  }
  $("#briefClient").textContent = idx.client;

  const pack = await getPack(briefId);
  if (!pack) return (screen.innerHTML = wrap(`
    <div class="notice bad">This opportunity is in the library but its content isn't cached on this
    device and the site can't reach shared storage right now.</div>`, true));

  // Pre-resolve hosted asset URLs so the renderer stays synchronous.
  const urls = await resolveAssetUrls(idx, pack);
  /* What the site is carrying for this pursuit. Recorded on the index doc at
     import, so knowing whether a file is available costs no extra read. */
  const carried = new Set(idx.filesCarried || []);

  screen.innerHTML = `<div id="brief"></div>`;
  BRIEF = { briefId, idx, pack, base: await getPackBase(briefId), api: null, editing: false, unsub: null, pendingRemote: null };

  const opts = {
    /* Always open on TLDR. This used to restore the last section you were in,
       which sounded considerate and was not: you would open a pursuit and land
       mid-way inside Understand with no idea why, and the one screen written to
       orient you was the one screen you never saw. A deep link still wins —
       #/b/<id>/questions opens Questions — but a bare #/b/<id> is a request to
       read the brief, and reading it starts at the top. */
    section: section || "snapshot",
    headerHeight: 60,
    /* Who is reading. Only used to offer the "Mine" filter chip — with no name
       the chip is not offered rather than shown broken. Read without prompting:
       asking for a name just to view a list would be the wrong trade. */
    me: localStorage.getItem("hub.editor") || "",
    onNavigate: (id) => {
      history.replaceState(null, "", `#/b/${briefId}/${id}`);
    },
    onDerive: (m) => {
      /* The Library card reads these. Persisting them here means the counts are
         refreshed by the act of someone opening the brief — self-healing for
         pursuits imported before the card learned to show them. */
      const patch = { readiness: m.readiness, counts: m.counts, responseLift: m.responseLift || null };
      const changed = m.readiness !== BRIEF.idx.readiness
        || JSON.stringify(m.counts) !== JSON.stringify(BRIEF.idx.counts)
        || JSON.stringify(patch.responseLift) !== JSON.stringify(BRIEF.idx.responseLift);
      if (changed) {
        BRIEF.idx = { ...BRIEF.idx, ...patch };
        updateIndex(briefId, patch).catch(() => {});
      }
    },
    onEdit: applyEdit,
    resolveDoc: (doc, page) => {
      if (!doc || doc.unreadable || !doc.href) return null;
      const u = urls[doc.href];
      if (u) return u + (page && String(doc.type).toLowerCase() === "pdf" ? `#page=${page}` : "");
      return carried.has(doc.href) ? FETCH_PREFIX + encodeURIComponent(doc.href) : null;
    },
  };
  BRIEF.opts = opts;
  BRIEF.api = renderBrief(pack, $("#brief"), opts);

  bindBriefBar(briefId, idx, pack, BRIEF.api);
  refreshActivityCount();

  /* Fetch-on-click for a document the site carries but this browser has not
     seen. Capture phase, because the renderer's own [data-doc] handling sits on
     the same click and this has to win: the href is a sentinel, and letting it
     through would put "#fetch/..." in the address bar. */
  $("#brief").addEventListener("click", async (e) => {
    const a = e.target.closest(`a[href^="${FETCH_PREFIX}"]`);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    const href = decodeURIComponent(a.getAttribute("href").slice(FETCH_PREFIX.length));
    const doc = (pack.documents || []).find((x) => x.href === href);
    const label = a.textContent;
    a.textContent = "fetching…";
    a.setAttribute("aria-busy", "true");
    const url = await fetchDocument(briefId, href, urls, doc || {});
    a.removeAttribute("aria-busy");
    a.textContent = label;
    if (!url) { alert("That file is not on the board.\n\nIt was either too large to attach at import, or the import did not finish. Re-import the bundle to attach it."); return; }
    // Re-render so every link to this document becomes a real one, then hand
    // the file over. A download rather than a new tab: the click that would
    // have opened the tab is several awaits behind us and popup blockers count
    // that as unsolicited.
    if (BRIEF && BRIEF.briefId === briefId) BRIEF.api = BRIEF.api.update(BRIEF.pack, BRIEF.editing ? "edit" : "read");
    const t = document.createElement("a");
    t.href = url;
    t.download = (doc && doc.file) || href.split("/").pop();
    document.body.appendChild(t); t.click(); t.remove();
  }, true);

  /* LIVE SYNC. Until this existed, another person's edit reached Firestore and
     sat there: this page had already finished reading, so the brief only caught
     up on reload. The activity feed looked live purely because opening the panel
     re-fetched it. */
  BRIEF.unsub?.();
  BRIEF.unsub = subscribeBrief(briefId, {
    onElements: (list) => applyRemoteElements(briefId, list),
    onActivity: () => refreshActivityCount(),
    onIndex: (row) => { if (BRIEF && BRIEF.briefId === briefId) BRIEF.idx = row; },
  });

  /* The review layer. Independent of edit mode on purpose — commenting is what
     people who are not editing do, and making it a mode would hide it from
     exactly those people. */
  await mountComments({
    briefId,
    mount: $("#brief"),
    gotoSection: (id) => BRIEF.api?.goto?.(id),
  });
}

/* ============================================================
   EDIT MODE
   Every change becomes an override document, never a write into the
   imported pack. That is what keeps re-import non-destructive, gives the
   activity log something real to show, and makes a checkpoint restore a
   matter of swapping one small list.
   ============================================================ */

let BRIEF = null;

const editorName = () => {
  let n = localStorage.getItem("hub.editor");
  if (!n) {
    n = (prompt("Your name — so the team can see who changed what:") || "").trim();
    if (!n) return null;
    localStorage.setItem("hub.editor", n);
  }
  return n;
};

/* Continue the pack's own numbering rather than minting a timestamp. "Q-750AX"
   is unreadable, does not sort, wraps the id column, and reads as machine
   output sitting next to Q-1. Pad to whatever width the pack already uses, so
   a pack numbering A-01 keeps getting A-06 and not A-6. */
function nextId(pack, coll, prefix) {
  const ids = (pack?.[coll] || []).map((x) => String(x.id || ""));
  const mine = ids.map((id) => new RegExp(`^${prefix}-(\\d+)$`).exec(id)).filter(Boolean);
  const width = Math.max(1, ...mine.map((m) => m[1].length));
  const max = Math.max(0, ...mine.map((m) => Number(m[1])));

  // A pack numbering its rows some other way (R-014a, REQ-3) must not have a
  // collision invented for it — fall back to a suffix that cannot clash.
  if (!mine.length && ids.length) return `${prefix}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
  let n = max + 1;
  const taken = new Set(ids);
  while (taken.has(`${prefix}-${String(n).padStart(width, "0")}`)) n++;
  return `${prefix}-${String(n).padStart(width, "0")}`;
}

const NEW_ITEM = {
  actionItems: (p) => ({ id: nextId(p, "actionItems", "A"), task: "New item", owner: null, status: "open", due: "" }),
  questions:   (p) => ({ id: nextId(p, "questions", "Q"), topic: "General", text: "New question" }),
  risks:       (p) => ({ id: nextId(p, "risks", "K"), severity: "med", title: "New risk", detail: "", mitigation: "" }),
  rules:       (p) => ({ id: nextId(p, "rules", "C"), label: "New rule", checked: false, mandatory: false }),
  requirements:(p) => ({ id: nextId(p, "requirements", "R"), text: "New requirement", theme: "Ungrouped", owner: null, status: "open" }),
  decisions:   (p) => ({ id: nextId(p, "decisions", "D"), text: "New decision", by: "", at: new Date().toISOString().slice(0, 10) }),
  parkingLot:  (p) => ({ id: nextId(p, "parkingLot", "P"), text: "New parked item" }),
  /* Keyed by name rather than id, because that is what the pack carries and
     inventing ids for these on import would break /DRAFT's read of the same
     collections. applyOverrides removes by whichever field the delete button
     names, so no id is needed. */
  roster:      () => ({ name: "New person", role: "" }),
  meetings:    (p) => ({ id: nextId(p, "meetings", "M"), type: "call", date: new Date().toISOString().slice(0, 10), attendees: [] }),
  /* Nested collections. The competency name doubles as its key, so a new row
     needs a name nobody else has — "New competency" twice would make both rows
     un-editable, since a name selector would match the first every time. */
  "team.competencies": (p) => ({
    name: `New competency ${((p.team && p.team.competencies) || []).length + 1}`,
    hours: 0, hoursAi: 0, requirementIds: [],
  }),
  "team.keyPersonnel": () => "New mandate",
  /* A role carries `rate` as an object because the edit paths write into
     rate.pay / rate.bill, and setByPath will not create the intermediate. */
  "team.plan": (p) => ({
    id: nextId({ plan: ((p.team && p.team.plan) || []) }, "plan", "T"),
    role: "New role", competency: "", level: "mid", geo: "us", mode: "remote",
    count: 1, hours: 0, hoursAi: 0, rate: { pay: 0, bill: 0, basis: "" },
  }),
  /* Area doubles as the key, so a new row needs a name nothing else has. */
  "competencyMix.areas": (p) => ({
    area: `New area ${((p.competencyMix && p.competencyMix.areas) || []).length + 1}`,
    weight: 0, basis: "", requirementIds: [], lead: "",
  }),
  "signals.red":   () => ({ basis: "New signal", source: "" }),
  "signals.green": () => ({ basis: "New signal", source: "" }),
  "signals.soft":  () => ({ basis: "New signal", source: "" }),
  "clientContext.contacts": (p) => ({
    name: `New contact ${((p.clientContext && p.clientContext.contacts) || []).length + 1}`, role: "",
  }),
  "scorecard.criteria":        (p) => ({ name: `New criterion ${arr2(p, "scorecard", "criteria").length + 1}`, weight: 0 }),
  "evaluation.criteria":       (p) => ({ name: `New criterion ${arr2(p, "evaluation", "criteria").length + 1}`, weight: 0 }),
  "scorecard.successCriteria":  () => "New success criterion",
  "evaluation.successCriteria": () => "New success criterion",
};

/* NEW_ITEM sometimes needs to count a nested collection to name the next row. */
const arr2 = (p, a, b) => ((p && p[a] && p[a][b]) || []);

/* Re-render in the mode the reader is ACTUALLY in. This used to hard-code
   "edit", which was harmless while every edit came from an edit-mode control —
   and wrong the moment a read-mode checkbox could write, because ticking one box
   flipped the whole brief into edit mode underneath the person. */
async function applyEdit(change) {
  // A canceled "New topic…" prompt: nothing to record, but the select is
  // showing __new and has to be put back.
  if (change.kind === "noop") {
    if (change.rerender !== false && BRIEF) BRIEF.api = BRIEF.api.update(BRIEF.pack, BRIEF.editing ? "edit" : "read");
    return;
  }
  const who = editorName();
  if (!who) return;
  const { briefId } = BRIEF;
  const at = new Date().toISOString();

  /* Renaming a section touches every question filed under it plus the declared
     section list. That is N+1 overrides but exactly one thing happened, so it
     writes one activity row — an audit trail that logs nine lines for one
     rename is an audit trail nobody reads. */
  if (change.kind === "rename-topic") {
    const { from, to } = change;
    const affected = (BRIEF.pack.questions || []).filter((q) => (q.topic || "General") === from);
    for (const q of affected) {
      await setElement(briefId, `questions-${q.id}.topic`, {
        id: `questions-${q.id}.topic`, kind: "set",
        path: `questions[id=${q.id}].topic`, value: to, editor: who, at,
      });
    }
    const declared = BRIEF.pack.questionTopics || [];
    if (declared.includes(from)) {
      await setElement(briefId, "questionTopics", {
        id: "questionTopics", kind: "set", path: "questionTopics",
        value: declared.map((t) => (t === from ? to : t)), editor: who, at,
      });
    }
    await appendActivity(briefId, {
      kind: "human", editor: who, elementId: `question-${affected[0]?.id || ""}`,
      section: "questions", field: "section name",
      before: from, after: `${to} · ${affected.length} question${affected.length === 1 ? "" : "s"} moved`,
    });
    BRIEF.pack = await getPack(briefId);
    BRIEF.api = BRIEF.api.update(BRIEF.pack, BRIEF.editing ? "edit" : "read");
    refreshActivityCount();
    flashSaved();
    return;
  }

  let entry;
  if (change.kind === "add") {
    const value = (NEW_ITEM[change.coll] || (() => ({ id: nextId(BRIEF.pack, change.coll, "X") })))(BRIEF.pack);
    /* The override id has to be unique per added row. `value.id` is undefined for
       the collections keyed by name and for plain-string rows, so a second add
       would overwrite the first and the row would never appear. */
    const tag = (value && (value.id || value.name)) || `${Date.now().toString(36)}`;
    entry = { id: `add-${change.coll}-${tag}`, kind: "add", collection: change.coll, value, editor: who, at };
  } else if (change.kind === "remove") {
    /* Deleting a row that an override added: drop the "add" instead of layering
       a "remove" on top of it. Both would exist, and applyOverrides orders by
       timestamp — which for a row added and deleted in the same session is the
       same millisecond, so the row would reappear on a coin flip. */
    const addId = `add-${change.coll}-${change.itemId}`;
    const overrides = await getElements(briefId);
    if (overrides.some((o) => o.id === addId)) {
      await deleteElement(briefId, addId);
      // Any field edits made to that row are now pointing at nothing.
      for (const o of overrides) {
        if (o.kind === "set" && String(o.path || "").startsWith(`${change.coll}[id=${change.itemId}]`)) {
          await deleteElement(briefId, o.id);
        }
      }
      await appendActivity(briefId, {
        kind: "human", editor: who, elementId: change.elementId,
        section: change.coll, field: "deleted", before: change.itemId, after: "(deleted)",
      });
      BRIEF.pack = await getPack(briefId);
      BRIEF.api = BRIEF.api.update(BRIEF.pack, BRIEF.editing ? "edit" : "read");
      refreshActivityCount();
      flashSaved();
      return;
    }
    entry = { id: `remove-${change.coll}-${change.itemId}`, kind: "remove", collection: change.coll,
              itemId: change.itemId, itemKey: change.itemKey || "id", editor: who, at };
  } else {
    entry = { id: change.elementId, kind: "set", path: change.path, value: change.value, editor: who, at };
  }

  await setElement(briefId, entry.id, entry);

  /* Provenance follows the edit. The mix line on Summary states where the split
     came from, and the moment a person overrules a weight it is no longer a
     derivation — leaving it labeled "read from the requirement split" would be
     the brief attributing a human's number to /RFP. Written as its own override
     so it survives a re-import the same way the weight does, and skipped when
     it already says human, to keep the audit trail one row per real change. */
  if (/^competencyMix\.areas/.test(String(change.coll || change.path || ""))
      && BRIEF.pack?.competencyMix?.source !== "human") {
    await setElement(briefId, "competencyMix.source", {
      id: "competencyMix.source", kind: "set", path: "competencyMix.source",
      value: "human", editor: who, at,
    });
  }

  await appendActivity(briefId, {
    kind: "human", editor: who, elementId: change.elementId || entry.id,
    section: (change.coll || String(change.path || "").split(/[.[]/)[0] || ""),
    field: change.label || change.path, before: change.before ?? null,
    after: change.kind === "remove" ? "(deleted)" : (change.value ?? "(new)"),
  });

  // rebuild the merged pack from baseline + overrides so derived numbers are honest
  BRIEF.pack = await getPack(briefId);
  if (change.rerender !== false) {
    BRIEF.api = BRIEF.api.update(BRIEF.pack, BRIEF.editing ? "edit" : "read");
    refreshComments();
  }
  refreshActivityCount();
  flashSaved();
}

function flashSaved() {
  const el = $("#saveState");
  if (!el) return;
  el.textContent = "Saved";
  el.dataset.on = "1";
  clearTimeout(flashSaved._t);
  flashSaved._t = setTimeout(() => { el.dataset.on = ""; }, 1400);
}

/* The badge counts what YOU have not seen, not everything that ever happened.
   A total is useless the moment a brief has been worked on for a week — 475
   tells you nothing and stops being read. Read state is per person, so it
   lives in localStorage rather than being written back to the shared log. */
const seenKey = (briefId) => `hub.actSeen.${briefId}`;
const lastSeen = (briefId) => localStorage.getItem(seenKey(briefId)) || "";

/* ---------------- remote edits ----------------
   A remote change re-merges the overrides onto the baseline and re-renders.

   The guard is the whole difficulty. A re-render replaces DOM, and if the person
   is mid-sentence in a contenteditable field their caret, selection and unsaved
   keystrokes go with it — a sync feature that eats your typing is worse than no
   sync at all. So while focus is inside an editable element the incoming state
   is parked, and applied on the next focusout. Last write still wins; it just
   waits for a safe moment to land. */
function isEditingNow() {
  const a = document.activeElement;
  const host = $("#brief");
  if (!a || !host || !host.contains(a)) return false;
  return a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
}

function applyRemoteElements(briefId, list) {
  if (!BRIEF || BRIEF.briefId !== briefId || !BRIEF.base) return;

  if (isEditingNow()) {
    BRIEF.pendingRemote = list;
    if (!BRIEF.flushBound) {
      BRIEF.flushBound = true;
      // capture phase: focusout does not bubble reliably from removed nodes
      document.addEventListener("focusout", () => {
        if (!BRIEF || !BRIEF.pendingRemote) return;
        const next = BRIEF.pendingRemote;
        BRIEF.pendingRemote = null;
        // one tick, so focus has actually settled before we replace DOM
        setTimeout(() => applyRemoteElements(BRIEF?.briefId, next), 0);
      }, true);
    }
    return;
  }

  const merged = applyOverrides(BRIEF.base, list);
  if (JSON.stringify(merged) === JSON.stringify(BRIEF.pack)) return;   // nothing user-visible changed
  BRIEF.pack = merged;
  BRIEF.api = BRIEF.api.update(BRIEF.pack, BRIEF.editing ? "edit" : "read");
}

async function refreshActivityCount() {
  const el = $("#actCount");
  if (!el || !BRIEF) return;
  const since = lastSeen(BRIEF.briefId);
  const rows = await listActivity(BRIEF.briefId);
  const n = since ? rows.filter((a) => String(a.at) > since).length : rows.length;
  el.textContent = n > 99 ? "99+" : String(n);
  el.hidden = !n;
  el.title = n ? `${n} change${n === 1 ? "" : "s"} since you last cleared this` : "";
}

/* Clear marks everything to date as seen. It does not delete anything — an
   audit trail you can empty is not an audit trail. */
async function clearActivityBadge() {
  if (!BRIEF) return;
  localStorage.setItem(seenKey(BRIEF.briefId), new Date().toISOString());
  await refreshActivityCount();
  const body = $("#actBody");
  if (body) body.querySelectorAll(".act-row.is-new").forEach((r) => r.classList.remove("is-new"));
  const btn = $("#actClear");
  if (btn) { btn.textContent = "Cleared"; setTimeout(() => { btn.textContent = "Clear"; }, 1400); }
}

async function toggleEdit() {
  if (!BRIEF) return;
  if (!BRIEF.editing && !editorName()) return;
  BRIEF.editing = !BRIEF.editing;
  track(BRIEF.editing ? "edit_open" : "edit_close");

  // snapshot at the start of every editing session, per the spec
  if (BRIEF.editing) {
    await saveCheckpoint(BRIEF.briefId, { label: "Session start", editor: localStorage.getItem("hub.editor") });
  }
  BRIEF.opts.mode = BRIEF.editing ? "edit" : "read";
  BRIEF.api = BRIEF.api.update(BRIEF.pack, BRIEF.opts.mode);
  paintEditBar();
}

function paintEditBar() {
  const btn = $("#btnEdit");
  if (!btn || !BRIEF) return;
  btn.textContent = BRIEF.editing ? "Done" : "Edit";
  btn.classList.toggle("btn-primary", BRIEF.editing);
  $("#editState").hidden = !BRIEF.editing;
  document.body.dataset.editing = BRIEF.editing ? "1" : "";
}

/* ---------- activity panel ----------
   Every entry links back to what it changed: click navigates to the section,
   scrolls the element into view and flashes it. An audit trail you can't follow
   to the thing it describes is just a list. */
async function openActivity() {
  const panel = $("#actPanel"), body = $("#actBody");
  panel.hidden = false;
  body.innerHTML = `<p class="small muted">Loading…</p>`;
  const rows = await listActivity(BRIEF.briefId);
  const imported = (BRIEF.pack.activityLog || []).map((a) => ({
    at: a.at || a.timestamp, editor: a.editor, section: a.section,
    field: a.field || a.elementId, elementId: a.elementId, kind: "import",
  }));
  const all = [...rows, ...imported].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const since = lastSeen(BRIEF.briefId);

  body.innerHTML = all.length ? all.map((a) => `
    <button class="act-row${since && String(a.at) > since ? " is-new" : ""}" ${a.elementId ? `data-jump="${esc(a.elementId)}"` : ""}>
      <span class="act-kind" data-k="${esc(a.kind || "human")}"></span>
      <span class="act-main">
        <span class="act-what">${esc(a.field || a.section || "changed")}</span>
        ${a.after != null ? `<span class="act-val">${esc(String(a.after).slice(0, 60))}</span>` : ""}
        <span class="act-who">${esc(a.editor || "—")} · ${esc(ago(a.at))}</span>
      </span>
    </button>`).join("")
    : `<p class="small muted">Nothing recorded yet. Edits, checkpoints and imports all land here.</p>`;

  body.onclick = (e) => {
    const r = e.target.closest("[data-jump]");
    if (!r || !BRIEF.api) return;
    // element ids look like "actionItems-A-02.owner" or "requirements[id=R-1].text"
    const raw = r.dataset.jump;
    const m = /^(\w+)[-[](?:id=)?([A-Za-z0-9._-]+)/.exec(raw);
    if (!m) return;
    const map = { actionItems: ["checklist", "action"], requirements: ["requirements", "req"],
                  questions: ["questions", "question"], rules: ["rules", "rule"], risks: ["risks", "risk"] };
    const [section, prefix] = map[m[1]] || [];
    if (section) BRIEF.api.goto(section, `${prefix}-${m[2].replace(/\].*$/, "")}`);
  };
}

/* ---------- checkpoints ---------- */
async function openRestore(briefId) {
  const cps = await listCheckpoints(briefId);
  modal(`
    <h2 class="h1" style="font-size:20px">Restore a checkpoint</h2>
    <p class="sub" style="margin-top:8px">Restoring swaps the current set of edits for a saved one.
      The imported pack never changes, and restoring is itself logged — nothing is lost.</p>
    <div class="cp-list">
      ${cps.map((c) => `
        <button class="cp-row" data-cp="${esc(c.id)}">
          <span><b>${esc(c.label)}</b><br><span class="small muted">${esc(c.editor || "—")} · ${esc(ago(c.at))} · ${c.count} change${c.count === 1 ? "" : "s"}</span></span>
          <span class="btn btn-sm">Restore</span>
        </button>`).join("")}
      <button class="cp-row" data-cp="__original__">
        <span><b>The original import</b><br><span class="small muted">discard every edit made since import</span></span>
        <span class="btn btn-sm danger">Restore</span>
      </button>
    </div>`);
  $("#modalBody").onclick = async (e) => {
    const row = e.target.closest("[data-cp]");
    if (!row) return;
    const who = editorName(); if (!who) return;
    const id = row.dataset.cp;
    const cp = cps.find((c) => c.id === id);
    if (id !== "__original__" && !cp) return;
    if (!confirm(id === "__original__"
      ? "Discard every edit and return to the imported pack?"
      : `Restore "${cp.label}"? Current edits are replaced (and stay in the activity log).`)) return;

    await replaceElements(briefId, id === "__original__" ? [] : cp.overrides);
    await appendActivity(briefId, { kind: "restore", editor: who, section: "—",
      field: id === "__original__" ? "restored the original import" : `restored "${cp.label}"`,
      after: `${id === "__original__" ? 0 : cp.count} changes` });
    BRIEF.pack = await getPack(briefId);
    BRIEF.api = BRIEF.api.update(BRIEF.pack, BRIEF.opts.mode);
    refreshActivityCount();
    $("#modal").hidden = true;
  };
}

/* Resolve only documents that actually traveled with the bundle. Anything else
   returns nothing and the renderer prints the row as plain text — a link that
   404s is worse than no link. */
/* Documents live in the importing browser only — there is no Cloud Storage in
   this build. The Storage lookup that used to sit here referenced an SDK that
   is no longer loaded, so it threw on every call and fell through to the cache
   by accident. Now it just reads the cache, and says so when it comes up empty. */
/* Only what is already on this machine. Resolving remotely here would mean
   downloading every attached PDF before the brief paints, which on a pursuit
   with a 30 MB document set is a blank screen for half a minute. The rest
   resolve on click, once, and are cached from then on. */
async function resolveAssetUrls(idx, pack) {
  const out = {};
  for (const doc of pack.documents || []) {
    if (!doc.href || doc.unreadable) continue;
    const bytes = await getAssetBytesLocal(idx.briefId, doc.href);
    if (bytes) out[doc.href] = URL.createObjectURL(new Blob([bytes], { type: mimeFor(doc) }));
  }
  return out;
}

/* A document the site is carrying but this browser has not fetched yet. The
   href is a sentinel rather than a real URL: the bytes do not exist locally, so
   there is nothing to point at until somebody asks. */
const FETCH_PREFIX = "#fetch/";

async function fetchDocument(briefId, href, urls, doc) {
  if (urls[href]) return urls[href];
  const bytes = await getAssetBytes(briefId, href);
  if (!bytes) return null;
  urls[href] = URL.createObjectURL(new Blob([bytes], { type: mimeFor(doc) }));
  return urls[href];
}

/* Without a type, a Blob URL downloads as an unnamed binary and a PDF will not
   open in the browser's viewer. */
const MIME = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  svg: "image/svg+xml", txt: "text/plain", csv: "text/csv", html: "text/html",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const mimeFor = (doc) => MIME[String(doc.type || (doc.file || "").split(".").pop() || "").toLowerCase()]
  || "application/octet-stream";

function bindBriefBar(briefId, idx, pack, api) {
  const more = $("#morePop");
  $("#btnMore").onclick = (e) => {
    e.stopPropagation();
    more.hidden = !more.hidden;
    $("#btnMore").setAttribute("aria-expanded", String(!more.hidden));
  };

  $("#btnExport").onclick = () => {
    // export the MERGED state, not the imported baseline — otherwise /draft-microsite
    // builds a deck from content the team has already moved past
    const out = { ...BRIEF.pack, exportedAt: new Date().toISOString(), rendererVersion: RENDERER_VERSION };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
    a.download = `${briefId}-content-pack.json`;
    a.click();
  };

  $("#btnEdit").onclick = toggleEdit;
  paintEditBar();

  $("#btnActivity").onclick = () => openActivity();
  $("#actClose").onclick = () => { $("#actPanel").hidden = true; };
  $("#actClear").onclick = clearActivityBadge;

  more.onclick = async (e) => {
    const what = e.target.dataset.more;
    if (!what) return;
    more.hidden = true;
    if (what === "reimport") location.hash = "#/import";
    if (what === "version") modal(`
      <h2 class="h1" style="font-size:20px">Versions</h2>
      <dl class="kv">
        <dt>Renderer</dt><dd>${RENDERER_VERSION} (this site)</dd>
        <dt>Renderer at import</dt><dd>${esc(idx.rendererVersionAtImport || "—")}</dd>
        <dt>Pack schema</dt><dd>v${esc(idx.schemaVersion)}${idx.migratedFrom ? ` (migrated from v${idx.migratedFrom})` : ""}</dd>
        <dt>Site reads</dt><dd>v${MIN_SCHEMA}–v${CURRENT_SCHEMA}</dd>
        <dt>Hub</dt><dd>${esc(CONFIG.hubVersion)}</dd>
      </dl>
      <p class="small muted" style="margin-top:14px">A redeploy of this site updates the renderer for
      every opportunity at once — packs are data, so nothing needs re-importing.</p>`);
    /* Bulk cleanup for rows that were added and never filled in. Deliberately
       narrow: only rows an override created, still carrying the exact default
       text, with no field edits of their own. Anything a person typed into is
       left alone — a cleanup that removes real work is worse than the mess. */
    if (what === "tidy") {
      const who = editorName(); if (!who) return;
      const DEFAULTS = {
        actionItems: ["task", "New item"], questions: ["text", "New question"],
        risks: ["title", "New risk"], rules: ["label", "New rule"],
      };
      const overrides = await getElements(briefId);
      const edited = new Set();
      for (const o of overrides) {
        const m = /^([a-zA-Z]+)\[id=([^\]]+)\]/.exec(o.path || "");
        if (o.kind === "set" && m) edited.add(`${m[1]}|${m[2]}`);
      }
      const junk = overrides.filter((o) => {
        if (o.kind !== "add") return false;
        const spec = DEFAULTS[o.collection];
        if (!spec) return false;
        const [field, def] = spec;
        if (String(o.value?.[field] ?? "").trim() !== def) return false;
        return !edited.has(`${o.collection}|${o.value.id}`);
      });

      if (!junk.length) {
        modal(`<h2 class="h1" style="font-size:20px">Nothing to remove</h2>
          <p class="sub" style="margin-top:8px">Every added row has either been edited or is not a
          blank default. Imported content is never touched by this.</p>`);
        return;
      }
      const byColl = junk.reduce((a, o) => (a[o.collection] = (a[o.collection] || 0) + 1, a), {});
      const summary = Object.entries(byColl).map(([c, n]) => `${n} in ${c}`).join(", ");
      if (!confirm(`Remove ${junk.length} untouched blank row${junk.length === 1 ? "" : "s"}?\n\n${summary}\n\nOnly rows still showing their default text are removed. Nothing imported, and nothing anyone has typed into, is affected.`)) return;

      for (const o of junk) await deleteElement(briefId, o.id);
      await appendActivity(briefId, {
        kind: "human", editor: who, section: "cleanup", field: "removed blank rows",
        before: null, after: `${junk.length} removed (${summary})`,
      });
      BRIEF.pack = await getPack(briefId);
      BRIEF.api = BRIEF.api.update(BRIEF.pack, BRIEF.editing ? "edit" : "read");
      refreshActivityCount();
      modal(`<h2 class="h1" style="font-size:20px">Removed ${junk.length} blank row${junk.length === 1 ? "" : "s"}</h2>
        <p class="sub" style="margin-top:8px">${esc(summary)}. This is itself logged, and a checkpoint
        saved before now still contains them.</p>`);
      return;
    }

    if (what === "checkpoint") {
      const who = editorName(); if (!who) return;
      const note = prompt("Name this checkpoint (optional):") || "";
      const cp = await saveCheckpoint(briefId, { label: note || "Manual checkpoint", editor: who, note });
      track("checkpoint_save", { changes: cp.count });
      await appendActivity(briefId, { kind: "checkpoint", editor: who, section: "—", field: cp.label, after: `${cp.count} changes` });
      refreshActivityCount();
      modal(`<h2 class="h1" style="font-size:20px">Checkpoint saved</h2>
        <p class="sub" style="margin-top:8px">${esc(cp.label)} — ${cp.count} change${cp.count === 1 ? "" : "s"} captured.
        Restore it any time from the ⋯ menu.</p>`);
    }
    if (what === "restore") openRestore(briefId);
    if (what === "delete") {
      const ok = prompt(`Type the opportunity id to delete it permanently:\n${briefId}`);
      if (ok !== briefId) return;
      await deletePursuit(briefId);
      LIBRARY = await listPursuits();
      location.hash = "#/";
    }
  };
}

/* ============================================================
   SKILLS + HELP
   ============================================================ */
const SKILL_GROUPS = [
  { id: "start-here", label: "Start here",
    note: "The only skill most people need. It reads the RFP and gives you the file you import." },
  { id: "deck", label: "The client deck",
    note: "Only if you're bidding. Run in this order — each one hands off to the next." },
  { id: "owner", label: "Site owner",
    note: "Infrastructure. Run once, or when the template improves — never per pursuit." },
  { id: "other", label: "Other", note: "" },
];

async function screenSkills() {
  let list = [];
  try { list = await (await fetch("skills/index.json", { cache: "no-store" })).json(); } catch {}
  list.sort((a, b) => (a.order || 99) - (b.order || 99));
  const live = list.filter((s) => s.published);

  const unlocked = sessionStorage.getItem("hub.ownerUnlocked") === "1";

  // Every skill gets identical treatment. There is no "featured" one — the
  // group a skill sits in already says who runs it, and a second signal on top
  // of that just makes the others look like afterthoughts.
  const row = (s) => {
    const gated = s.locked && !unlocked;
    return `
    <div class="skillrow ${s.published ? "" : "is-unpublished"} ${gated ? "is-gated" : ""}">
      ${s.thumb
        ? `<img class="skill-thumb" src="${esc(s.thumb)}" alt="" width="200" height="128">`
        : `<span class="skill-thumb is-empty"></span>`}
      <div class="grow">
        <div class="skill-name">${esc(s.slash || "/" + s.name)}</div>
        <p class="skill-blurb">${esc(s.blurb || "")}</p>
        <p class="skill-meta">${s.published
          ? `v${esc(s.version)}${s.sha ? ` · ${esc(s.sha)}` : ""}${
              s.bytes ? ` · ${Math.round(s.bytes / 1024)} KB` : ""}`
          : "not published to this site yet"}</p>
      </div>
      ${!s.published ? ""
        : gated ? `<button class="btn" data-unlock>Unlock</button>`
        : `<a class="btn" href="skills/${esc(s.file)}" download="${esc(s.file)}">Download</a>`}
    </div>`;
  };

  screen.innerHTML = wrap(`
    <div class="page-head">
      <div class="eyebrow">Skills</div>
      <h1 class="h1">Get the skills</h1>
      <p class="lead">One current version of each, and nothing else. If an import was refused
        because your copy is old, this is where you fix it.</p>
    </div>

    ${list.length ? SKILL_GROUPS.map((g) => {
      const items = list.filter((s) => (s.group || "other") === g.id);
      if (!items.length) return "";
      const gated = g.id === "owner" && !unlocked;
      const open = openGroups()[g.id] ?? (g.id !== "owner");
      return `<details class="skill-group ${gated ? "is-gated" : ""}" data-group="${g.id}" ${open ? "open" : ""}>
        <summary>
          <div class="skill-group-head">
            <h2>${esc(g.label)}${gated ? `<span class="lock" aria-label="locked"></span>` : ""}</h2>
            ${g.note ? `<p>${esc(g.note)}</p>` : ""}
            <span class="skill-group-count">${items.length} skill${items.length === 1 ? "" : "s"}</span>
          </div>
        </summary>
        <div class="skill-list">${items.map(row).join("")}</div>
      </details>`;
    }).join("")
      : `<p class="muted">No skills have been published to this site yet.</p>`}

    <p class="buildline" style="max-width:62rem">${live.length} of ${list.length} published · hub ${esc(CONFIG.hubVersion)} ·
      renderer ${RENDERER_VERSION} · reads pack schema v${MIN_SCHEMA}–v${CURRENT_SCHEMA}${
      CONFIG.commit ? ` · build ${esc(CONFIG.commit)}` : ""}</p>`);

  // remember which groups the reader left open
  screen.querySelectorAll("details.skill-group").forEach((d) =>
    d.addEventListener("toggle", () => {
      const st = openGroups(); st[d.dataset.group] = d.open;
      localStorage.setItem("hub.skillGroups", JSON.stringify(st));
    }));

  screen.querySelectorAll("[data-unlock]").forEach((b) => b.addEventListener("click", askOwnerPassword));
}

const openGroups = () => { try { return JSON.parse(localStorage.getItem("hub.skillGroups")) || {}; } catch { return {}; } };

/* The gate is a signpost, not security: the .skill files sit at static URLs and
   anyone who knows one can fetch it directly. It exists so a proposal writer
   doesn't install site infrastructure by accident. Say that on the form rather
   than implying protection that isn't there. */
function askOwnerPassword() {
  modal(`
    <h2 class="h1" style="font-size:20px">Site owner skills</h2>
    <p class="sub" style="margin-top:8px">These stand up and maintain the site itself. Running them
      by mistake is the problem this asks about — they aren't secret.</p>
    <form id="unlockForm" style="margin-top:18px;display:flex;gap:8px">
      <input type="password" id="ownerPw" placeholder="Password" autocomplete="off" style="flex:1">
      <button class="btn btn-primary" type="submit">Unlock</button>
    </form>
    <p class="small" id="pwErr" style="margin-top:10px;color:var(--urgent)" hidden>That isn't the password.</p>`);
  const input = $("#ownerPw"); input.focus();
  $("#unlockForm").addEventListener("submit", (e) => {
    e.preventDefault();
    if (input.value !== (CONFIG.ownerPassword || "experis")) {
      $("#pwErr").hidden = false; input.select(); return;
    }
    sessionStorage.setItem("hub.ownerUnlocked", "1");
    $("#modal").hidden = true;
    screenSkills();
  });
}

/* The three steps, illustrated. Same words as the empty state — one source, in
   STEPS — with a panel each. Assembly-instruction logic: the picture
   carries the action, the line of text names it. */
/* ============================================================
   HELP — two tracks, two tabs
   The brief and the deck are different jobs done by different people at
   different times. One scroll containing both made each of them read as
   optional. Tabs are addressable (#/help and #/help/deck) so you can send
   someone the half that applies to them.
   ============================================================ */
const HELP_TABS = [
  { id: "brief", route: "#/help",      label: "The bid board",   sub: "Turn an RFP into a brief" },
  { id: "deck",  route: "#/help/deck", label: "The client deck", sub: "Turn the brief into a pitch" },
];

const HELP_STEPS = [
  { art: "assets/help/get-skill.svg",
    title: "Get the <code>/rfp</code> skill",
    body: `Download it from the <a href="#/skills">Get the skills</a> page and load it into your AI
           assistant. Do this once, and you'll be set forever.` },
  { art: "assets/help/run-rfp.svg",
    title: "Use the <code>/rfp</code> skill",
    body: `In your AI tool of choice — Claude, Copilot, etc — add all of the relevant RFP documents
           into one project folder and say <code>run /rfp</code>.` },
  { art: "assets/help/bundle.svg",
    title: "Save the opportunity pack",
    body: `The AI tool will create one zip file that ends in <code>-rfp-bundle.zip</code>. We will
           call this the <b>pursuit pack</b>.` },
  { art: "assets/help/import.svg",
    title: "Upload the opportunity pack",
    body: `Up at the top of this page, click <b>Import a pursuit</b> and add it. This populates all
           the relevant information into an indexed <b>pursuit</b> you can open from the home page.` },
];

const DECK_STEPS = [
  { art: "assets/help/export-pack.svg",
    title: "Export the pack from the brief",
    body: `Open the opportunity and click <b>Export pack</b>. You get a JSON file built to drop
           straight into the microsite template, so the deck starts from what the brief
           already knows and nothing is retyped.` },
  { art: "assets/help/draft-deck.svg",
    title: "Run <code>/draft-microsite</code>",
    body: `Put the pack in the same folder you ran <code>/rfp</code> on, then tell your AI
           assistant <code>run /draft-microsite</code>. It builds a branded, click-through deck
           in <b>draft</b> state — watermarked, version-stamped, with editing and commenting
           already switched on.` },
  { art: "assets/help/review-deck.svg",
    title: "Share the draft for review",
    body: `Reviewers open the link and work on the page itself. Comment on anything, or edit the
           copy in place. The activity log records who changed what, and a checkpoint rolls the
           deck back to a known good state whenever you want one.` },
  { art: "assets/help/publish-deck.svg",
    title: "Run <code>/publish-microsite</code>",
    body: `The final gate. The password goes on, every comment and edit trail is scrubbed from
           the build, the watermark comes off, the release is tagged, and analytics carries
           through with your own team's traffic filtered out — so the report measures the
           client, not you.` },
  { art: "assets/help/report-deck.svg",
    title: "Read the 7-day report",
    body: `Publishing schedules <code>/report</code> for a week later, and you can run it by hand
           any time. It reads the deck's live analytics into a one-pager: did they open it, what
           did they read, what held their attention longest, what did they download — and what
           they never reached.` },
];

const HELP_NOTES = {
  brief: [
    { h: "What's actually in the zip",
      p: `A <b>pack</b> — the RFP turned into data: requirements, dates, owners, risks, questions.
          This site draws the brief from that data, so when the design improves every opportunity
          improves at once and nobody re-does anything.` },
    { h: "If import refuses the file",
      p: `It will say why in plain words. Almost always it means the copy of <code>/rfp</code> that
          made the pack is older or newer than this site expects —
          <a href="#/skills">get the current skill</a> and run it again.` },
    { h: "If the RFP is amended",
      p: `Run <code>/rfp</code> again on the updated folder and import it over the top. Owners,
          statuses and checked-off rules survive — only the imported content changes.` },
    { h: "Who can see this",
      p: `Anyone with this site's URL. There is no sign-in. Don't put Experis rate or pricing
          detail in a pack, and think before importing a bundle that carries the client's own
          documents.` },
  ],
  deck: [
    { h: "Draft and published are different builds",
      p: `Not a setting you can toggle in the browser. Publishing produces a separate build with the
          comment layer and its Firebase config removed entirely, so there is no version of the
          client's deck that has review history hiding in it.` },
    { h: "Editing a draft doesn't fight the rebuild",
      p: `Edits are stored against the deck, not baked into the file. Re-running
          <code>/draft-microsite</code> or <code>/push-template</code> rebuilds the deck and your
          edits land back on top — the same reason re-importing a brief doesn't wipe your owners.` },
    { h: "If a rebuild moves the thing you edited",
      p: `The edit isn't lost, it's flagged. Anything whose anchor no longer matches is listed at
          the top of the deck for whoever opens it next, with the old text, so you can re-place it
          or drop it. Silently dropping an edit would be worse.` },
    { h: "Who can see a draft",
      p: `Anyone with the draft link — no password until you publish. Treat the draft URL like the
          brief URL: internal, unlisted, and not somewhere client pricing goes early.` },
  ],
};

function helpTab() {
  return (location.hash.replace(/^#/, "").split("/")[2] === "deck") ? "deck" : "brief";
}

function screenHelp() {
  const tab = helpTab();
  const steps = tab === "deck" ? DECK_STEPS : HELP_STEPS;

  screen.innerHTML = wrap(`
    <div class="page-head">
      <div class="eyebrow">Help</div>
      <h1 class="h1">How this works</h1>
      <p class="lead">${tab === "deck" ? DECK_LEAD : BRIEF_LEAD}</p>
    </div>

    <div class="tabs" role="tablist" aria-label="Which part of the process">
      ${HELP_TABS.map((t) => `
        <a class="tab" role="tab" href="${t.route}" aria-selected="${t.id === tab}">
          <b>${t.label}</b><span>${t.sub}</span>
        </a>`).join("")}
    </div>

    <ol class="steps-illustrated">
      ${steps.map((s) => `
        <li>
          <div class="step-art"><img src="${esc(s.art)}" alt="" width="260" height="180"></div>
          <div class="step-copy">
            <h2>${s.title}</h2>
            <p>${s.body}</p>
          </div>
        </li>`).join("")}
    </ol>

    ${tab === "deck" ? DECK_TOUR : BRIEF_TOUR}

    <details class="process" ${openGroups().process ? "open" : ""}>
      <summary>
        <span class="process-label">See the whole process</span>
        <span class="small muted">Where ${tab === "deck" ? "the deck" : "the brief"} sits in the
          pursuit, end to end — the short version.</span>
      </summary>
      <figure class="process-fig">
        <div class="process-scroll">
          <img src="assets/help/workflow.svg" alt="The pursuit process end to end: RFP documents, run /rfp, the brief on this site, the bid gate, kickoff, the client deck skills, and the seven-day report. A no-bid decision stops after the gate and stays recorded. An addendum re-runs /rfp." width="1160" height="360">
        </div>
        <figcaption>
          Only the bid gate and the kickoff need a room. Everything else is a skill you run or a
          file you drop. <a href="#/skills">Get the skills →</a>
        </figcaption>
      </figure>
    </details>

    <div class="help-notes">
      ${HELP_NOTES[tab].map((n) => `<section><h3>${n.h}</h3><p>${n.p}</p></section>`).join("")}
    </div>`);

  const d = screen.querySelector("details.process");
  d.addEventListener("toggle", () => {
    const st = openGroups(); st.process = d.open;
    localStorage.setItem("hub.skillGroups", JSON.stringify(st));
  });

  if (tab === "brief") mountTour();
}

const BRIEF_LEAD = `One place the whole team reads the same pursuit. Every RFP becomes a
  data-driven brief — the ask, the dates, the requirements, who owns what, what's at risk —
  and the source documents stay one click away in the Document Map. It is meant to be the
  single source of truth for a bid, from intake to submission.`;

const DECK_LEAD = `Once you've decided to bid, the same pack becomes the client-facing deck.
  You draft it, the team marks it up in place, and publishing turns it into a clean password-
  protected build with none of the review history in it. The brief stays internal; the deck is
  the only thing the client ever opens.`;

const BRIEF_TOUR = `
  <section class="tour">
    <h2 class="h2">What a pursuit looks like</h2>
    <p class="sub" style="margin-top:6px">A live one, embedded below — the same brief everyone
      else opens. Click through it here.</p>
    <div class="tour-frame" id="tourFrame"></div>
    <ul class="tour-points">
      <li><b>Snapshot</b> answers what this is, who's on it and what's needed next, before you
        scroll. The readiness and countdown are computed from the pack, not typed in.</li>
      <li><b>Document Map</b> keeps every source document indexed — hover for a preview, click to
        open or download it again. Nothing gets lost in a folder or an email thread.</li>
      <li><b>Any section has its own link.</b> Send someone the requirements, not the whole brief.</li>
      <li><b>Export pack</b> hands the content straight to the deck skills, so nothing is retyped
        between the brief and the client deck.</li>
    </ul>
  </section>`;

/* No live embed here on purpose. Decks are per-client and live at their own URLs,
   so there is no deck this site could honestly frame. Naming the two states and
   what separates them is more use than a screenshot of somebody else's pitch. */
const DECK_TOUR = `
  <section class="tour">
    <h2 class="h2">Draft and published, side by side</h2>
    <p class="sub" style="margin-top:6px">The same deck, two builds. Publishing is what moves it
      from the left column to the right, and it is not reversible in the browser.</p>
    <div class="state-compare">
      <div class="state-col">
        <div class="state-head"><span class="state-pill" data-state="draft">Draft</span>
          <span class="small muted">internal link, no password</span></div>
        <ul>
          <li>Comment on any line, threaded, with who and when</li>
          <li>Edit the copy in place — saves as you go</li>
          <li>Activity log and checkpoints, same as a brief</li>
          <li>Watermark and version stamp on every slide</li>
          <li>Analytics on, and your own views marked internal</li>
        </ul>
      </div>
      <div class="state-col">
        <div class="state-head"><span class="state-pill" data-state="pub">Published</span>
          <span class="small muted">password on, sent to the client</span></div>
        <ul>
          <li>Comment layer and its config removed from the build</li>
          <li>Edits baked in; no editing controls shipped</li>
          <li>No activity log, no review history, nothing to find</li>
          <li>Watermark gone, release tagged</li>
          <li>Analytics on, internal traffic filtered out of the report</li>
        </ul>
      </div>
    </div>
  </section>`;

/* Embed a real brief rather than a picture of one — it is the same build, so it
   cannot go stale, and the reader can click. With nothing imported there is
   nothing honest to show, so say that instead of faking a screenshot. */
function mountTour() {
  const host = $("#tourFrame");
  if (!host) return;
  const first = LIBRARY.find((p) => p.schemaVersion <= CURRENT_SCHEMA) || LIBRARY[0];
  if (!first) {
    host.innerHTML = `<div class="tour-empty">
      <p>Nothing imported yet — once a pursuit is in the library this shows a live one.</p>
      <a class="btn" href="#/import">Import a pursuit</a></div>`;
    return;
  }
  const base = location.href.split("#")[0];
  host.innerHTML = `
    <div class="tour-bar">
      <span class="tour-dots"><i></i><i></i><i></i></span>
      <span class="tour-url">${esc(base.split("/").pop() || "index.html")}#/b/${esc(first.briefId)}</span>
      <a class="btn btn-sm" href="#/b/${esc(first.briefId)}">Open full size</a>
    </div>
    <iframe title="A live pursuit brief" src="${esc(base)}#/b/${esc(first.briefId)}"></iframe>`;
}

/* ---------------- modal ---------------- */
function modal(html) {
  $("#modalBody").innerHTML = html;
  $("#modal").hidden = false;
  $("#modal").onclick = (e) => { if (e.target.id === "modal" || e.target.dataset.close !== undefined) $("#modal").hidden = true; };
}
