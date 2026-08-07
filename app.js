/* ============================================================
   BID BOARD — hub shell
   Hash router, Library, Import, Brief chrome, Skills, Help.
   The shell finds a pursuit. The renderer draws it. No overlap.
   ============================================================ */

import { initStore, store, listPursuits, getPack, getPursuit, putPursuit, updateIndex, deletePursuit, appendActivity, getAssetBytes, getElements, setElement, replaceElements, listActivity, saveCheckpoint, listCheckpoints } from "./store.js";
import { validate, askLine, CURRENT_SCHEMA, MIN_SCHEMA } from "./schema.js";
import { unzip, asJson } from "./unzip.js";
import { renderBrief, derive, RENDERER_VERSION } from "./renderer/renderer.js";

const $ = (s, r = document) => r.querySelector(s);
const screen = $("#screen");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let CONFIG = { hubName: "Bid Board", baseUrl: "", hubVersion: "1.1.0" };
let LIBRARY = [];
const view = { filter: "all", sort: "deadline", q: "" };

const DAY = 864e5;
const days = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d) ? null : Math.ceil((d - new Date().setHours(0, 0, 0, 0)) / DAY); };
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
   a normalised path — "/brief" not "/b/allianz-partners". You get section and
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
      el.textContent = "Demo"; el.dataset.mode = "local";
      el.title = "Sample data baked into this file. Nothing is saved and nobody else sees it.";
    }
    return;
  }
  const mode = !navigator.onLine ? "offline" : store.mode;
  const label = { shared: "Shared", local: "Local only", offline: "Offline" }[mode];
  for (const el of [$("#connPill"), $("#briefConn")]) {
    el.textContent = label;
    el.dataset.mode = mode;
    el.title = mode === "shared" ? "Imports are visible to everyone on this site."
      : mode === "local" ? "No shared storage configured — imports stay in this browser."
      : "No network. Showing what's cached in this browser.";
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
    <div class="page-head"><div class="eyebrow">Library</div><h1 class="h1">Pursuits</h1></div>
    <div class="cards">${'<div class="skel"></div>'.repeat(3)}</div>`);

  LIBRARY = await listPursuits();
  if (!LIBRARY.length) return paintEmpty();
  paintLibrary();
}

function paintEmpty() {
  screen.innerHTML = wrap(`
    <div class="page-head">
      <div class="eyebrow">Library</div>
      <h1 class="h1">No pursuits yet</h1>
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
  <b>Demo.</b> Sample pursuits are baked into this file so you can click around. Nothing is
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
      <h1 class="h1">Pursuits</h1>
      <p class="sub" style="margin-top:6px">${LIBRARY.length} imported${
        soon ? ` · <b style="color:var(--urgent)">${soon} due within a week</b>` : ""}.</p>
    </div>
    <div class="filters">
      ${["all", "active", "decided", "submitted"].map((f) => `
        <button class="chip" data-filter="${f}" aria-pressed="${view.filter === f}"
          ${counts(f) ? "" : "disabled"}>${
          { all: "All", active: "Active", decided: "No-bid", submitted: "Submitted" }[f]
        }<b>${counts(f)}</b></button>`).join("")}
      <span class="spacer"></span>
      <input type="search" id="q" placeholder="Search client or id" value="${esc(view.q)}">
      <select id="sort">
        <option value="deadline"${view.sort === "deadline" ? " selected" : ""}>Deadline</option>
        <option value="recent"${view.sort === "recent" ? " selected" : ""}>Recently imported</option>
        <option value="client"${view.sort === "client" ? " selected" : ""}>Client A–Z</option>
      </select>
    </div>
    <div class="cards" id="cards"></div>
    ${modeNote() ? `<div style="margin-top:26px">${modeNote()}</div>` : ""}`);

  paintCards();

  screen.addEventListener("click", (e) => {
    const c = e.target.closest("[data-filter]");
    if (c) { view.filter = c.dataset.filter; paintLibrary(); }
  });
  $("#q").addEventListener("input", (e) => { view.q = e.target.value; paintCards(); });
  $("#sort").addEventListener("change", (e) => { view.sort = e.target.value; paintCards(); });
}

function matchFilter(p, f) {
  if (f === "all") return true;
  if (f === "decided") return p.stage === "no-bid";
  if (f === "submitted") return p.stage === "submitted";
  return !["no-bid", "submitted"].includes(p.stage);
}

function paintCards() {
  const q = view.q.trim().toLowerCase();
  let rows = LIBRARY.filter((p) => matchFilter(p, view.filter))
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
}

function card(p) {
  const d = days(p.deadline);
  const stale = p.schemaVersion > CURRENT_SCHEMA || p.schemaVersion < MIN_SCHEMA;
  const closed = ["submitted", "no-bid"].includes(p.stage);
  const state = d === null ? "" : d < 0 ? "is-past" : d <= 7 ? "is-urgent" : "";
  const ready = typeof p.readiness === "number" ? Math.round(p.readiness * 100) : null;

  return `<a class="card ${stale ? "stale" : ""} ${state}" href="#/b/${esc(p.briefId)}">
    <div class="card-client">${esc(p.client)}</div>
    <div class="card-ask">${p.askLine ? esc(p.askLine) : "<span class='muted'>No summary in the pack.</span>"}</div>
    <div class="card-due">${p.deadline
      ? `<span>${d < 0 ? "Closed" : "Due"} ${esc(fmtDate(p.deadline))}</span>
         <span class="card-days">${d < 0 ? `${Math.abs(d)}d ago` : `${d}d left`}</span>`
      : `<span class="muted" style="font-weight:400">No deadline captured</span>`}</div>

    ${stale
      ? `<div class="small muted">Needs a newer pack — built for schema v${esc(p.schemaVersion)}.</div>`
      : `<div class="card-stage ${closed ? "is-closed" : ""}">${esc(STAGE_LABEL[p.stage] || p.stage || "Stage not set")}${
          p.counts ? ` · ${p.counts.requirements} reqs · ${p.counts.openItems} open` : ""}</div>`}

    <div class="card-foot">
      ${ready !== null && !stale ? `<div class="card-ready">
        <span class="num">${ready}%</span>
        <span class="bar"><i style="width:${ready}%"></i></span>
        <span>ready</span></div>` : ""}
      <div class="card-prov">${esc(p.importedBy || "—")} · imported ${esc(ago(p.importedAt))}</div>
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

function importReview() {
  const s = staged.summary, up = !!staged.existing;
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
      ${staged.migratedFrom ? `<dt>Schema</dt><dd>migrated from v${staged.migratedFrom} to v${CURRENT_SCHEMA}</dd>` : ""}
      ${staged.assets.size ? `<dt>Files</dt><dd>${staged.assets.size} attached</dd>` : ""}
    </dl>
    ${up ? `<div class="notice" style="margin-top:16px">
      Edits the team has made here since the last import are kept — they layer on top of the
      new pack rather than being replaced by it. Only the imported content changes.</div>` : ""}
    ${s.carriesSourceDocs ? `<div class="notice" style="margin-top:12px">
      This bundle carries the client's source documents. Once imported they are readable by
      anyone with this site's URL. Confirm that's intended.</div>` : ""}
    ${modeNote() ? `<div style="margin-top:12px">${modeNote()}</div>` : ""}
    <p style="margin-top:24px;display:flex;gap:8px">
      <button class="btn btn-primary" id="doImport">${up ? "Update the pursuit" : "Import it"}</button>
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
    await putPursuit({ index, pack, assets });
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
        <p class="sub">No pursuit called <code>${esc(briefId)}</code> is in this library.</p></div></div>
      <p><a class="btn" href="#/">Back to the library</a>
         <a class="btn" href="#/import">Import it</a></p>`, true));
  }
  $("#briefClient").textContent = idx.client;

  const pack = await getPack(briefId);
  if (!pack) return (screen.innerHTML = wrap(`
    <div class="notice bad">This pursuit is in the library but its content isn't cached on this
    device and the site can't reach shared storage right now.</div>`, true));

  // Pre-resolve hosted asset URLs so the renderer stays synchronous.
  const urls = await resolveAssetUrls(idx, pack);

  screen.innerHTML = `<div id="brief"></div>`;
  BRIEF = { briefId, idx, pack, api: null, editing: false };

  const opts = {
    section: section || "snapshot",
    headerHeight: 60,
    onNavigate: (id) => history.replaceState(null, "", `#/b/${briefId}/${id}`),
    onDerive: (m) => {
      const changed = m.readiness !== BRIEF.idx.readiness || JSON.stringify(m.counts) !== JSON.stringify(BRIEF.idx.counts);
      if (changed) {
        BRIEF.idx = { ...BRIEF.idx, readiness: m.readiness, counts: m.counts };
        updateIndex(briefId, { readiness: m.readiness, counts: m.counts }).catch(() => {});
      }
    },
    onEdit: applyEdit,
    resolveDoc: (doc, page) => {
      if (!doc || doc.unreadable) return null;
      const u = urls[doc.href];
      return u ? u + (page && String(doc.type).toLowerCase() === "pdf" ? `#page=${page}` : "") : null;
    },
  };
  BRIEF.opts = opts;
  BRIEF.api = renderBrief(pack, $("#brief"), opts);

  bindBriefBar(briefId, idx, pack, BRIEF.api);
  refreshActivityCount();
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

const NEW_ITEM = {
  actionItems: () => ({ id: "A-" + Date.now().toString(36).slice(-5).toUpperCase(), task: "New item", owner: null, status: "open", due: "" }),
  questions:   () => ({ id: "Q-" + Date.now().toString(36).slice(-5).toUpperCase(), topic: "General", text: "New question" }),
  risks:       () => ({ id: "K-" + Date.now().toString(36).slice(-5).toUpperCase(), severity: "med", title: "New risk", detail: "", mitigation: "" }),
  rules:       () => ({ id: "C-" + Date.now().toString(36).slice(-5).toUpperCase(), label: "New rule", checked: false, mandatory: false }),
};

async function applyEdit(change) {
  const who = editorName();
  if (!who) return;
  const { briefId } = BRIEF;
  const at = new Date().toISOString();

  let entry;
  if (change.kind === "add") {
    const value = (NEW_ITEM[change.coll] || (() => ({ id: "X-" + Date.now().toString(36) })))();
    entry = { id: `add-${change.coll}-${value.id}`, kind: "add", collection: change.coll, value, editor: who, at };
  } else if (change.kind === "remove") {
    entry = { id: `remove-${change.coll}-${change.itemId}`, kind: "remove", collection: change.coll, itemId: change.itemId, editor: who, at };
  } else {
    entry = { id: change.elementId, kind: "set", path: change.path, value: change.value, editor: who, at };
  }

  await setElement(briefId, entry.id, entry);
  await appendActivity(briefId, {
    kind: "human", editor: who, elementId: change.elementId || entry.id,
    section: (change.coll || String(change.path || "").split(/[.[]/)[0] || ""),
    field: change.label || change.path, before: change.before ?? null,
    after: change.kind === "remove" ? "(deleted)" : (change.value ?? "(new)"),
  });

  // rebuild the merged pack from baseline + overrides so derived numbers are honest
  BRIEF.pack = await getPack(briefId);
  if (change.rerender !== false) {
    BRIEF.api = BRIEF.api.update(BRIEF.pack, "edit");
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

async function refreshActivityCount() {
  const el = $("#actCount");
  if (!el || !BRIEF) return;
  const n = (await listActivity(BRIEF.briefId)).length;
  el.textContent = n ? String(n) : "";
  el.hidden = !n;
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

  body.innerHTML = all.length ? all.map((a) => `
    <button class="act-row" ${a.elementId ? `data-jump="${esc(a.elementId)}"` : ""}>
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

/* Resolve only documents that actually travelled with the bundle. Anything else
   returns nothing and the renderer prints the row as plain text — a link that
   404s is worse than no link. */
async function resolveAssetUrls(idx, pack) {
  const out = {};
  for (const doc of pack.documents || []) {
    if (!doc.href || doc.unreadable) continue;
    if (store.mode === "shared" && store._fb && navigator.onLine) {
      const { st, bucket, root } = store._fb;
      try { out[doc.href] = await st.getDownloadURL(st.ref(bucket, `${root}/${idx.briefId}/${doc.href}`)); continue; } catch {}
    }
    const bytes = await getAssetBytes(idx.briefId, doc.href);
    if (bytes) out[doc.href] = URL.createObjectURL(new Blob([bytes]));
  }
  return out;
}

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
      every pursuit at once — packs are data, so nothing needs re-importing.</p>`);
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
      const ok = prompt(`Type the pursuit id to delete it permanently:\n${briefId}`);
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
    title: "Save the pursuit pack",
    body: `The AI tool will create one zip file that ends in <code>-rfp-bundle.zip</code>. We will
           call this the <b>pursuit pack</b>.` },
  { art: "assets/help/import.svg",
    title: "Upload the pursuit pack",
    body: `Up at the top of this page, click <b>Import a pursuit</b> and add it. This populates all
           the relevant information into an indexed <b>pursuit</b> you can open from the home page.` },
];

const DECK_STEPS = [
  { art: "assets/help/export-pack.svg",
    title: "Export the pack from the brief",
    body: `Open the pursuit and click <b>Export pack</b>. You get a JSON file built to drop
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
          This site draws the brief from that data, so when the design improves every pursuit
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
