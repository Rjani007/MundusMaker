# MundusMaker

A worldbuilding wiki for tabletop GMs that runs on your own computer or server.
Your campaign is a folder of plain text files on your disk. There's no hosted
service or subscription. The desktop app stays local; optional Docker hosting
lets your browsers connect to your own NAS using a DM password.

Version **1.9.0** starts without a console window (a tray icon on Windows;
Quit sits at the top right of the app), exports a player wiki, adds session
prep tools and keyboard-friendly character sheets, and fills the publishers'
own character sheets: the free D&D 2024 and Call of Cthulhu sheets download
from the publishers when you ask, and Vampire sheets open in a layout
arranged like Renegade's V5 sheet.
Version **1.8.1** fixes the Mac app's `NSNull count` startup error and adds
[Docker / NAS hosting](docs/docker.md). See the [patch notes](docs/1.8.1-release.md).
Version **1.8.0** brings new world geography, detailed linked provinces, towns
with streets and working districts, safer map editing, and a printable handout
workshop. See the [release notes](docs/1.8.0-release.md). Character creation,
level advancement, system sheets, custom categories and DM Screen references
from [1.7.0](docs/1.7.0-release.md) remain included.

The reason it exists: I wanted a campaign wiki where GM secrets are part of the
design instead of an afterthought. Any paragraph, relationship, or map marker
can be marked secret. Whole entries can be GM-only. When you export a handbook
for your players, all of that is stripped out, and there's a toggle in the top
bar that shows you exactly what the players would see before you hit export.

## Getting started

Saving, conflict recovery, and backup restore are described in the
[data-safety guide](docs/data-safety.md). If a save fails, keep the page open:
the GM warning lets you download pending edits before reloading.

Download **`MundusMaker-x.y.z.zip`** and extract the whole folder. One download
works on Windows, Mac and Linux; the launchers choose the bundled runtime for
your computer automatically. No separate Node installation is needed.

**Windows:** double-click `Start-MundusMaker.bat`. Your browser opens by itself.
MundusMaker runs in the background with an icon in the Windows tray, so closing
the browser doesn't stop it. Quit it from that icon or from Settings; saves in
progress finish first. `MundusMaker-Console.bat` runs it in a window that shows
every message, for troubleshooting. Requires Windows 10 or later on x64.

**Mac:** move **MundusMaker.app** to Applications and double-click it.
It includes both Apple silicon and Intel runtimes. The familiar
`Start-MundusMaker.command` is also included as a shortcut to the app.
The **MM** menu opens the browser, shows the startup log and quits the server.
Normal startup does not use Terminal. These builds require macOS 13.5 or later.
Unsigned tester builds may need a one-time **Privacy & Security → Open Anyway**
approval following [Apple’s instructions](https://support.apple.com/en-us/102445).
Worlds and settings live in `~/Library/Application Support/MundusMaker`, outside
the app, so replacing the app preserves them. Use Import to copy worlds from
an older portable Mac installation, or select an existing custom data folder
in Settings.

If 1.7 or 1.8 reported **`-[NSNull count]: unrecognized selector`**, replace
the old app with the 1.8.1 app and open it from Finder. This fixes a native
launcher argument; installing another Node version or changing your worlds
is unnecessary. The app remains unsigned, so the one-time macOS approval above
may still apply.

**Linux:** run `start-mundusmaker.sh`; it selects Intel/AMD x64 or ARM64
automatically and starts MundusMaker in the background, so the terminal can be
closed. Quit it from Settings. `--install-desktop` adds an applications-menu
entry; `--foreground` keeps it in the terminal. The ZIP preserves executable permissions for the script and
runtimes. Requires glibc 2.28+ and kernel 4.18+. **README-FIRST.html** includes
startup and upgrade instructions for every system.

**Upgrading:** extract the new version next to the old folder and start it. On
its first start it copies your worlds from the older MundusMaker beside it and
tells you what came along; when that's ambiguous (several old folders, a synced
data folder, or the old one still running) it asks instead. The old folder is
never changed.

**Docker / NAS:** the same download includes `Dockerfile`, `compose.yaml`, and
the [hosting guide](docs/docker.md). Set a password file, then build with
`docker compose up -d --build`. A persistent volume holds your worlds, assets,
library and recovery history. Use the same server address on each device.
Access away from home goes through your private VPN or an HTTPS reverse proxy;
the supplied port mapping starts on the NAS's loopback interface. Everyone
with the password has full DM access, including GM secrets.

