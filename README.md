# TillTally

A household budgeting app for two people, built around one number:
**paycheck − spending − bills paid = available to spend.**

TillTally is an installable **PWA** (no app store, no fees) plus a tiny
**shared-sync backend** (a Cloudflare Worker + D1 database, free tier).
Both partners install it on their own phones, enter the same household
code, and see — and edit — the *same* household numbers. It is a rebuild,
as a portable GitHub project, of the TillTally app originally made as a
Muse artifact; the feature set and money math are the same.

The app starts **empty** — no sample paychecks, no demo money. It also
runs fine with no backend at all (local-only mode, below).

## Live deployment (deployed 2026-11-12)

| Piece | URL / id |
|---|---|
| **App (install this)** | https://tilltally.pages.dev |
| Sync API (Worker) | https://tilltally-api.haydenlockwood.workers.dev |
| Database | D1 `tilltally` — `d15794fa-c82e-4e11-86ee-2c8dca8a6730` |

The Worker URL is already baked into `config.js`, so on each phone you
only need the household code (Step 3). The household code itself is a
shared secret and is deliberately **not** written in this repo.

## Updates — no reinstalls, ever

Installed apps update themselves:

1. Push to `main` (or run the workflow manually).
2. GitHub Actions runs the tests, redeploys the Worker, and deploys the
   frontend via `scripts/deploy-pages.sh`, which **stamps a unique
   version** (the git short hash) into the service worker's cache name
   and into the app's version line.
3. On each phone, the app checks for a new service worker when it opens
   and whenever it returns to the foreground. A new worker activates
   immediately and the app reloads itself once onto the new version.
   **Nobody reinstalls anything.** Check Settings → About to see the
   currently running version — it changes when an update lands.

**One-time GitHub setup for the owner** (needed once, before pushes can
auto-deploy): in this repo go to **Settings → Secrets and variables →
Actions → New repository secret** and add:

- `CLOUDFLARE_API_TOKEN` — a Cloudflare API token with Workers, Pages
  and D1 edit permissions on the account
- `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account id

Until those two secrets exist, pushes still land on GitHub but the
deploy workflow can't reach Cloudflare; deploy by hand meanwhile with
`scripts/deploy-pages.sh` (and `npx wrangler deploy` in `worker/`).

## Features

- **Two funds, one till.** Add paychecks for each person (labels default
  to "You" and "Girlfriend", renameable). The Till tab leads with the
  combined available-to-spend total, with each person's separate fund
  underneath: their paychecks − their spends − their paid bills.
- **Paychecks** carry an amount, a date, and an optional next-paycheck
  date. The household's "next paycheck" is the soonest next-paycheck date
  entered for either person.
- **Spends** are logged by amount, note, category — and **which person's
  fund the money comes out of**.
- **Categories** start as Food, Rent, Utilities; add your own, delete
  ones you don't use. The Spend tab shows total spent and entry count
  per category.
- **Automatic bills**: name, amount, category, which fund, frequency
  (weekly / every 2 weeks / monthly), first due date. A bill deducts
  itself from its fund on each due date — but only from the day it was
  set up onward, so back-dating a first due date never invents past
  payments. Pause, resume, or delete any bill.
- **Bills tab** answers one question up top: *"N bills · $X due before
  the next paycheck"*, counting every bill occurrence due on or before
  the next paycheck date, with per-bill next due dates in the list.
- **Activity feed**: paychecks, spends, and automatic bill payments,
  newest first, with delete for anything you entered by hand.

## Cost breakdown — $0

| Piece | What | Cost |
|---|---|---|
| Frontend hosting | GitHub Pages or Cloudflare Pages free tier | $0 |
| Sync backend | Cloudflare Workers free tier (100k requests/day) | $0 |
| Database | Cloudflare D1 free tier (5 GB, 5M row reads/day) | $0 |
| Phones | PWA install — no Apple Developer ($99/yr) or Play Console ($25) account | $0 |
| **Total** | | **$0** |

## Repository layout

```
index.html            PWA shell and all four tabs (Till / Spend / Bills / Settings)
app.js                Frontend logic, local mode, and sync client
core.js               Shared money math — used by the frontend AND the tests
config.js             Optional default Worker URL (can stay empty; see Settings)
styles.css            Styling
manifest.webmanifest  PWA manifest (installability)
sw.js                 Service worker: caches the app shell for offline opening
icon.svg              App icon (hand-drawn SVG shapes, no external art)
worker/
  worker.js           Cloudflare Worker: household codes + shared state API
  schema.sql          D1 schema (one table: households)
  wrangler.toml       Worker config template (fill in your D1 database id)
tests/
  core.test.cjs       Node test of the core math (npm test)
scripts/
  deploy-pages.sh     Pages deploy with auto-stamped service-worker version
.github/workflows/
  deploy.yml          On push to main: test + deploy Worker and Pages
