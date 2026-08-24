/* ============================================================
   STORE — one API, two backends.
   The rest of the app cannot tell which one it got.

     shared : Firestore only — an index doc plus the pack split across
              chunk documents
     local  : IndexedDB (also the offline cache in shared mode)

   Cloud Storage is deliberately not used. It requires the Blaze plan, and
   needing a billing account to stand up an internal tool is a delay measured
   in weeks at a company this size. So the pack is chunked instead: a Firestore
   document caps at 1 MiB, and a pack carrying base64 PDF thumbnails clears
   that on its own, so JSON.stringify(pack) is sliced across
   pursuits/{briefId}/pack/{i} and reassembled on read.

   The cost of that choice is real and worth stating: bundled DOCUMENTS stay in
   the importer's browser. Everyone sees the same brief; only the person who
   imported it can open the source files from the Document Map. Given the site
   is a public URL with no sign-in, keeping client documents off the network is
   the better failure mode. See reference/data-model.md.
   ============================================================ */

const SDK = "https://www.gstatic.com/firebasejs/10.12.2";
const DB_NAME = "bid-board";
const DB_VER = 2;   // v2 adds the checkpoints store

export const store = {
  mode: "local",          // shared | local
  online: true,
  _fb: null,
};

/* ---------------- IndexedDB plumbing ---------------- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("pursuits")) db.createObjectStore("pursuits", { keyPath: "briefId" });
      if (!db.objectStoreNames.contains("packs")) db.createObjectStore("packs");
      if (!db.objectStoreNames.contains("assets")) db.createObjectStore("assets");
      if (!db.objectStoreNames.contains("elements")) db.createObjectStore("elements");
      if (!db.objectStoreNames.contains("activity")) db.createObjectStore("activity", { autoIncrement: true });
      if (!db.objectStoreNames.contains("checkpoints")) db.createObjectStore("checkpoints");
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(storeName, mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(storeName, mode);
    const req = fn(t.objectStore(storeName));
    let value;
    // Read req.result on success, not at oncomplete — a miss leaves result
    // undefined, and `req.result ?? req` would hand back the request object,
    // which is truthy and would make every new pursuit look like an update.
    if (req && typeof req.onsuccess !== "undefined") req.onsuccess = () => { value = req.result; };
    t.oncomplete = () => res(value);
    t.onerror = () => rej(t.error);
  });
}
/* Memory fallback. IndexedDB is unavailable on file:// in Chrome, so without
   this a single-file build of the site (or someone double-clicking index.html)
   would break on first read. One flag, set the first time IndexedDB refuses. */
const mem = new Map();
const bucket = (s) => (mem.has(s) ? mem.get(s) : (mem.set(s, new Map()), mem.get(s)));
let memoryOnly = typeof indexedDB === "undefined";

async function kv(storeName, mode, fn, memFn) {
  if (memoryOnly) return memFn(bucket(storeName));
  try { return await tx(storeName, mode, fn); }
  catch (e) { memoryOnly = true; console.warn("Storage unavailable — using memory for this session.", e); return memFn(bucket(storeName)); }
}
const idbAll = (s) => kv(s, "readonly", (os) => os.getAll(), (m) => [...m.values()]);
const idbGet = (s, k) => kv(s, "readonly", (os) => os.get(k), (m) => m.get(k));
/* The memory fallback has to mirror each object store's key strategy, not guess
   one. "activity" is autoIncrement in IndexedDB; keying it by briefId here made
   every row for a pursuit overwrite the previous one, so the log showed exactly
   one entry per brief and looked like edits were not being recorded. */
let autoKey = 0;
const AUTO_STORES = new Set(["activity"]);
const idbPut = (s, v, k) => kv(s, "readwrite", (os) => os.put(v, k),
  (m) => m.set(
    k !== undefined ? k
      : AUTO_STORES.has(s) ? `auto-${++autoKey}`
      : (v && v.briefId) ?? `auto-${++autoKey}`,
    v));
const idbDel = (s, k) => kv(s, "readwrite", (os) => os.delete(k), (m) => m.delete(k));

