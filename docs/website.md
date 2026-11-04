# The MundusMaker website

`site/` is published to GitHub Pages at https://rjani007.github.io/MundusMaker/.
It has four parts:

- the home page (`site/index.html`);
- **MundusMaker in the browser** (`app/`), the same app as the GitHub release,
  for GMs who sign in instead of installing it (see below);
- **Share a player wiki** (`site/publish/`), where a GM signs in and uploads the
  ZIP that Export → Export player wiki makes;
- the viewer (`site/wiki/?w=<id>`), where players read a published wiki without
  an account. That link stays the same when the GM updates the wiki.

The desktop download doesn't change and never talks to Supabase. Only the
website's own pages do: the publish page, and the shell around the app in
`web/`. The app's code in `public/` is the same in both and makes no calls of
its own to Supabase.

The home page, the publish page and the app's top bar each have a
"Buy me a coffee" link to Ko-fi. It is a plain link, so nothing loads from
Ko-fi until it is clicked. Its address is in `public/index.html`,
`site/index.html`, `site/publish/index.html` and `web/boot.js`; search for
`ko-fi.com/` to change all four.

## MundusMaker in the browser

The app runs entirely in the GM's browser tab. Its own `server.js` runs in a
Web Worker on the phone apps' Node compatibility layer
(`mobile/shared/runtime/node.js`, see docs/android-plan.md), so every feature
of the release works the same way, from maps to PDF export.

- **`web/boot.js`** (the page) registers the service worker, signs the GM in
  through the website's own sign-in (`site/js/supa.js`, shared with the publish
  page), makes sure no other tab has the same account's worlds open (Web
  Locks), starts the engine and then loads the app's `main.js`.
- **`web/sw.js`** (the service worker) catches the app's requests to `/api/`
  and `/assets/` and hands them to the engine of the tab that asked. Only this
  app's own pages are answered, navigations are never relayed, and the app's
  pages get `X-Frame-Options: DENY`, which GitHub Pages can't send itself.
  Everything else is served from the website and kept for offline use.
- **`web/engine.js`** runs `server.js` with `MUNDUSMAKER_DEPLOYMENT=web`, which
  switches off the desktop's folder, quit and upgrade tools the way the phone
  apps' `mobile` mode does.
- **`web/memfs.js`** holds the app's folders in memory and answers like the
  phone apps' file host (tests/web-memfs.test.js checks them side by side).
  **`web/store.js`** keeps them in IndexedDB, one database per account. Big
  files, the trash, snapshots and history stay on disk as Blobs until they are
  read. Every answer waits until the request's changes are in IndexedDB, so
  "Saved" means saved in this browser.
- **`web/sync.js`** and **`web/cloud.js`** keep a GM's worlds the same in every
  browser they sign in to. Each world's `world.json`, entries and pictures
  travel; history, exports, the trash, snapshots and library packs stay in the
  browser that made them. A change is sent with the revision it was based on,
  and the account refuses it if the file moved on since. When an entry changed
  in two browsers, both versions are kept: the other one becomes a
  "MundusMaker sync copy" beside it, which the app shows like a folder-sync
  conflict and lets the GM compare and adopt. A file deleted in one browser
  goes to the other's trash, where Settings → Recover finds it, and an edit
  always outlives a deletion.

