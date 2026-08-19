/* ============================================================
   COMMENTS — the review layer for a brief.

   Deliberately the same product as the microsite deck's comment layer:
   a corner button with an unresolved count, a slide-out panel filtered by
   open / resolved / all, a pick mode that outlines whatever you hover and
   anchors a thread to it, pins on the page, threaded replies, resolve and
   reopen. Someone who has reviewed a deck should need no second explanation
   here. Only the addressing differs, because the two documents are different
   shapes:

     deck  → { slideSlug, slideTitle, slideIndex, path[] }   DOM position
     brief → { section, el, label }                          the renderer's
                                                             own data-el ids

   The brief's scheme is the better one and it already existed: every
   addressable row carries data-el="question-Q-1" or "req-R-011", which
   survives re-rendering, re-ordering and re-import. A DOM path does not.

   Threads live at pursuits/{briefId}/threads and sync live via onSnapshot.
   With no Firebase they fall back to localStorage, so the review layer works
   in a single-file preview exactly as the deck's does.

   Orphans are never dropped. If the element a thread points at is gone, the
   thread stays, is marked, and waits for a person to resolve it. Silently
   discarding somebody's comment because a row moved is the one behaviour
   this must not have.
   ============================================================ */

import { store } from "./store.js";

const LS_USER = "hub.editor";                 // shared with edit mode on purpose
const LS_THREADS = (b) => `hub.threads.${b}`;
const LS_SEEN = (b) => `hub.threadsSeen.${b}`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const nowIso = () => new Date().toISOString();
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const ago = (v) => {
  const n = Math.floor((Date.now() - new Date(v)) / 864e5);
  return isNaN(n) ? "" : n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
};

let S = null;   // the live instance, or null when no brief is open

/* ---------------- storage ---------------- */
const readLocal = (b) => { try { return JSON.parse(localStorage.getItem(LS_THREADS(b))) || []; } catch { return []; } };
const writeLocal = (b, arr) => { try { localStorage.setItem(LS_THREADS(b), JSON.stringify(arr)); } catch {} };

async function persist(thread) {
  if (S.fb) {
    const { fs, col } = S.fb;
    try { await fs.setDoc(fs.doc(col, thread.id), JSON.parse(JSON.stringify(thread))); }
    catch (e) { console.warn("comment save failed", e); toast("Couldn't save — check your connection"); }
    return;
  }
  const arr = readLocal(S.briefId);
  const i = arr.findIndex((t) => t.id === thread.id);
  if (i >= 0) arr[i] = thread; else arr.push(thread);
  writeLocal(S.briefId, arr);
  S.threads = arr;
  render();
}

async function destroy(id) {
  if (S.fb) {
    const { fs, col } = S.fb;
    try { await fs.deleteDoc(fs.doc(col, id)); } catch (e) { console.warn("comment delete failed", e); }
    return;
  }
  S.threads = readLocal(S.briefId).filter((t) => t.id !== id);
  writeLocal(S.briefId, S.threads);
  render();
}

/* ---------------- anchors ----------------
   Anchored to the renderer's own element ids, which are stable across a
   re-render and across a re-import. Falls back to the section, so a comment
   on a paragraph with no id still lands somewhere meaningful rather than
   being refused. */
function computeAnchor(target) {
  const holder = target.closest("[data-el]");
  const section = target.closest(".rb-section");
  if (!section) return null;

  const label = (holder || target).textContent.trim().replace(/\s+/g, " ").slice(0, 70)
    || (holder ? holder.dataset.el : "this section");

  return {
    section: section.dataset.section || "",
    sectionLabel: section.querySelector(".rb-h1")?.textContent?.trim() || section.dataset.section || "",
    el: holder ? holder.dataset.el : null,
    label,
  };
}

const findAnchored = (a) => {
  if (!a) return null;
  if (a.el) {
    const hit = S.mount.querySelector(`[data-el="${CSS.escape(a.el)}"]`);
    if (hit) return hit;
  }
  return S.mount.querySelector(`.rb-section[data-section="${CSS.escape(a.section || "")}"]`) || null;
};

