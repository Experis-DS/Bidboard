# Bid Board — the internal RFP brief site

Scaffolded by the `/GO` skill. **Run `/GO` once per team, not once per pursuit.**

Static site, no build step, no server. `index.html` loads ES modules directly, so what is
in this repo is what ships.

```
index.html               shell
app.js                   router + Library + Import + brief chrome + analytics
app.css                  shell styles
store.js                 Firestore + Storage, with IndexedDB fallback / offline cache
schema.js                pack validation + forward migration
unzip.js                 dependency-free zip reader (DecompressionStream)
renderer/                THE VERSIONED RENDERER — see below
config.json              hub name, version, baseUrl, GA4 measurement ID
firebase.config.json     paste the web config here to turn on shared storage
firestore.rules          \
storage.rules             |  deployed with the Firebase CLI, not with Pages
firebase.json             |
firestore.indexes.json   /
skills/                  hosted skill downloads + index.json
.github/workflows/       Pages deploy
```

---

## 1 — Publish to GitHub Pages

The repo is `Experis-DS/PursuitBrief`. Rename it first, so the Pages URL matches the
product name. GitHub redirects the old *repo* URL forever, but it does **not** redirect the
old *Pages* URL — rename before you share the link with anyone.

**Settings → General → Repository name → `bid-board` → Rename.**

Then, in your terminal:

```bash
cd <this folder>
git init
git add -A
git commit -m "Bid Board — initial deploy"
git branch -M main
git remote add origin https://github.com/Experis-DS/Bidboard.git
git push -u origin main
```

**Set the Pages source *before* you look at the site:**

**Settings → Pages → Build and deployment → Source → “GitHub Actions”.**

GitHub defaults to “Deploy from a branch”, which serves the raw repo and works by accident
until it doesn't. If you pushed before switching it: **Actions → “Deploy Bid Board” → Run
workflow.**

The site lands at **https://experis-ds.github.io/Bidboard/**

The workflow stamps `baseUrl` into `config.json` from the live Pages URL on every deploy —
you never maintain it by hand. Copy that URL into the `/RFP` skill as `BRIEF_SITE_URL`.
That constant is the only coupling between the two skills.

Note the repo must be **public** for Pages to serve it on a normal GitHub plan. That is the
access model you chose: unlisted URL, no sign-in. Read §4 before real client content goes in.

---

## 2 — Firebase: shared edits, activity log, checkpoints

Without this, the site works but every person's imports and edits live only in their own
browser. With it, everyone sees the same board.

You said you already have a Firebase account. Roughly ten minutes:

### 2.1 Create the project