If you'd rather not use a browser tab, Edge and Chrome have an
install icon at the right end of the address bar, and clicking it gives
MundusMaker its own window and a Start Menu entry. There's also an
`Install-MundusMaker.bat` that copies the app somewhere permanent and makes
proper shortcuts (its uninstaller leaves your worlds alone), and a
`MundusMaker-Tray.ps1` that tucks the server behind a tray icon instead of a
console window. All of that is optional. The zip and the bat file are enough
to play.

Upgrading from an old Loreweave? Unzip the new build anywhere and open the
Import page. It finds your old install and copies your worlds across, and it
never touches the original, so you can always go back.

Running from source instead needs Node.js (free, from [nodejs.org](https://nodejs.org),
the LTS button). Then:

- Windows: double-click `Start-MundusMaker.bat`
- macOS: double-click `Start-MundusMaker.command` (if macOS refuses, open a
  terminal and run `bash "Start-MundusMaker.command"` once)
- Linux: `sh start-mundusmaker.sh`
- or just `node server.js [dataFolder] [port] [--no-open]`

First run loads a small sample world called The Sundered Reach. Poke around in
it to see how things fit together, then create your own world from the
dropdown in the top-right corner. The Help tab inside the app covers the rest.

## What it does

The **Handouts** tab makes letters, old books and journals, scrolls, item cards
and notices. Write in ordinary entry blocks, attach local illustrations or a
seal, and choose which linked campaign material to include. Preview the player
edition while keeping GM annotations secret. Export selectable-text PDFs or
page images in a ZIP, individually or as an ordered packet. Cards can share A4
or US Letter sheets with cutting guides. Fonts and artwork stay local.

New **maps** use the 1.8 generator: continental and island compositions,
mountain ranges, drainage, terrain-aware provincial roads and parcel-based
towns with markets, workshops, gardens and working quays. Linked provinces
retain their parent coast, territory outline, rivers and capital. Building
presets have connected rooms; generated dungeon floors have paired stairs.
Preview regeneration before applying it, undo edits, and export at up to 4×
resolution. Existing maps keep their original generation until you choose
**1.8 · improved generation** in the editor. The sample world includes a linked
world → province → capital example and all five handout templates.

The **DM Screen** tab puts rules references, cheat sheets, notes, and statblocks
on a saved board for each world. **Browse ready-written rules** offers 36 local
references for D&D 2024, Vampire V5 and Call of Cthulhu 7e. Filter by system and
topic, search the text, preview a rule and pin an editable GM-only copy.
D&D includes all fifteen conditions, abilities/skills, combat, magic and
exploration; V5 covers pools, Hunger, Willpower and conflicts; CoC covers tests,
combat, wounds, Sanity and development. Each copy includes source attribution.
Re-pinning reuses your saved copy and keeps your edits. You can also pin existing
entries, reorder them, or write a reference. Unpinning never deletes an entry.

The **Encounter** tab gives each session's initiative and HP tracker its own
page. Add combatants manually, from characters/statblocks, or from a prepared
encounter; track turns, damage, healing, and conditions, with undo for the last
action. It shares the tracker on the session entry. Starting HP is copied from
supported entries, and combat changes stay in the session. Both tabs are
GM-only; tracker details are excluded from PDF exports.

Entries are typed: characters, NPCs, locations, factions, items, events,
creatures, sessions, notes. Each type has its own fields, and you can add your
own types. Click a type anywhere you see it — the sidebar heading, a card on
the dashboard, the badge on an entry — and you get that type's own page: every
location in one sortable table, with the columns that matter for locations
(Region, Population, and so on) already filled in. It's the fastest way to see
what you've actually written and what's still an empty stub.

Open **Categories** in the sidebar to create a category such as Gods, choose
its color and suggested facts, or change the order of categories. The sidebar
jump menu and the switcher on category pages move directly between them.
Category tables can search names, tags and facts, filter by a related entry,
or group entries by their connections or shared tags. For example, characters
linked to the same guild appear together. An open entry's visible connections
also appear near the top of the sidebar. Secret connections and hidden entries
stay out of player navigation.

Writing works like a wiki. Type `[[Port Vellen]]` and it becomes a link, with
autocomplete popping up as soon as you type `[[`. Hover a link and a card
shows you who or what it is without leaving the page. Links to pages that
don't exist yet show up orange; clicking one creates the page. Every page
lists what links to it. Rename something and MundusMaker offers to fix every
link that pointed at the old name.

A new NPC starts with Appearance / Personality / Hooks headings, a location
with What you see / Who you meet / Secrets, and so on — write into them or
delete them. Empty ones tell you what they're for ("Write the Secrets
section…") instead of sitting there blank. The quick-facts fields (Kind,
Region, Population…) have little `?` bubbles explaining what goes where, and
any field you don't need can be hidden with the ✕ and brought back later.