/* A thread whose element has gone is orphaned, not deleted. */
const isOrphan = (t) => !!(t.anchor?.el && !S.mount.querySelector(`[data-el="${CSS.escape(t.anchor.el)}"]`));

/* ---------------- identity ---------------- */
const getUser = () => { try { return localStorage.getItem(LS_USER) || ""; } catch { return ""; } };
const setUser = (u) => { try { localStorage.setItem(LS_USER, u); } catch {} };

function ensureUser(cb) {
  const u = getUser();
  if (u) { paintUser(); return cb && cb(); }
  askText("Your name, so the team can see who said what:", "", (name) => {
    if (name) { setUser(name); paintUser(); cb && cb(); }
  });
}
const paintUser = () => {
  const e = S?.panel.querySelector(".cm-user");
  if (e) e.textContent = getUser() ? `Commenting as ${getUser()}` : "";
};

/* ---------------- in-page dialogs ----------------
   Not window.prompt: it is blocked in some embeds, it cannot be styled, and
   it truncates anything long — which is most comments. */
function askText(message, initial, cb) {
  const ov = el("div", "cm-modal");
  const box = el("div", "cm-modal-box");
  box.appendChild(el("div", "cm-modal-msg", esc(message)));
  const inp = el("textarea", "cm-modal-input");
  inp.rows = /comment|reply|edit/i.test(message) ? 3 : 1;
  inp.value = initial || "";
  const row = el("div", "cm-row");
  const ok = el("button", "cm-btn cm-primary", "OK");
  const cancel = el("button", "cm-btn", "Cancel");
  row.append(ok, cancel);
  box.append(inp, row); ov.appendChild(box);
  document.body.appendChild(ov);
  setTimeout(() => inp.focus(), 0);
  const close = () => ov.remove();
  ok.onclick = () => { const v = inp.value.trim(); close(); cb(v || null); };
  cancel.onclick = () => { close(); cb(null); };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (inp.rows === 1 || !e.shiftKey)) { e.preventDefault(); ok.onclick(); }
    else if (e.key === "Escape") cancel.onclick();
  });
}

function askConfirm(message, cb) {
  const ov = el("div", "cm-modal");
  const box = el("div", "cm-modal-box");
  box.appendChild(el("div", "cm-modal-msg", esc(message)));
  const row = el("div", "cm-row");
  const ok = el("button", "cm-btn cm-danger", "Delete");
  const cancel = el("button", "cm-btn", "Cancel");
  row.append(ok, cancel); box.append(row); ov.appendChild(box);
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ok.onclick = () => { close(); cb(true); };
  cancel.onclick = () => { close(); cb(false); };
}