/* ---------------- init ---------------- */
export async function initStore() {
  let cfg = null;
  try {
    const r = await fetch("firebase.config.json", { cache: "no-store" });
    if (r.ok) {
      const c = await r.json();
      if (c && c.apiKey && !/PASTE|YOUR_/i.test(c.apiKey)) cfg = c;
    }
  } catch { /* no config file — local mode, which is a supported state */ }

  if (!cfg) { store.mode = "local"; return store; }

  try {
    const [{ initializeApp }, fs] = await Promise.all([
      import(`${SDK}/firebase-app.js`),
      import(`${SDK}/firebase-firestore.js`),
    ]);
    const app = initializeApp(cfg);
    store._fb = { fs, db: fs.getFirestore(app), root: cfg.hubCollection || "pursuits" };
    store.mode = "shared";
  } catch (e) {
    console.warn("Firebase unavailable — falling back to local storage.", e);
    store.mode = "local";
  }
  addEventListener("online", () => { store.online = true; });
  addEventListener("offline", () => { store.online = false; });
  return store;
}

/* ---------------- reads ---------------- */
export async function listPursuits() {
  if (store.mode === "shared" && navigator.onLine) {
    const { fs, db, root } = store._fb;
    try {
      const snap = await fs.getDocs(fs.collection(db, root));
      const rows = snap.docs.map((d) => d.data());
      for (const row of rows) await idbPut("pursuits", row);   // refresh the offline cache
      return rows;
    } catch (e) {
      console.warn("Falling back to cached library.", e);
      store.online = false;
    }
  }
  return idbAll("pursuits");
}

export async function getPursuit(briefId) {
  if (store.mode === "shared" && navigator.onLine) {
    const { fs, db, root } = store._fb;
    const d = await fs.getDoc(fs.doc(db, root, briefId));
    if (d.exists()) { await idbPut("pursuits", d.data()); return d.data(); }
  }
  return idbGet("pursuits", briefId);
}

export async function getPack(briefId) {
  const idx = await getPursuit(briefId);
  if (!idx) return null;
  if (store.mode === "shared" && navigator.onLine && idx.packChunks) {
    try {
      const pack = await readChunkedPack(briefId, idx.packChunks);
      await idbPut("packs", pack, briefId);
      return applyOverrides(pack, await getElements(briefId));
    } catch (e) { console.warn("Pack fetch failed — using cache.", e); }
  }
  const cached = await idbGet("packs", briefId);
  return cached ? applyOverrides(cached, await getElements(briefId)) : null;
}

export async function getElements(briefId) {
  if (store.mode === "shared" && navigator.onLine) {
    const { fs, db, root } = store._fb;
    try {
      const snap = await fs.getDocs(fs.collection(db, root, briefId, "elements"));
      return snap.docs.map((d) => d.data());
    } catch { /* fall through */ }
  }
  return (await idbGet("elements", briefId)) || [];
}

/* Effective state = imported baseline + element overrides, applied in order.
   This is what makes re-import non-destructive: a fresh pack replaces the
   baseline and the team's edits survive on top of it. */
export function applyOverrides(pack, overrides) {
  if (!overrides || !overrides.length) return pack;
  const out = structuredClone(pack);
  for (const o of overrides.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))) {
    try {
      if (o.kind === "add") {
        out[o.collection] = [...(out[o.collection] || []), o.value];
      } else if (o.kind === "remove") {
        out[o.collection] = (out[o.collection] || []).filter((x) => String(x.id) !== String(o.itemId));
      } else {
        setByPath(out, o.path, o.value);
      }
    } catch { /* orphaned override — surfaced at re-import */ }
  }
  return out;
}

function setByPath(obj, path, value) {
  // supports  requirements[id=R-014].owner  and  submission.date
  const parts = path.match(/[^.[\]]+(\[[^\]]+\])?/g) || [];
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    const m = /^([^[]+)(?:\[([^=\]]+)=([^\]]+)\])?$/.exec(parts[i]);
    if (!m) throw new Error("bad path");
    const [, key, selKey, selVal] = m;
    let next = cur[key];
    if (selKey) {
      if (!Array.isArray(next)) throw new Error("bad path");
      next = next.find((x) => String(x[selKey]) === selVal);
      if (!next) throw new Error("orphan");
    }
    if (i === parts.length - 1 && !selKey) { cur[key] = value; return; }
    if (i === parts.length - 1 && selKey) { Object.assign(next, value); return; }
    cur = next;
  }
}