The page is a page until you click it, and then it's an editor. Hover any
paragraph and it outlines itself, with buttons that say what they do — Edit,
Make secret, Delete — and a Text / Heading / Quote picker that shows what the
block currently is. Start typing and a little row of formatting shortcuts
appears under the box, so you don't have to remember the markup. Delete
something by mistake and there's an Undo button in the corner for the next few
seconds; nothing asks you "are you sure?" anymore, because it can just put it
back.

Things that get used constantly at the table:

- **Statblocks.** Add one to any entry and fill it in, or click "From
  bestiary" and copy the stats from one of the 322 SRD monsters that ship
  with the app. Your NPC keeps their name, they just wear the monster's
  numbers. Spellcasters come with their full spell lists.
- **Dice.** Anything that looks like `2d6+3` is clickable, in notes and in
  statblocks. Attack bonuses roll the d20 for you.
- **Encounter blocks.** Pick monsters, set party size and level, get the XP
  math and an Easy-to-Deadly rating. Secret by default, so they never end up
  in player exports.
- **Rollable tables.** Add a weighted table to any entry, give each result its
  relative chance, and roll it in place. Tables can be secret and print in the
  GM book like every other block.
- **Session logs.** Write a recap after each game and link the people and
  places involved. A local initiative/HP list on session entries keeps the
  current round, turn, conditions, and combatant health without trying to turn
  MundusMaker into a shared VTT. Backlinks are automatic, so every NPC quietly
  accumulates a list of the sessions they appeared in.
- **Character creators.** D&D 2024 now has a full-page builder with a step
  navigator and live summary. Choose allowed local sources; search classes,
  species, backgrounds, feats, spells and equipment; compare descriptions;
  assign standard, rolled, manual or 27-point-buy scores; then choose skills,
  languages, origin feats, starting gear and spells. Wizard spellbooks and
  Magic Initiate selections have their own checks. The builder calculates
  starting HP, equipment-based AC and weapon attacks. Drafts resume per world
  and system in the same browser tab; no entry is saved until Finish. Vampire
  and Cthulhu keep their system-specific creation math and interactive sheets.
  Their power descriptions come from your own books and local notes.
- **Advancement.** **Level up…** on a D&D sheet walks through HP, subclass,
  ability increases or feats, expertise, new skills, fighting styles and
  spells. Review the result before applying one level. Constitution increases
  adjust earlier HP, Wizard spellbooks gain spells, and spent spell slots
  remain spent. The twelve SRD classes have progression tables through level
  20; local 5etools packs supply additional classes and subclasses. This is a
  single-class 2024 builder: conditional feature choices and unusual imported
  mechanics can be recorded as notes and adjusted in the sheet editor.
  V5 retains its XP ledger and CoC its checked-skill development rolls.
- **Character PDFs.** Each sheet can export directly to A4 or US Letter,
  using an original layout with its game's familiar fields: D&D abilities,
  saves, skills, combat and spellcasting; V5 attribute/skill dots and damage
  tracks; CoC characteristic and skill success thresholds. Long descriptions
  continue onto extra pages. Player and GM copies use the existing secrecy
  flags. World exports append these sheets by default; a compact text option
  is still available.
- **The Library.** All the bundled monsters, spells and gear in one place,
  plus any 5e.tools files you import. You can pick local JSON or explicitly
  download the bestiary, spells, items, classes and class features you are
  allowed to use from the 5etools source mirror. A pack is imported once and
  every world can use it. Find the thing, click Add to world, done.

Name fields have a dice button when invention fails at the table. The quick
creator can roll people, settlements, taverns, wards, nations, regions and
landmarks; character creators have the same person-name pool.

Maps are generated from a seed and then edited by hand, and there are five
scales of them now.

World maps got a proper cartographer. The new Atlas style shapes real
continents, runs the climate off latitude and rain shadow, inks the
coastlines, lets rivers pool into lakes where the land traps them, and will
carve the world into nations with borders, capitals and named settlements if
you ask it to. Anything you made in an older version keeps the painted look
it was made with; the styles never touch each other. The terrain brush works
in both.