function toast(msg) {
  const t = el("div", "cm-toast", esc(msg));
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

/* ---------------- shell ---------------- */
function buildShell() {
  const fab = el("button", "cm-fab");
  fab.type = "button";
  fab.onclick = () => ensureUser(() => openPanel(true));

  const panel = el("aside", "cm-panel");
  panel.hidden = true;
  panel.setAttribute("aria-label", "Review comments");
  panel.innerHTML = `
    <div class="cm-head">
      <div>
        <b>Review comments</b>
        <div class="cm-user"></div>
      </div>
      <button class="cm-x" aria-label="Close">×</button>
    </div>
    <div class="cm-bar">
      <button class="cm-add">+ Comment on something</button>
      <span class="cm-filters"></span>
    </div>
    <div class="cm-list"></div>`;

  panel.querySelector(".cm-x").onclick = () => openPanel(false);
  const add = panel.querySelector(".cm-add");
  add.onclick = () => ensureUser(() => togglePick());

  const filters = panel.querySelector(".cm-filters");
  for (const f of ["open", "resolved", "all"]) {
    const b = el("button", "cm-filter", f[0].toUpperCase() + f.slice(1));
    b.dataset.f = f;
    b.onclick = () => { S.filter = f; render(); };
    filters.appendChild(b);
  }

  document.body.append(fab, panel);
  return { fab, panel, add, listEl: panel.querySelector(".cm-list") };
}

function openPanel(open) {
  S.panel.hidden = !open;
  document.body.classList.toggle("cm-open", open);
  if (open) { paintUser(); render(); markSeen(); }
  else stopPick();
}

/* ---------------- pick mode ---------------- */
function togglePick() {
  S.picking ? stopPick() : startPick();
}
function startPick() {
  S.picking = true;
  S.add.classList.add("is-on");
  document.body.classList.add("cm-picking");
  S.hint = el("div", "cm-hint", "Click anything in the brief to comment on it — Esc to cancel");
  document.body.appendChild(S.hint);
  document.addEventListener("mousemove", onHover, true);
  document.addEventListener("click", onPick, true);
  document.addEventListener("keydown", onEsc, true);
}
function stopPick() {
  if (!S?.picking) return;
  S.picking = false;
  S.add.classList.remove("is-on");
  document.body.classList.remove("cm-picking");
  S.hint?.remove(); S.hint = null;
  clearHover();
  document.removeEventListener("mousemove", onHover, true);
  document.removeEventListener("click", onPick, true);
  document.removeEventListener("keydown", onEsc, true);
}
const onEsc = (e) => { if (e.key === "Escape") stopPick(); };
const clearHover = () => { S.hovered?.classList.remove("cm-hover"); S.hovered = null; };

/* The section nav lives inside the mount, so it would otherwise be a pick
   target — and worse, picking would swallow the click and trap you in whatever
   section you started in. Nav clicks pass straight through and pick mode stays
   armed, so you can walk the brief and comment where you land. */
const pickable = (t) => S.mount.contains(t) && !S.panel.contains(t) && !t.closest(".rb-nav");

function onHover(e) {
  const t = e.target;
  if (!pickable(t)) { clearHover(); return; }
  const box = t.closest("[data-el]") || t.closest(".rb-section") || t;
  if (box !== S.hovered) { clearHover(); S.hovered = box; box.classList.add("cm-hover"); }
}

function onPick(e) {
  const t = e.target;
  if (!S.mount.contains(t) || S.panel.contains(t)) return;
  if (t.closest(".rb-nav")) { clearHover(); return; }   // let navigation happen
  e.preventDefault(); e.stopPropagation();
  const anchor = computeAnchor(t);
  clearHover(); stopPick();
  if (anchor) openComposer(anchor);
  else toast("Pick something inside a section of the brief.");
}

function openComposer(anchor) {
  openPanel(true);
  const box = el("div", "cm-th is-new");
  box.innerHTML = `<div class="cm-anchor"><b>${esc(anchor.sectionLabel)}</b>
    <span class="cm-loc">${esc(anchor.label)}</span></div>`;
  const ta = el("textarea", "cm-reply");
  ta.placeholder = "What needs to change here?";
  const row = el("div", "cm-row");
  const save = el("button", "cm-btn cm-primary", "Comment");
  const cancel = el("button", "cm-btn", "Cancel");
  row.append(save, cancel);
  box.append(ta, row);
  S.listEl.prepend(box);
  ta.focus();

  cancel.onclick = () => render();
  save.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    const who = getUser();
    const at = nowIso();
    await persist({
      id: uid(), briefId: S.briefId, anchor, author: who,
      createdAt: at, updatedAt: at, resolved: false,
      messages: [{ id: uid(), author: who, text, createdAt: at }],
    });
    render();
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save.onclick();
    if (e.key === "Escape") render();
  });
}

/* ---------------- render ---------------- */
function threadsFor(filter) {
  const all = (S.threads || []).slice()
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  if (filter === "open") return all.filter((t) => !t.resolved);
  if (filter === "resolved") return all.filter((t) => t.resolved);
  return all;
}

