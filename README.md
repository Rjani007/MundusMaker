# MundusMaker

A worldbuilding wiki for tabletop GMs that runs entirely on your own machine.
Your campaign is a folder of plain text files on your disk. There's no account,
no subscription, and nothing you write ever leaves your computer.

The reason it exists: I wanted a campaign wiki where GM secrets are part of the
design instead of an afterthought. Any paragraph, relationship, or map marker
can be marked secret. Whole entries can be GM-only. When you export a handbook
for your players, all of that is stripped out, and there's a toggle in the top
bar that shows you exactly what the players would see before you hit export.

## Getting started

Grab the `MundusMaker-x.y.z-windows-x64.zip` build, unzip it anywhere, and
double-click `Start-MundusMaker.bat`. Your browser opens by itself. Keep the
black window open while you play, close it when you're done. That build has
everything inside it, nothing to install.

If you'd rather it didn't live in a browser tab: Edge and Chrome have an
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

Entries are typed: characters, NPCs, locations, factions, items, events,
creatures, sessions, notes. Each type has its own fields, and you can add your
own types. Click a type anywhere you see it — the sidebar heading, a card on
the dashboard, the badge on an entry — and you get that type's own page: every
location in one sortable table, with the columns that matter for locations
(Region, Population, and so on) already filled in. It's the fastest way to see
what you've actually written and what's still an empty stub.

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
- **Session logs.** Write a recap after each game and link the people and
  places involved. Backlinks are automatic, so every NPC quietly accumulates
  a list of the sessions they appeared in.
- **Character creators.** A step-by-step builder walks you through a whole
  character for D&D 5.5e (the 2024 rules), Vampire: The Masquerade, or Call
  of Cthulhu, and it does the math with you: a point buy that has to add up
  to 27, occupation points that have to be spent, attribute spreads the
  rulebook would sign off on. The D&D options ship with the app, courtesy of
  the freely licensed SRD. For Vampire and Cthulhu the app knows the names
  and the numbers, and the power text is yours to paste in from your own
  books, because those words aren't free to bundle. What comes out is a
  sheet living on an ordinary entry: dots you click to change, skills that
  roll themselves when you click them, hunger dice doing their ugly thing.
  Hold Shift for advantage or a bonus die. A sheet can be a GM secret like
  anything else, and it prints in the book.
- **The Library.** All the bundled monsters, spells and gear in one place,
  plus any 5e.tools files you import. A pack is imported once and every
  world can use it. Find the thing, click Add to world, done.

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
grid if your table counts travel that way.

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

Nothing you've already dated ever moves. Shorten a month after the fact and
MundusMaker keeps your dates exactly as you wrote them and quietly mentions the
ones that now hang past the end — it will not silently rewrite your history.

There's also a graph view of how everything connects, portraits on any entry,
and search over everything including your quick-facts fields (Ctrl+K).

The Import page reads whatever your campaign lives in now: a folder of
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
tick the box. Restoring lives on the Import page and asks you to type the
world's name first, because it replaces what's there.

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

Useful scripts: `npm run package` builds the one-click zip (downloads a Node
runtime and bundles it; `-- --node vX.Y.Z` pins the runtime, `package:all`
builds every platform), `npm run bestiary` regenerates the SRD 5.1 bestiary,
`npm run srd52` regenerates the SRD 5.2 character-creation pack, `npm run
icons` regenerates the icon set, `npm run vendor` refreshes jsPDF.

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