Region maps are the middle scale that was always missing: one province, its
settlements joined by roads, ruins and shrines out in the hills, and a hex
grid if your table counts travel that way. Click a generated settlement on an
Atlas or region map and MundusMaker opens its linked town map; the first GM
click can create the normal Location entry and deterministic town map for it.

World and region maps now form one editable chain. A generated nation or a
region you place yourself can open a region map carved from the terrain under
it. The region inherits the towns, capital, rivers and lakes inside that area.
Its terrain crop stays fixed until a GM chooses **Refresh terrain from world**,
so later changes to the world never alter a region unexpectedly.

Sites can be moved, renamed, added, hidden and restored from the map editor.
Moving a capital redraws its nation's territory. Names and map links carry
across the world, region and town views, and both drill paths for a settlement
open the same town map. MundusMaker warns before a generator change can strand
site links or edits, and Settings includes a read-only report for links whose
target entry has been deleted.

New town maps also use their parent geography. Coastal towns put the sea on
the matching side of the map, river settlements use the riverside layout, and
the terrain colors follow the local climate. Existing maps keep their previous
rendering unless these newer fields are present.

Towns still come in five shapes and sizes from hamlet to metropolis, and can
now name their own quarters. The Copper End, the Shambles, wherever your
players keep getting stabbed.

Building maps are floor plans at fight scale. Taverns, inns, keeps, temples,
shops, houses, furnished down to the barrels in the storeroom, on a square
grid where you paint floors, walls, doors and windows.

Dungeons can be built rooms, natural caves, crypts, mines or sewers, and can
run five levels deep. Stairs join the floors, the editor has a level
switcher, and the PDF prints every level on its own page.

On top of the generated map you place and draw your own things. The Place
tool stamps houses, castles, cities, temples, forests, mountains, ruins and
more — sized and colored how you like. The Draw tool sketches roads, rivers,
walls, travel routes, and political borders; close a border loop and it tints
the territory inside, which is how you mark countries. Markers and labels go
anywhere, there's a compass rose if you want one, and all of it can be secret,
so the trap (or the true border) stays off the player's copy. Anything placed
can link to an entry — double-click the tavern on the town map and you're on
the tavern's page. Maps export as PNG at your choice of resolution — from
screen size up to 4× for posters, re-rendered sharp rather than upscaled — and
get embedded in the PDF at print quality, where linked and named things
become a numbered key under the map.

Building and dungeon maps also export Universal VTT (`.uvtt`) files. Each
floor carries an embedded PNG plus line-of-sight walls and closed door portals,
so Foundry and other compatible importers receive the useful geometry instead
of just a flat image. Player-safe and GM editions apply the same secret filters
as PNG and PDF exports.