function render() {
  if (!S) return;
  for (const b of S.panel.querySelectorAll(".cm-filter")) {
    b.setAttribute("aria-pressed", String(b.dataset.f === S.filter));
  }
  const rows = threadsFor(S.filter);
  S.listEl.innerHTML = "";

  if (!rows.length) {
    S.listEl.appendChild(el("p", "cm-empty", S.filter === "open"
      ? "Nothing open. Use <b>+ Comment on something</b> and click any part of the brief."
      : "Nothing here."));
  }

  for (const t of rows) S.listEl.appendChild(renderThread(t));
  paintCount();
  paintPins();
  paintNavBadges();
}

function renderThread(t) {
  const orphan = isOrphan(t);
  const box = el("div", `cm-th${t.resolved ? " is-resolved" : ""}${orphan ? " is-orphan" : ""}`);

  const head = el("button", "cm-anchor");
  head.innerHTML = `<b>${esc(t.anchor?.sectionLabel || "Brief")}</b>
    <span class="cm-loc">${esc(t.anchor?.label || "")}</span>
    ${orphan ? `<span class="cm-orphan-tag">the thing this pointed at has moved</span>` : ""}`;
  head.onclick = () => jumpTo(t);
  box.appendChild(head);

  for (const m of t.messages || []) {
    const msg = el("div", "cm-msg");
    msg.innerHTML = `<div class="cm-msg-head"><b>${esc(m.author || "—")}</b>
        <span>${esc(ago(m.createdAt))}</span></div>
      <div class="cm-msg-text">${esc(m.text)}</div>`;
    box.appendChild(msg);
  }

  const row = el("div", "cm-row cm-actions");
  const reply = el("button", "cm-btn", "Reply");
  reply.onclick = () => ensureUser(() => inlineReply(box, t));
  const res = el("button", "cm-btn", t.resolved ? "Reopen" : "Resolve");
  res.onclick = async () => {
    t.resolved = !t.resolved; t.updatedAt = nowIso();
    await persist(t); render();
  };
  const del = el("button", "cm-btn cm-quiet", "Delete");
  del.onclick = () => askConfirm("Delete this whole thread? This cannot be undone.", (yes) => {
    if (yes) destroy(t.id).then(render);
  });
  row.append(reply, res, del);
  box.appendChild(row);
  return box;
}

function inlineReply(box, t) {
  if (box.querySelector(".cm-reply")) return;
  const ta = el("textarea", "cm-reply");
  ta.placeholder = "Reply…";
  const row = el("div", "cm-row");
  const save = el("button", "cm-btn cm-primary", "Reply");
  const cancel = el("button", "cm-btn", "Cancel");
  row.append(save, cancel);
  box.append(ta, row); ta.focus();
  cancel.onclick = () => render();
  save.onclick = async () => {
    const text = ta.value.trim();
    if (!text) return;
    t.messages = [...(t.messages || []), { id: uid(), author: getUser(), text, createdAt: nowIso() }];
    t.updatedAt = nowIso();
    if (t.resolved) t.resolved = false;   // replying to a resolved thread reopens it
    await persist(t); render();
  };
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save.onclick();
    if (e.key === "Escape") render();
  });
}

/* ---------------- page furniture ---------------- */
function jumpTo(t) {
  if (t.anchor?.section && S.gotoSection) S.gotoSection(t.anchor.section);
  setTimeout(() => {
    const node = findAnchored(t.anchor);
    if (!node) { toast("That part of the brief is no longer here."); return; }
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.add("cm-flash");
    setTimeout(() => node.classList.remove("cm-flash"), 1400);
  }, 90);
}

function paintCount() {
  const open = (S.threads || []).filter((t) => !t.resolved).length;
  S.fab.innerHTML = `<span class="cm-bubble" aria-hidden="true"></span><span>Comments</span>${
    open ? `<span class="cm-count">${open}</span>` : ""}`;
  S.fab.setAttribute("aria-label", open ? `Review comments, ${open} open` : "Review comments");
}