1. https://console.firebase.google.com → **Add project** → name it `bid-board`
   (lowercase — Firebase project IDs cannot contain capitals, so this one does not
   match the repo name, and that is fine; nothing links them)
   (or reuse `experis-microsite-comments` — the site namespaces everything under a
   `pursuits/` root, so it will not collide with what's already in there).
2. Google Analytics for the *Firebase project*: **skip it.** GA4 for the site is wired
   separately in §3 and doubling up gives you two properties reporting different numbers.

### 2.2 Firestore

1. **Build → Firestore Database → Create database**
2. Location: **`eur3` (europe-west)** if the team is EMEA — most of these pursuits are.
   This is permanent; you cannot move a database region later.
3. Start in **production mode**. The rules in this repo replace the default ones in 2.5.

### 2.3 Storage

1. **Build → Storage → Get started** → same location as Firestore.
2. Storage holds `pack.json` per pursuit plus thumbnails. Firestore documents cap at
   1 MiB and a thumbnail-heavy pack blows past that, which is why the two are split.

### 2.4 Register the web app and paste the config

1. **Project settings (gear) → General → Your apps → Web (`</>`)**
2. Nickname `bid-board`. **Do not** tick “Also set up Firebase Hosting” — the site is on
   GitHub Pages.
3. Copy the `firebaseConfig` object it shows you and paste the values into
   `firebase.config.json` in this repo, replacing every `PASTE_…`:

```json
{
  "apiKey": "AIza…",
  "authDomain": "bid-board.firebaseapp.com",
  "projectId": "bid-board",
  "storageBucket": "bid-board.firebasestorage.app",
  "messagingSenderId": "1234567890",
  "appId": "1:1234567890:web:abc123",
  "hubCollection": "pursuits"
}
```

This config is **public by design** — it ships in the page source of every Firebase web app
and is not a secret. What protects the data is the rules file, not this. Commit it.

Copy `storageBucket` exactly as the console prints it. New projects use
`…firebasestorage.app`; older ones use `…appspot.com`. Getting this wrong fails silently —
the Library loads, and pack uploads die.

### 2.5 Deploy the rules

```bash
npm install -g firebase-tools
firebase login
firebase use --add            # pick the project, alias it "default"
firebase deploy --only firestore:rules,storage
```

Read `firestore.rules` before you run that. The short version: **the rules are open.**
There is no sign-in in this build, so there is no identity for a rule to test. What the file
does add is a hard expiry date (31 Dec 2026), shape validation, size caps, and an
append-only constraint on the activity log so an audit trail can't be quietly rewritten.

### 2.6 CORS for Storage

Pack downloads are `fetch`ed from a `github.io` origin, which Storage will block by default.

```bash
cat > cors.json <<'EOF'
[{ "origin": ["https://experis-ds.github.io"], "method": ["GET"], "maxAgeSeconds": 3600 }]
EOF
gcloud storage buckets update gs://YOUR_BUCKET --cors-file=cors.json
```

`YOUR_BUCKET` is the `storageBucket` value from §2.4. If `gcloud` isn't installed, the
Cloud Shell in the Google Cloud console has it. **Skip this and briefs will open with an
empty body and a CORS error in the console** — it is the single most common way this
deploy fails.

### 2.7 Confirm

Push, wait for the Action, open the site. The pill in the header should read **Shared**
instead of **Local only**. Import a pursuit in one browser, open the site in another —
it should be there. Then open a brief, hit **Edit**, change an owner, and check the
activity panel from the second browser.

---

## 3 — GA4

`config.json` has an `analytics.measurementId` field. **Leave it empty and no Google script
is requested at all** — that is how it ships.

1. https://analytics.google.com → **Admin → Create → Property**, name `Bid Board`.
2. Add a **Web** data stream for `https://experis-ds.github.io`.
3. Copy the **Measurement ID** (`G-XXXXXXXXXX`) into `config.json`:

```json
"analytics": { "measurementId": "G-XXXXXXXXXX" }
```

4. Commit and push.

**What gets sent.** Client names are the sensitive part of a URL here, so `page_view` is
sent with a normalised path — `/brief`, never `/b/allianz-partners`. You get section and
funnel data; GA never learns who Experis is bidding for. Three named events fire:
`pursuit_import`, `edit_open` / `edit_close`, and `checkpoint_save`. None carries a client
name, a brief id, or any field content.

The preview build never loads analytics regardless of config.

One thing to settle with whoever owns privacy at Experis: this is an internal tool, but GA4
still sets cookies and still sends data to Google. `anonymize_ip` is on. There is no consent
banner. If that needs to change, the alternative is counting page views into the Firestore
project you already have — no vendor, no cookie.

---

## 4 — Access, honestly

Unlisted URL, no sign-in, public repo, open Firestore rules. **Anyone with the link reads
every brief.** So, for the pilot:

- No Experis rate or pricing data in a pack.
- `docLinks: hosted` — which carries the client's own documents into Storage — is a
  per-pursuit decision, never the default.
- A Storage download URL is a bearer token. If a client document is uploaded by mistake,
  **delete the object**; tightening rules afterwards does not revoke URLs already issued.
- The owner-skills password on the Skills page (`experis`) is cosmetic friction. The
  `.skill` files sit at static URLs. Do not describe it as protection.

**Before the first real client RFP goes in:** add Firebase Auth (Google, restricted to the
Experis domain), gate the app behind it, and change `open()` in both rules files to
`request.auth != null`. That is roughly half a day and it is the line between an internal
tool and a public one.

---

## The renderer is the important part

`renderer/` draws a brief from a pack. It has two consumers:

1. this site, and
2. `/RFP`, which fetches `renderer/renderer.js` + `renderer/renderer.css` at build time and
   inlines them into the standalone `CLIENT-RFP-Brief.html`.

**Improve the brief here and redeploy — every hosted pursuit re-renders.** Packs are data;
nothing needs re-importing. That is the whole reason the renderer lives in this repo and
not inside a skill.

Never fork the renderer per pursuit. If you need a per-pursuit difference, it belongs in
the pack.

## Editing, activity, checkpoints

Edits never write into the imported pack. Each change becomes an override document at
`pursuits/{briefId}/elements/{id}`, and what you see is baseline + overrides applied in
timestamp order. Three things follow from that:

- **Re-import is non-destructive.** A newer pack from `/RFP` replaces the baseline; the
  team's edits survive on top of it.
- **A checkpoint is small.** It snapshots the override set, not the merged brief, so
  restoring can't resurrect stale content from the pack.
- **Derived numbers stay honest.** Readiness, critical path and owner load are pure
  functions of the merged pack, recomputed after every edit rather than stored.

Entering Edit mode saves a "Session start" checkpoint automatically. Restore is in the
`⋯` menu, and "The original import" discards every edit ever made.

## Seeing it without deploying anything

```bash
node ../tools/build-preview.js
```

Produces one self-contained `bid-board-preview.html` with sample pursuits baked in.
Double-click it — no server, no install. It is a build of this exact source, so it cannot
drift from what deploys.

## Local development

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080. With no Firebase config the site runs in **Local only**
mode against IndexedDB — fully usable for testing import, editing and rendering.

Opening `index.html` directly off disk also works: `fetch` and IndexedDB are unavailable on
`file://`, so the store falls back to memory for the session and the site says so.

## Firestore layout

```
pursuits/{briefId}                    index doc — the Library reads only this
pursuits/{briefId}/elements/{id}      live edits, layered over the imported pack
pursuits/{briefId}/activity/{id}      audit trail, append-only
pursuits/{briefId}/checkpoints/{id}   snapshots of the override set
Storage  pursuits/{briefId}/pack.json  and  /assets
```

Firestore does not cascade deletes. `deletePursuit()` clears all three subcollections
explicitly — without that, deleting a pursuit and re-importing the same `briefId` would
resurrect every override from the deleted one.
