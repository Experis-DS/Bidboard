/* Pack validation + forward migration.
   Import validates COMPLETELY before anything is written. There is no
   partial load: a pack either becomes a pursuit or it is refused with a
   plain-language reason a non-technical runner can act on. */

export const MIN_SCHEMA = 1;
export const CURRENT_SCHEMA = 3;

/* Ordered forward migrations: index i migrates version i+1 -> i+2 */
const MIGRATIONS = [
  // 1 -> 2 : action items moved from `tasks` to `actionItems`
  (p) => { if (p.tasks && !p.actionItems) { p.actionItems = p.tasks; delete p.tasks; } return p; },
  // 2 -> 3 : bid signals became objects with a basis + source
  (p) => {
    const fix = (a) => (a || []).map((x) => (typeof x === "string" ? { basis: x, source: "" } : x));
    if (p.signals) { p.signals.red = fix(p.signals.red); p.signals.green = fix(p.signals.green); p.signals.beige = fix(p.signals.beige); }
    return p;
  },
];

const isSlug = (s) => typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,63}$/.test(s);

/* Returns { ok, pack, summary } or { ok:false, reason, hint } */
export function validate(raw) {
  if (!raw || typeof raw !== "object")
    return fail("That file isn't a pursuit pack — it didn't contain any pack data.");

  const v = Number(raw.schemaVersion);
  if (!v)
    return fail("That file has no schema version, so it wasn't made by /RFP.",
      "Run /RFP on the source documents and import the zip it produces.");

  if (v > CURRENT_SCHEMA)
    return fail(`This pack was made by a newer version of /RFP than this site can read (pack v${v}, site reads up to v${CURRENT_SCHEMA}).`,
      "The site needs redeploying — ask whoever owns it to run /GO again.");

  if (v < MIN_SCHEMA)
    return fail(`This pack is too old to read (v${v}; the oldest supported is v${MIN_SCHEMA}).`,
      "Re-run /RFP with the current skill and import the new zip.");

  let pack = structuredClone(raw);
  for (let from = v; from < CURRENT_SCHEMA; from++) pack = MIGRATIONS[from - 1](pack);
  pack.schemaVersion = CURRENT_SCHEMA;

  if (!pack.client || typeof pack.client !== "string")
    return fail("The pack has no client name.", "Re-run /RFP and confirm the client when it asks.");

  if (!isSlug(pack.briefId))
    return fail("The pack has no usable pursuit id.",
      "briefId must be a lowercase slug like allianz-partners — re-run /RFP to regenerate it.");

  const hasContent = (pack.ask && pack.ask.summary) || (Array.isArray(pack.requirements) && pack.requirements.length);
  if (!hasContent)
    return fail("The pack is empty — no summary and no requirements.",
      "This usually means /RFP couldn't read the source documents. Check the Document Map in the brief it produced.");

  const n = (a) => (Array.isArray(a) ? a.length : 0);
  return {
    ok: true,
    pack,
    migratedFrom: v < CURRENT_SCHEMA ? v : null,
    summary: {
      client: pack.client,
      briefId: pack.briefId,
      title: pack.title || "",
      deadline: pack.submission?.date || null,
      stage: pack.stage || "ingested",
      counts: {
        requirements: n(pack.requirements),
        actionItems: n(pack.actionItems),
        questions: n(pack.questions),
        documents: n(pack.documents),
        risks: n(pack.risks),
      },
      generatedAt: pack.generatedAt || null,
      docLinks: pack.docLinks || "local",
      carriesSourceDocs: n(pack.documents) > 0 && pack.docLinks === "hosted",
    },
  };
}

const fail = (reason, hint) => ({ ok: false, reason, hint: hint || "" });

/* One clamped line for the Library card. Never invented — first sentence of the ask. */
export function askLine(pack) {
  const s = pack.ask?.summary || pack.title || "";
  const first = String(s).split(/(?<=[.!?])\s/)[0] || "";
  return first.length > 160 ? first.slice(0, 157) + "…" : first;
}