```

## Try it locally first (no accounts, no deploy)

```bash
npm test                  # proves the money math (see below)
npm run serve             # then open http://localhost:8080
```

With no Worker URL configured, the app runs in **local-only mode**: data
lives in that browser's storage. Good for trying it on one device before
deploying anything. (For a real phone trial over your home network,
serve it on your computer and open the computer's LAN address on the
phone — note PWA *installation* requires HTTPS, which the deploys below
give you; local mode in a browser tab works without it.)

## Step 1 — Deploy the sync backend (Cloudflare, free)

> **Already done for the live instance above** — the D1 database exists,
> the schema is applied, and the Worker is deployed. These steps are for
> standing up a fresh copy (or a second household's backend).

You need a free Cloudflare account and Node.js installed.

```bash
cd worker
npm install -g wrangler        # or: npx wrangler ... for each command
npx wrangler login             # opens a browser to sign in to Cloudflare
npx wrangler d1 create tilltally
```

Wrangler prints a `database_id`. Paste it into `worker/wrangler.toml`,
replacing `REPLACE_WITH_YOUR_D1_DATABASE_ID`. Then:

```bash
npx wrangler d1 execute tilltally --remote --file=./schema.sql
npx wrangler deploy
```

Wrangler prints your Worker URL, something like
`https://tilltally-api.<your-subdomain>.workers.dev`. Keep it for Step 3.
Check it works by opening it in a browser — you should see
`{"ok":true,"service":"tilltally"}`.

## Step 2 — Host the frontend

> **Already done for the live instance**: a Cloudflare Pages project
> named `tilltally` serves the app at https://tilltally.pages.dev,
> deployed by direct upload (`scripts/deploy-pages.sh`). For a fresh
> copy, pick either option; both are free and give you the HTTPS that
> PWA installation requires.

**Option A — GitHub Pages**
1. Push this repo to GitHub.
2. In the repo: **Settings → Pages → Build and deployment → Source:
   Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Your app is at `https://<your-username>.github.io/<repo-name>/`.

**Option B — Cloudflare Pages**
1. Push this repo to GitHub.
2. In Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**,
   pick the repo. Framework preset: **None**. Build command: leave
   empty. Output directory: `/` (root).
3. Your app is at `https://<project>.pages.dev`.

## Step 3 — Pair both phones with one household

Do this once; both phones then share one dataset.

For the **live instance**, the Worker URL is already baked into the app
(`config.js`), so pairing is just the code:

1. On **your** phone, open https://tilltally.pages.dev, go to
   **Settings**.
2. Enter the household code the owner created for you in the
   **Household code** field (the Worker URL is pre-filled), tap
   **Save & connect**.
3. On **her** phone, open the same app, go to **Settings**, enter the
   **same code**, tap **Save & connect**.
4. Add a test paycheck on one phone, then open the app on the other —
   it should appear there. You're paired.

(On a fresh self-hosted copy where no code exists yet: paste your
Worker URL in Settings and tap **Create a new household code** on the
first phone, then use that code on the second.)

⚠️ The code is effectively the key to the household's numbers: anyone
with the Worker URL and the code can read and write them. Fine for a
household; don't post the code publicly.

**Sync model, honestly:** the Worker stores one whole dataset per
household and the app syncs whole-dataset, *last write wins*. Phones
re-pull when the app opens and push after every change, so in normal
turn-taking use you always converge. If both of you edit at the exact
same moment on both phones, the later save wins — pull (reopen, or
Settings → **Sync now**) before editing if you're both in the app.

## Step 4 — Install on each phone

**Android (Chrome)**
1. Open the hosted URL in Chrome.
2. Menu (⋮) → **Install app** (or "Add to Home screen"), confirm.
   TillTally now has an icon and opens full-screen like a native app.

**iPhone (Safari)**
1. Open the hosted URL in **Safari** (must be Safari, not Chrome).
2. **Share** button → **Add to Home Screen** → Add.
   TillTally appears on the home screen and opens full-screen.

## Tests

```bash
npm test
```

Runs `core.js` through a scripted scenario in Node: two paychecks
($850 / $600), a $42 Food spend out of the first fund, a $95 monthly
bill, and a $10 weekly bill due that day. Expected — and asserted —
results: **You $808 · Girlfriend $590 · Combined $1,398**, the weekly
bill has paid exactly once, and the bills-due-before-next-paycheck
summary reads **2 bills · $105**. The suite also asserts the rule that a
back-dated first due date invents no past payments, pause/resume
behaviour, category totals, and renaming.

## Notes & limits

- Manual entry by design — no bank connections, no transaction feeds.
- Bills keep paying (in the math) while the app is closed; amounts are
  computed from due dates whenever the app opens, nothing runs in the
  background and nothing is charged anywhere — it's a tally, not a
  payment service.
- Local-only mode data lives in the browser; clearing site data clears
  the till. Synced mode keeps the shared copy on D1 as the source of
  truth, with each phone's local copy as an offline cache.