What GMs see: a ☁ badge beside Saved (Synced, Syncing, Offline, Storage
full…), an account panel in Settings (sign out, optionally removing the
browser's copy, and how much of the allowance is used), and a bar when changes
from another browser arrive. The app opens offline from the browser's copy,
except the first time on a new device, which has to fetch the worlds first.

**Limits:** each GM may keep 100 MB in their account, 20 MB per file and
20,000 files. `sync_limits()` in the migration and `LIMITS` in `web/sync.js`
must match, and so must `sync_path_ok()` and `PATH_RE`; `tests/site.test.js`
checks both. Objects nothing uses any more are removed a day after they were
stored.

**On a shared origin:** rjani007.github.io also serves Elysium, and a page of
one can read the other's browser storage, sign-ins included. The app's page
has a Content-Security-Policy that allows only its own scripts, but moving the
website to a domain of its own (see Hosting) is the cleaner separation.

### What the browser can't do

- Downloads the server makes for the GM (5etools packs, publisher sheets)
  work only from sites that let other web pages download from them. GitHub's
  do; the publishers' sheet PDFs usually don't, and the dialog then says to
  download the file and pick it instead.
- Check for updates is hidden: the website always runs its newest version, and
  a tab that is open during an update offers to reload.
- Library packs and official sheet templates stay in the browser they were
  added in.
- Password reset needs a mail server. The hosted project uses Supabase's
  built-in mailer, which only reaches the project's own team, so a GM who
  forgets their password can't reset it yet. Setting up SMTP in Authentication
  → Emails fixes that, and lets you turn Confirm email back on.

## How the backend works

- **Supabase project** MundusMaker, ref `zrophtozeecslvsecndo`. Two migrations:
  - `supabase/migrations/20261103200000_player_wikis.sql` makes the `wikis`
    table (one row per published wiki, owned by its GM) and the public `wikis`
    bucket;
  - `supabase/migrations/20261104120000_world_sync.sql` makes `sync_files` (one
    row per synced file), `sync_heads` (each GM's latest revision), the private
    `sync` bucket (objects named `<user id>/<sha256>`) and `sync_commit()`,
    the only way rows change.
- **Wiki limits:** each GM may have 3 wikis and 20 MB in all, and one file may
  be 3 MB. `wiki_limits()` in the migration and `LIMITS` in
  `site/js/wikifile.js` must match; `tests/site.test.js` checks that.
- **Only wiki files:** storage accepts just the file names a player wiki has
  (`wiki_file_name_ok`). Pages and the search index are stored as `text/plain`,
  so a page opened straight from storage shows as text, not as a site.
- **Pictures** are shrunk in the publish page before upload: longest side
  2400 px, WebP at 0.85 when that is smaller. A picture's name is a hash of the
  original, so updating a wiki uploads only its pages and new pictures, and a
  player's browser keeps each picture for a year.
- **The viewer** fetches each page as text and shows it in a sandboxed frame
  with no origin of its own, because rjani007.github.io also serves Elysium and
  an uploaded page must never reach either site's sign-in. It removes every
  uploaded script and adds its own: the search from `public/wiki/wiki.js`
  (copied to `site/wiki/search.js` when the site is published) and the link
  handling. The frame's Content-Security-Policy lets it load only the
  stylesheet and pictures from storage.

## One-time setup

1. **GitHub Pages:** in the repository, Settings → Pages → Build and deployment
   → Source: **GitHub Actions**. Then Actions → Publish the website → Run
   workflow. After that, every push to `main` that changes the site or the app
   publishes both. The workflow runs `node scripts/stage-web.js site/app`,
   which copies `public/`, `web/`, the runtime and what `server.js` needs into
   `site/app/` (git-ignored).
2. **The sync tables:** apply the world sync migration to the hosted project
   before the app goes live (see Changing the database). Without it the app
   still opens, but every sync fails.
3. **Its own Supabase organization:** the free plan's limits (5 GB of egress a
   month, 1 GB of storage) are shared across an organization, and going over
   restricts every project in it. So the project has an organization of its
   own, Mundusmaker - web, apart from Elysium's. Project Settings → General →
   Transfer project moved it there; the ref, URL and key stayed the same.
4. **Sign-in** is already set the way the site expects: the Email provider on
   and Confirm email off (the built-in mailer only reaches the project's own
   team). You can stop new accounts in Authentication → Sign In / Providers →
   Allow new users to sign up.

## Changing the database

Write a new migration in `supabase/migrations/`, try it locally (below), then:

```sh
npx supabase db push --remote=zrophtozeecslvsecndo --dry-run
npx supabase db push --remote=zrophtozeecslvsecndo --yes
```

The Supabase CLI aims `db push` at the local stack unless `--remote` is given.
It needs `npx supabase login` once, and no database password after that. On
the local stack, `npx supabase migration up` applies a new migration and
`npx supabase db reset` rebuilds the database from all of them (it removes the
local test accounts).

## Working on it locally

```sh
npx supabase start        # Docker; ports 56420-56429, beside Elysium's
npm run site              # http://localhost:4895, talking to the local stack
npm run test:site-db      # the database rules, against the local stack
npx supabase stop
```

`npm run site` serves `app/` straight from the repo through the same file list
the workflow stages, so no copy goes stale. `site/config.js` uses the local
stack whenever the page is on localhost. `npm test` includes
`tests/site.test.js` and the browser app's `tests/web-*.test.js`, which need no
stack: they boot the real `server.js` on the browser file host and sync two
simulated browsers against a fake account.

## Hosting

Everything the website serves is static files, so any static host works:
GitHub Pages now, and Cloudflare Pages or Netlify (both have free plans and
custom domains) for a domain of its own. Upload `site/` after
`node scripts/stage-web.js site/app`. The app needs no special server headers;
the service worker adds the ones it needs. A new domain needs no code change,
but keep `site/config.js` and `CONNECT` in `scripts/stage-web.js` pointing at
the same Supabase project.

What costs money as the site grows is Supabase: worlds and wikis use its
storage, and every browser that downloads them uses egress. The Usage page of
the Mundusmaker - web organization shows both, and the per-GM limits above
keep any one account small.

## Keeping an eye on it

- The Usage page of the Mundusmaker - web organization shows egress and
  storage.
- A free project that goes unused for a week is paused. Published wikis don't
  load and the app can't sync until someone presses Restore in the dashboard;
  the app keeps working on each browser's copy meanwhile. Nothing is lost.
- Unpublish removes a wiki's files first, then its row. If a GM's account is
  deleted, its rows go but its files stay: delete that folder in Storage →
  wikis, and in Storage → sync.