/* ---------------- the chunked pack ----------------
   250,000 characters per chunk. Worst case for BMP text is 3 UTF-8 bytes per
   character, so a chunk cannot exceed ~750 KB against Firestore's 1 MiB
   document ceiling — and real packs are mostly ASCII, so a chunk is usually
   about 250 KB. Deliberately conservative: getting this wrong shows up as a
   failed import on somebody else's machine, weeks later.

   The chunk field is exempt from indexing in firestore.indexes.json. Nothing
   queries it, and indexing a quarter-megabyte string per chunk is pure waste. */
const CHUNK = 250_000;

function sliceJson(pack) {
  const s = JSON.stringify(pack);
  const out = [];
  for (let i = 0; i < s.length; i += CHUNK) out.push(s.slice(i, i + CHUNK));
  return out;
}

async function readChunkedPack(briefId, total) {
  const { fs, db, root } = store._fb;
  // Read them in one query rather than N gets, then order by index — a
  // collection read is one round trip and the order Firestore returns is
  // not guaranteed to be the order they were written.
  const snap = await fs.getDocs(fs.collection(db, root, briefId, "pack"));
  const parts = snap.docs.map((d) => d.data()).sort((a, b) => a.i - b.i);
  if (parts.length !== total) {
    throw new Error(`pack is incomplete: ${parts.length} of ${total} chunks`);
  }
  return JSON.parse(parts.map((p) => p.s).join(""));
}

async function writeChunkedPack(briefId, pack) {
  const { fs, db, root } = store._fb;
  const parts = sliceJson(pack);

  // Clear a longer previous pack first. Without this, re-importing something
  // smaller leaves the tail chunks of the old one behind, and the count check
  // in readChunkedPack starts failing on a pursuit that looks fine.
  const old = await fs.getDocs(fs.collection(db, root, briefId, "pack"));
  await Promise.all(old.docs
    .filter((d) => Number(d.data().i) >= parts.length)
    .map((d) => fs.deleteDoc(d.ref)));

  await Promise.all(parts.map((s, i) =>
    fs.setDoc(fs.doc(db, root, briefId, "pack", String(i)), { i, total: parts.length, s })));
  return parts.length;
}

/* ---------------- writes ---------------- */

/* Pack chunks first, index doc LAST — so a failed import leaves the Library
   exactly as it was rather than half-populated. The index doc is what the
   Library reads, so until it lands the pursuit does not exist. */
export async function putPursuit({ index, pack, assets }) {
  if (store.mode === "shared") {
    const { fs, db, root } = store._fb;
    index.packChunks = await writeChunkedPack(index.briefId, pack);
    await fs.setDoc(fs.doc(db, root, index.briefId), index, { merge: true });
  }
  // Bundled documents stay on this machine. They are the one thing in a pack
  // that can be the client's own property, and this site is a public URL.
  for (const [name, b] of (assets || new Map())) await idbPut("assets", b, `${index.briefId}/${name}`);
  await idbPut("packs", pack, index.briefId);
  await idbPut("pursuits", index);
  return index;
}

/* Bytes for a document carried in the bundle, or null. Null is a real answer,
   and the common one: documents live only in the importer's browser, so for
   everyone else the renderer shows the row as plain text rather than a link
   that goes nowhere. */
export async function getAssetBytes(briefId, relPath) {
  return (await idbGet("assets", `${briefId}/${relPath}`)) || null;
}

export async function updateIndex(briefId, patch) {
  const cur = (await getPursuit(briefId)) || { briefId };
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  if (store.mode === "shared" && navigator.onLine) {
    const { fs, db, root } = store._fb;
    await fs.setDoc(fs.doc(db, root, briefId), next, { merge: true });
  }
  await idbPut("pursuits", next);
  return next;
}

export async function setElement(briefId, elementId, entry) {
  if (store.mode === "shared" && navigator.onLine) {
    const { fs, db, root } = store._fb;
    await fs.setDoc(fs.doc(db, root, briefId, "elements", elementId), entry);
  }
  const list = (await idbGet("elements", briefId)) || [];
  const i = list.findIndex((x) => x.id === elementId);
  if (i >= 0) list[i] = { ...entry, id: elementId }; else list.push({ ...entry, id: elementId });
  await idbPut("elements", list, briefId);
}

/* Drop a single override. Used when deleting a row that an override itself
   added: writing a "remove" for it would leave both, and which one wins depends
   on two timestamps that are usually the same millisecond. Deleting the "add"
   is unambiguous, and it keeps the override set from growing with pairs that
   cancel each other out. */
