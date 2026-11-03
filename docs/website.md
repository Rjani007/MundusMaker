# The MundusMaker website

`site/` is published to GitHub Pages at https://rjani007.github.io/MundusMaker/.
It has three pages:

- the home page (`site/index.html`);
- **Share a player wiki** (`site/publish/`), where a GM signs in and uploads the
  ZIP that Export → Export player wiki makes;
- the viewer (`site/wiki/?w=<id>`), where players read a published wiki without
  an account. That link stays the same when the GM updates the wiki.

The desktop app doesn't change and never talks to Supabase. The GM carries the
ZIP to the website, the same way character files travel to Elysium.

## How it works

- **Supabase project** MundusMaker, ref `zrophtozeecslvsecndo`. One migration,
  `supabase/migrations/20261103200000_player_wikis.sql`, makes the `wikis` table
  (one row per published wiki, owned by its GM) and the public `wikis` bucket.
- **Limits:** each GM may have 3 wikis and 20 MB in all, and one file may be
  3 MB. `wiki_limits()` in the migration and `LIMITS` in `site/js/wikifile.js`
  must match; `tests/site.test.js` checks that.
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
   workflow. After that, every push that changes `site/` publishes it.
2. **Its own Supabase organization (recommended):** MundusMaker's project is in
   the same organization as Elysium, and the free plan's limits (5 GB of egress
   a month, 1 GB of storage) are shared across an organization. Going over
   restricts every project in it. In the dashboard, project Settings → General
   → Transfer project moves it to a new organization; the ref, URL and key stay
   the same.
3. **Sign-in** is already set the way the site expects: the Email provider on
   and Confirm email off (the built-in mailer only reaches the project's own
   team). Once your GMs have accounts, you can stop new ones in Authentication
   → Sign In / Providers → Allow new users to sign up.

## Changing the database

Write a new migration in `supabase/migrations/`, try it locally (below), then:

```sh
npx supabase db push --remote=zrophtozeecslvsecndo --dry-run
npx supabase db push --remote=zrophtozeecslvsecndo --yes
```

The Supabase CLI aims `db push` at the local stack unless `--remote` is given.
It needs `npx supabase login` once, and no database password after that.

## Working on it locally

```sh
npx supabase start        # Docker; ports 56420-56429, beside Elysium's
npm run site              # http://localhost:4895, talking to the local stack
npm run test:site-db      # the database rules, against the local stack
npx supabase stop
```

`site/config.js` uses the local stack whenever the page is on localhost.
`npm test` includes `tests/site.test.js`, which needs no stack.

## Keeping an eye on it

- Organization → Usage in the Supabase dashboard shows egress and storage.
- A free project that goes unused for a week is paused, and published wikis
  don't load until someone presses Restore in the dashboard. Nothing is lost.
- Unpublish removes a wiki's files first, then its row. If a GM's account is
  deleted, its rows go but its files stay: delete that folder in Storage →
  wikis.
