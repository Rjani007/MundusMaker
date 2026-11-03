# MundusMaker

A worldbuilding wiki for tabletop game masters. It runs on your own computer,
and your campaign is a folder of plain files. No account, no subscription, no
cloud.

Any paragraph, relationship or map pin can be secret, and whole entries can be
GM-only. Player preview shows what your players will see, and player exports
leave the secrets out.

## Install

Download `MundusMaker-x.y.z.zip` and unzip the whole folder. The same download
works on Windows, Mac and Linux, and Node.js is included.

- **Windows 10 or later (x64):** double-click `Start-MundusMaker.bat`. Your
  browser opens and MundusMaker keeps running in the tray.
  `MundusMaker-Console.bat` runs it in a window instead, for troubleshooting.
- **Mac (macOS 13.5 or later):** move `MundusMaker.app` to Applications and
  open it. Test builds are unsigned, so macOS may ask you to allow it once
  under **Privacy & Security → Open Anyway**
  ([Apple's steps](https://support.apple.com/en-us/102445)).
- **Linux (x64 or ARM64, glibc 2.28 and kernel 4.18 or later):** run
  `start-mundusmaker.sh`. It runs in the background. Add `--foreground` to
  keep it in the terminal, or `--install-desktop` for a menu entry.

Quit with **⏻ Quit** at the top right of the app, or from the tray or menu bar
icon. `README-FIRST.html` in the download has more help for each system.

You start with an empty world called My World. Rename it at the top of the
dashboard. To look around first, press **Add the sample world** under Your
worlds.

**Upgrading:** unzip the new version next to the old folder and start it. It
copies your worlds across and never changes the old folder. The Import page can
also copy worlds from an older install somewhere else, Loreweave included.

**Docker or a NAS:** see the [hosting guide](docs/docker.md). Anyone with the
password gets full GM access.

## What it does

- **Wiki.** Type `[[Name]]` to link an entry. Orange links point to pages you
  haven't written yet; click one to create it. Every page lists what links to
  it, and renaming an entry offers to fix the links.
- **Categories.** Characters, NPCs, locations, factions, items, events,
  creatures, spells, handouts, sessions and notes, each with its own fields and
  table. Add your own on the Categories page.
- **Maps.** World, region, town, building and dungeon maps grow from a seed,
  then you edit them by hand. Click a town on a world map to open its own
  town map. Export PNG at up to 4× or Universal VTT.
- **Characters.** Step-by-step builders and sheets for D&D 2024, Vampire: The
  Masquerade 5th Edition and Call of Cthulhu 7th Edition. Level up, print a
  sheet, or fill the publisher's own fillable PDF.
- **At the table.** 322 SRD monsters, dice you can click like `2d6+3`,
  encounter budgets, random tables, a DM Screen and an initiative tracker.
- **Time.** Your own calendar with months, special days and ages, plus a
  timeline, holidays and a campaign clock.
- **Handouts.** Letters, books, scrolls, notices and item cards as PDF or PNG.
- **Sharing.** A player or GM PDF of the whole world, or a player wiki that
  opens offline. A safety check looks for secrets that could slip through.
- **Import.** Obsidian or Markdown folders, CSV, World Anvil, Foundry VTT,
  5e.tools files, D&D Beyond and V5 sheet PDFs, character files and backups.

The Help tab in the app explains each part.

## Your data

```
data/
  worlds/
    my-world/
      world.json      name, categories, calendar
      entities/       one JSON file per entry
      assets/         images
      exports/        PDFs and images you made
      .history/       the last 10 versions of each entry
  .snapshots/         a daily copy of each world, last 7 kept
  .library/           imported 5e.tools packs
  .trash/             deleted worlds and entries
```

On a Mac this folder is `~/Library/Application Support/MundusMaker/data`.

Copy the folder to back everything up. Settings also saves a world as one
backup file and can copy every world to a second folder on a schedule. To use
two computers, point the data folder at Dropbox, Google Drive or Syncthing in
Settings, and edit on one computer at a time. The
[data safety guide](docs/data-safety.md) has the details.

MundusMaker only listens on your own computer (127.0.0.1). It goes online only
when you press one of three buttons: download from 5etools, check for updates,
or get a publisher's character sheet.

## Writing

```
[[Entry Name]]             link (autocomplete starts after [[)
[[Entry Name|shown text]]  link with other text
**bold**  *italic*  `code`
- list item                > quote
2d6+3                      dice you can click
```

## Run from source

You need Node.js 18 or later, and nothing else.

```sh
node server.js [dataFolder] [port] [--no-open]
```

With no arguments it uses the `data` folder next to `server.js` and port 4870.
Add `--sample` to start an empty data folder with the sample world.

| Command | What it does |
| --- | --- |
| `npm test` | every automated test |
| `npm run test:render` | map image check in headless Edge or Chrome (Node 22 or later) |
| `npm run package` | the universal download, with bundled Node runtimes |
| `npm run bestiary`, `npm run srd52` | rebuild the bundled SRD data |
| `npm run 5etools` | fetch 5etools data without the app |

Release notes and design notes are in the `docs` folder of the source
repository.

## License

MIT. Use it, fork it, run your table with it.

The bundled monsters come from the System Reference Document 5.1 and the
D&D 2024 character options from the System Reference Document 5.2, both by
Wizards of the Coast LLC, under the
[Creative Commons Attribution 4.0 license](https://creativecommons.org/licenses/by/4.0/legalcode).
Only SRD content is included.

The Vampire: The Masquerade creator is unofficial fan material under the World
of Darkness [Dark Pack](https://www.worldofdarkness.com/dark-pack) agreement.
Portions of the materials are the copyrights and trademarks of Paradox
Interactive AB, and are used with permission. All rights reserved.

The Call of Cthulhu creator is unofficial fan material under
[Chaosium's Fan Material Policy](https://www.chaosium.com/fan-material-policy/).
Call of Cthulhu is a trademark of Chaosium Inc.

Neither creator includes rules text. MundusMaker knows the sheet layout, the
names and the creation math; the words stay in your own books.