export async function deleteElement(briefId, elementId) {
  if (store.mode === "shared" && navigator.onLine) {
    const { fs, db, root } = store._fb;
    try { await fs.deleteDoc(fs.doc(db, root, briefId, "elements", elementId)); } catch {}
  }
  const list = ((await idbGet("elements", briefId)) || []).filter((x) => x.id !== elementId);
  await idbPut("elements", list, briefId);
}

/* Replace the whole override set — how a checkpoint restore works. The baseline
   pack is never touched, so "restore to original" is just clearing overrides. */
export async function replaceElements(briefId, list) {
  if (store.mode === "shared" && navigator.onLine) {
    const { fs, db, root } = store._fb;
    const snap = await fs.getDocs(fs.collection(db, root, briefId, "elements"));
    await Promise.all(snap.docs.map((d) => fs.deleteDoc(d.ref)));
    await Promise.all(list.map((e) => fs.setDoc(fs.doc(db, root, briefId, "elements", e.id), e)));
  }
  await idbPut("elements", list, briefId);
}

export async function listActivity(briefId) {
  if (store.mode === "shared" && navigator.onLine) {
    const { fs, db, root } = store._fb;
    try {
      const snap = await fs.getDocs(fs.collection(db, root, briefId, "activity"));
      return snap.docs.map((d) => d.data()).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    } catch { /* fall through */ }
  }
  const all = (await idbAll("activity")) || [];
  return all.filter((a) => a.briefId === briefId).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/* A checkpoint snapshots the OVERRIDES, not the merged pack — the baseline
   never changes, so this is small, and restoring can't resurrect stale content
   from the imported pack. */
export async function saveCheckpoint(briefId, { label, editor, note }) {
  const overrides = await getElements(briefId);
  const cp = {
    id: "cp-" + Date.now().toString(36),
    at: new Date().toISOString(),
    label: label || "Checkpoint", note: note || "", editor: editor || "unknown",
    count: overrides.length, overrides,
  };
  if (store.mode === "shared" && navigator.onLine) {
    const { fs, db, root } = store._fb;
    await fs.setDoc(fs.doc(db, root, briefId, "checkpoints", cp.id), cp);
  }
  const list = (await idbGet("checkpoints", briefId)) || [];
  await idbPut("checkpoints", [...list, cp], briefId);
  return cp;
}

export async function listCheckpoints(briefId) {
  if (store.mode === "shared" && navigator.onLine) {
    const { fs, db, root } = store._fb;
    try {
      const snap = await fs.getDocs(fs.collection(db, root, briefId, "checkpoints"));
      if (snap.docs.length) return snap.docs.map((d) => d.data()).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    } catch { /* fall through */ }
  }
  return ((await idbGet("checkpoints", briefId)) || []).slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

export async function appendActivity(briefId, entry) {
  const row = { briefId, at: new Date().toISOString(), ...entry };
  if (store.mode === "shared" && navigator.onLine) {
    const { fs, db, root } = store._fb;
    await fs.addDoc(fs.collection(db, root, briefId, "activity"), row);
  }
  await idbPut("activity", row);
}

export async function deletePursuit(briefId) {
  if (store.mode === "shared") {
    const { fs, db, root } = store._fb;

    // Firestore does not cascade. Without this, deleting a pursuit and importing
    // the same briefId again resurrects every override and log line from the
    // deleted one — the new pursuit arrives pre-edited by someone else. "pack"
    // is in this list too: leftover chunks make the count check fail on the
    // next import, which reads as a corrupt pack rather than a stale delete.
    for (const sub of ["pack", "elements", "activity", "checkpoints", "threads"]) {
      try {
        const snap = await fs.getDocs(fs.collection(db, root, briefId, sub));
        await Promise.all(snap.docs.map((d) => fs.deleteDoc(d.ref)));
      } catch (e) { console.warn(`Could not clear ${sub} for ${briefId}.`, e); }
    }
    await fs.deleteDoc(fs.doc(db, root, briefId));
  }
  await idbDel("pursuits", briefId);
  await idbDel("packs", briefId);
  await idbDel("elements", briefId);
  await idbDel("checkpoints", briefId);
  const acts = (await idbAll("activity")) || [];
  await Promise.all(acts.filter((a) => a.briefId === briefId).map((a) => idbDel("activity", a.id ?? a.at)));
}
