# TomeWeaver

A worldbuilding wiki for tabletop GMs that runs entirely on your own machine.
Your campaign is a folder of plain text files on your disk. There's no account,
no subscription, and nothing you write ever leaves your computer.

The reason it exists: I wanted a campaign wiki where GM secrets are part of the
design instead of an afterthought. Any paragraph, relationship, or map marker
can be marked secret. Whole entries can be GM-only. When you export a handbook
for your players, all of that is stripped out, and there's a toggle in the top
bar that shows you exactly what the players would see before you hit export.

## Getting started

Grab the `TomeWeaver-x.y.z-windows-x64.zip` build, unzip it anywhere, and
double-click `Start-TomeWeaver.bat`. Your browser opens by itself. Keep the
black window open while you play, close it when you're done. That build has
everything inside it, nothing to install.

Running from source instead needs Node.js (free, from [nodejs.org](https://nodejs.org),
the LTS button). Then:

- Windows: double-click `Start-TomeWeaver.bat`
- macOS: double-click `Start-TomeWeaver.command` (if macOS refuses, open a
  terminal and run `bash "Start-TomeWeaver.command"` once)
- Linux: `sh start-tomeweaver.sh`
- or just `node server.js [dataFolder] [port] [--no-open]`

First run loads a small sample world called The Sundered Reach. Poke around in
it to see how things fit together, then create your own world from the
dropdown in the top-right corner. The Help tab inside the app covers the rest.

## What it does

Entries are typed: characters, NPCs, locations, factions, items, events,
creatures, sessions, notes. Each type has its own fields, and you can add your
own types.

Writing works like a wiki. Type `[[Port Vellen]]` and it becomes a link, with
autocomplete popping up as soon as you type `[[`. Hover a link and a card
shows you who or what it is without leaving the page. Links to pages that
don't exist yet show up orange; clicking one creates the page. Every page
lists what links to it. Rename something and TomeWeaver offers to fix every
link that pointed at the old name.

A new NPC starts with Appearance / Personality / Hooks headings, a location
with What you see / Who you meet / Secrets, and so on — write into them or
delete them. The quick-facts fields (Kind, Region, Population…) have little
`?` bubbles explaining what goes where, and any field you don't need can be
hidden with the ✕ and brought back later.

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

Maps are generated from a seed and then edited by hand. World maps let you
paint terrain up and down. Towns come in several shapes (harbor towns, river
towns, planned cities, crossroads villages, or classic walled market towns)
and sizes from hamlet to metropolis, with farmland and orchards along the
roads out of town. They also come in five terrains — parchment, grassland,
desert, snowbound, marshland — and three street styles, from dirt lanes to
cobblestones to grand flagstone avenues. Switching terrain just re-inks the
map: the town itself doesn't move. Dungeons come as built rooms-and-corridors
or natural caves, on a grid where you paint floors, walls and doors.

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

There's also a graph view of how everything connects, a timeline that can use
your own calendar months, portraits on any entry, search over everything
(Ctrl+K), and an import page that reads Obsidian/Markdown folders and
5e.tools bestiary files.

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
  .trash/                 deleted worlds and entries end up here, not gone
```

Copy the folder, put it in git, whatever you like. The dashboard also has
one-click backup and restore for a single world.

To sync between computers, point the data folder at something that already
syncs (Dropbox, Google Drive, Syncthing...) using the Sync card on the
dashboard, and do the same on the other machine. Edit on one device at a
time; the last save wins.

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

Blocks cycle between text, heading and quote with the ¶ button, move with the
arrows, and lock with 🔒.

## For developers

The server is one Node file, the frontend is vanilla ES modules, and the only
vendored library is jsPDF for the exports. Clone it, run `node server.js`,
edit, refresh.

Useful scripts: `npm run package` builds the one-click zip (downloads a Node
runtime and bundles it), `npm run bestiary` regenerates the SRD bestiary,
`npm run vendor` refreshes jsPDF.

The server binds to 127.0.0.1 only, so nothing is ever reachable from the
network.

## License

MIT. Use it, fork it, run your table with it.

The bundled monsters come from the System Reference Document 5.1 by Wizards
of the Coast LLC, used under the
[Creative Commons Attribution 4.0 license](https://creativecommons.org/licenses/by/4.0/legalcode).
The bestiary script deliberately keeps only SRD content, because the rest of
the source material isn't redistributable.