/* A dot on the element a thread points at, so the brief itself shows where the
   conversation is rather than making you read the panel to find out. */
function paintPins() {
  for (const p of S.mount.querySelectorAll(".cm-pin")) p.remove();
  const byEl = new Map();
  for (const t of S.threads || []) {
    if (t.resolved || !t.anchor?.el) continue;
    byEl.set(t.anchor.el, (byEl.get(t.anchor.el) || 0) + 1);
  }
  for (const [id, n] of byEl) {
    const node = S.mount.querySelector(`[data-el="${CSS.escape(id)}"]`);
    if (!node) continue;
    const pin = el("button", "cm-pin", String(n));
    pin.title = `${n} open comment${n === 1 ? "" : "s"}`;
    pin.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      openPanel(true);
      S.filter = "open"; render();
    };
    node.appendChild(pin);
  }
}

function paintNavBadges() {
  const counts = {};
  for (const t of S.threads || []) {
    if (t.resolved) continue;
    const s = t.anchor?.section;
    if (s) counts[s] = (counts[s] || 0) + 1;
  }
  for (const a of S.mount.querySelectorAll(".rb-nav [data-goto]")) {
    const n = counts[a.dataset.goto] || 0;
    let badge = a.querySelector(".cm-navbadge");
    if (n) {
      if (!badge) { badge = el("span", "cm-navbadge"); a.appendChild(badge); }
      badge.textContent = n;
    } else badge?.remove();
  }
}

/* ---------------- unseen ---------------- */
function markSeen() {
  try {
    const ids = (S.threads || []).flatMap((t) => (t.messages || []).map((m) => m.id));
    localStorage.setItem(LS_SEEN(S.briefId), JSON.stringify(ids));
  } catch {}
}

/* ---------------- lifecycle ---------------- */
export async function mountComments({ briefId, mount, gotoSection }) {
  unmountComments();
  const shell = buildShell();
  S = {
    briefId, mount, gotoSection, filter: "open", picking: false,
    threads: readLocal(briefId), fb: null, unsub: null, hovered: null, hint: null,
    ...shell,
  };
  render();

  if (store.mode === "shared" && store._fb && navigator.onLine) {
    const { fs, db, root } = store._fb;
    const col = fs.collection(db, root, briefId, "threads");
    S.fb = { fs, col };

    /* onSnapshot does NOT retry: the error callback means the listener is dead.
       The previous version treated one transient failure as permanent — it
       nulled S.fb, so commenting silently degraded to this-browser-only for the
       rest of the session, and the toast made a blip look like a broken feature.
       Reconnect a few times with backoff, and only tell the user once we have
       actually given up. */
    let tries = 0;
    const attach = () => {
      S.unsub = fs.onSnapshot(col, (snap) => {
        tries = 0;
        S.threads = snap.docs.map((d) => d.data());
        render();
      }, (err) => {
        console.warn(`comment sync dropped (attempt ${tries + 1})`, err);
        try { S.unsub?.(); } catch {}
        if (++tries <= 3 && navigator.onLine) {
          setTimeout(() => { if (S && S.briefId === briefId) attach(); }, 1000 * tries);
          return;
        }
        toast("Comments are offline — you'll see what's cached until this page is reloaded");
        S.fb = null;
        S.threads = readLocal(briefId);
        render();
      });
    };
    attach();
  }
  return S;
}

export function unmountComments() {
  if (!S) return;
  stopPick();
  try { S.unsub?.(); } catch {}
  S.fab.remove();
  S.panel.remove();
  document.body.classList.remove("cm-open", "cm-picking");
  S = null;
}

/* Re-paint the furniture after the renderer replaces the brief's DOM — the
   pins and badges live inside it and go with it. */
export function refreshComments() {
  if (S) { paintPins(); paintNavBadges(); }
}