Your world keeps its own calendar. The Calendar tab is where you build a year:
name the months and say how long each one is, add the odd day that belongs to
no month at all (a Mid-year's Day, a Festival of Lights), and name your ages —
declare an Age of Ash starting in 990 and every year from then on prints as
"1026 Age of Ash" instead of your era suffix. Give an entry a date and it lands
on the Timeline, grouped under the age it happened in. Tick "Repeats every
year" instead and you've made a holiday: it drops its year, reads as "Every
year on 14 Harvestmoon", and collects at the bottom of the timeline with the
other festivals. Holidays are ordinary entries, so they can have secrets and
links like anything else.

The dashboard turns that data into a campaign clock: today's formatted date,
the next visible annual event, and a GM-only Advance a day button. Advancing
walks through month lengths and intercalary days and updates the printed date.

Nothing you've already dated ever moves. Shorten a month after the fact and
MundusMaker keeps your dates exactly as you wrote them and quietly mentions the
ones that now hang past the end — it will not silently rewrite your history.

There's also a graph view of how everything connects, portraits on any entry,
and search over everything including your quick-facts fields (Ctrl+K).

The Import page reads wherever your campaign is stored now: a folder of
Obsidian or Markdown notes (the images come along, and a picture named after
a note becomes its portrait), CSV tables if your world is secretly a
spreadsheet, World Anvil article exports, Foundry VTT journals and actors
(D&D 5e actors arrive with their statblocks intact), 5e.tools files, and old
backups. It can also scan your disk for a previous Loreweave install and
copy its worlds in. The old install is never touched, so there's no jumping
without a net.

## The PDF export

One click builds a printable handbook of your world: cover, chapters by type,
portraits, maps, statblocks, timeline. The player edition removes every
secret, and the export screen tells you exactly how many it's removing. The
GM edition keeps them, highlighted, for your side of the screen.

## Where your stuff is

```
data/
  worlds/
    the-sundered-reach/
      world.json          settings, types, calendar
      entities/           one readable JSON file per entry
      assets/             uploaded images
      exports/            PDFs and PNGs you've generated
      .history/           last 10 versions of each entry (⏳ History button)
  .snapshots/             automatic daily backups, last 7 per world
  .library/               imported compendium packs, shared by all worlds
  .trash/                 deleted worlds and entries end up here, not gone
```

Copy the folder, put it in git, whatever you like. Settings (the ⚙ in the
top bar) backs a single world up to one JSON file, with its images if you
tick the box. Restore is on the Import page and asks you to type the
world's name first, because it replaces what's there.

Settings also has a Trash & snapshots browser. Deleted entries can be copied
back into their live world, while deleted worlds and snapshots restore as
collision-safe world copies. Recovery never overwrites a live file and never
consumes the source copy.

To sync between computers, point the data folder at something that already
syncs (Dropbox, Google Drive, Syncthing...) using the card in Settings, and
do the same on the other machine. Edit on one device at a time; the last
save wins.

If you want a new entry type, add it to that world's `world.json`:

```json
"deity": { "label": "Deity", "plural": "Deities", "color": "#c9a227",
           "fields": ["Domain", "Symbol", "Worshippers"] }
```

## Formatting cheatsheet

```
[[Entry Name]]             link (autocompletes after typing [[)
[[Entry Name|shown text]]  link with different display text
**bold**  *italic*  `code`
- bullet list              > quoted line
2d6+3                      clickable dice roll
```

Hover a block for its buttons: switch it between Text, Heading and Quote, move
it with the arrows, and lock it with 🔒.

## For developers

The server is one Node file, the frontend is vanilla ES modules, and the only
vendored library is jsPDF for the exports. Clone it, run `node server.js`,
edit, refresh.

Useful scripts: `npm run package` builds the single universal ZIP (downloads
and bundles all supported Node runtimes; `-- --node vX.Y.Z` pins the runtime).
`npm run package:all` is an alias for the same single download. Developers can
optionally build separate platform archives with `npm run package:platforms`,
or pass a target such as `npm run package -- linux-x64`.
`npm run bestiary` regenerates the SRD 5.1 bestiary,
`npm run srd52` regenerates the SRD 5.2 character-creation pack, `npm run
icons` regenerates the icon set, `npm run vendor` refreshes jsPDF. The explicit
5etools fetcher can also be run without the UI:

```sh
npm run 5etools -- --categories bestiary,classes --sources XMM,XPHB --out 5etools-pack.json
```

Packaging checks each bundled runtime against Node’s official SHA-256 list,
includes its license, writes Unix executable modes into all ZIPs, and inspects
the completed archives. Contributor instructions (including AGENTS.md and
CLAUDE.md at any depth), test artifacts, local packs and real data never ship.
The macOS menu uses built-in AppKit/JXA; no additional runtime library is needed.
`npm run test:references` checks the reference catalog and editable copies;
`npm run test:package` checks ZIP contents/modes and installed data configuration.

Import the resulting JSON from Library. A blank `--sources` selection means
every source in the chosen categories, so only request material you own,
licensed, or are otherwise allowed to use.

The server binds to 127.0.0.1 only, so nothing is ever reachable from the
network.

## License

MIT. Use it, fork it, run your table with it.

The bundled monsters come from the System Reference Document 5.1, and the
D&D 5.5e character options from the System Reference Document 5.2 — both by
Wizards of the Coast LLC, used under the
[Creative Commons Attribution 4.0 license](https://creativecommons.org/licenses/by/4.0/legalcode).
The build scripts deliberately keep only SRD content, because the rest of
the source material isn't redistributable.

The Vampire: The Masquerade creator is unofficial fan material under the
World of Darkness [Dark Pack](https://www.worldofdarkness.com/dark-pack)
agreement. Portions of the materials are the copyrights and trademarks of
Paradox Interactive AB, and are used with permission; all rights reserved.
The Call of Cthulhu creator is unofficial fan material under
[Chaosium's Fan Material Policy](https://www.chaosium.com/fan-material-policy/);
Call of Cthulhu is a trademark of Chaosium Inc. Neither creator ships any
rules text. The app knows the sheet structure, the names and the creation
math; the words stay in your books, where they're licensed to be.
