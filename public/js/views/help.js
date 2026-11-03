// In-app quick start for GMs, especially first-time testers.

import { el } from '../util.js';

export function render(container) {
  const h = (t) => el('h3', { style: 'margin:20px 0 6px;font-size:16px' }, t);
  const p = (...kids) => el('p', { class: 'small', style: 'margin:4px 0;color:var(--text)' }, kids);
  const kbd = (t) => el('code', {}, t);
  const b = (t) => el('strong', {}, t);

  container.append(el('div', { class: 'page' },
    el('h1', {}, 'How MundusMaker works'),
    el('div', { class: 'notice' },
      'Your worlds are plain files on this computer. No account, no cloud. Everything saves as you type; the ✓ in the top bar shows it saved. ',
      'Closing this tab does not stop MundusMaker. Quit with ⏻ at the top right, or from its tray or menu bar icon.'),

    h('🌍 Your world'),
    p('You start with an empty world called My World. Rename it at the top of the dashboard. ',
      'Make more worlds under ', b('Your worlds'), ' on the dashboard. ', b('Add the sample world'), ' adds an example to explore.'),

    h('✍️ Write'),
    p('Create entries from the sidebar or the dashboard. Click any text to edit it. ',
      'New entries start with a few headings; write in them or delete them.'),
    p('Type ', kbd('[[Name]]'), ' to link another entry. ',
      el('span', { style: 'color:var(--accent2)' }, 'Orange'), ' links point to pages you have not written yet; click one to create it. ',
      'Hover a link for a preview. Every page lists what links to it.'),
    p(kbd('**bold**'), ', ', kbd('*italic*'), ', ', kbd('- lists'), ' and ', kbd('> quotes'), ' work in any text block.'),
    p('Hover a block for its buttons: ', b('Edit'), ', Text / Heading / Quote, 🔒, the arrows and ✕. Deleted something by mistake? Press ', b('Undo'), ' in the corner. ',
      b('+ 🎲 Table'), ' adds a random table you can roll.'),
    p(b('Unlinked mentions'), ' lists entries that name this one without a link. ', b('Link'), ' turns them into links.'),

    h('📚 Categories'),
    p('Click a category name for a table of all its entries. ',
      'Open ', el('a', { href: '#/categories' }, 'Categories'), ' to add one, such as Gods or Guilds, with its own facts and color.'),
    p('The ', b('Details'), ' card holds quick facts like Kind or Region. Hover ', kbd('?'), ' for a hint, and press ✕ to hide a field you do not need. Empty fields never reach players.'),

    h('🔒 Secrets'),
    p('🔒 hides a block, relationship or map pin from players. A GM-only entry is hidden completely. ',
      'The switch at the top right flips between ', b('GM view'), ' and ', b('Player preview'), '. Exports follow the same rules.'),
    p('When the party learns something, press ', b('🔓 Reveal'), ' and pick the session. That session lists everything revealed in it, each with ', b('Undo'), '.'),

    h('⚔ Statblocks, dice and encounters'),
    p(b('+ ⚔ Statblock'), ' adds a statblock. ', b('📖 From bestiary…'), ' copies one of the 322 bundled SRD monsters. ',
      'Click dice like ', kbd('2d6+3'), ' to roll them. ', b('+ 💀 Encounter'), ' rates a fight for your party, from Easy to Deadly.'),

    h('🛡 DM Screen and Encounter'),
    p(b('DM Screen'), ' keeps rules, notes and statblocks on one board. Browse ready-written rules for D&D 2024, Vampire V5 or Call of Cthulhu 7e and pin an editable copy.'),
    p(b('Encounter'), ' runs initiative and hit points for a session. Damage there never changes a character sheet. ',
      'The ', b('Party'), ' panel shows each player character\'s key numbers. Both tabs are GM-only.'),

    h('🗺 Maps'),
    p('Make a map on the Maps tab or on any entry: world, region, town, building or dungeon. Every map grows from a seed. Roll 🎲 until you like it, then edit it by hand.'),
    p(b('Place'), ' stamps buildings and landmarks. ', b('Draw'), ' adds roads, rivers and borders; close a border to shade a territory. ',
      'Anything you add can be 🔒 secret or link to an entry. Double-click it to open the entry.'),
    p('Click a town on a world or region map to open its town map, or create one.'),
    p('World maps come in Atlas, Terrain and Classic styles. Towns can be historical, a ', b('Modern town map'), ' or a ', b('Modern city map'), '.'),
    p(b('🗝 Key'), ' adds GM notes to rooms, towns and hexes; the GM PDF prints them as the map key. ',
      b('👥 Populate'), ' suggests people and places for a town. ', b('🧭 Journey planner'), ' plans a trip across a region.'),
    p('Export a PNG at up to 4×, or a Universal VTT file from building and dungeon maps. Undo and Redo work on map edits.'),
    p('Older maps keep their look. To try the newer generator, choose ', kbd('1.8 · improved generation'), ' and compare the preview before you apply it.'),

    h('✉ Handouts'),
    p(b('Handouts'), ' makes letters, books, scrolls, notices and item cards. Pick a template and write. The preview shows the player edition. Export a PDF or PNG images.'),
    p(b('Cards from the library'), ' turns SRD and 5etools items, spells and monsters into cards. ',
      'A ', b('Map fragment'), ' is a torn piece of one of your maps, always drawn from the player version.'),

    h('🎭 Characters'),
    p(b('Create a character'), ' builds a D&D 2024, Vampire V5 or Call of Cthulhu character step by step. The result is a sheet on an ordinary entry.'),
    p('Click dots to change a rating. Click a skill to roll it; hold ', kbd('Shift'), ' for advantage or a bonus die. ',
      'With the keyboard, ', kbd('Tab'), ' to a rating and use the arrow keys.'),
    p(b('Level up…'), ' adds a level to a D&D sheet. V5 sheets spend XP, and Call of Cthulhu sheets roll skill improvements.'),
    p(b('Familiar layout'), ' arranges a sheet like the game\'s own. MundusMaker draws it; it is not an official sheet. ',
      b('📄 Official sheet…'), ' fills the publisher\'s free fillable PDF with your character, here on this computer.'),

    h('📅 Calendar and sessions'),
    p('The ', b('Calendar'), ' tab sets your months, special days and ages. Give an entry a date to put it on the Timeline. Tick ',
      kbd('Repeats every year'), ' to make it a holiday.'),
    p('The dashboard clock shows today. ', b('Advance a day'), ' moves it on.'),
    p('After each game, write a ', b('Session'), ' entry and link who was there. Each NPC then lists the sessions they were in.'),

    h('📄 Sharing with players'),
    p(b('Export'), ' makes a PDF of your world. The player edition leaves out every secret and tells you how many.'),
    p(b('Export player wiki'), ' makes a small website you can open offline. It never includes secrets.'),
    p('Before a player export, the ', b('safety check'), ' lists hidden things that might still show, with a link to each.'),

    h('📦 Library and import'),
    p('The ', b('Library'), ' holds the bundled SRD monsters, spells and gear, plus 5e.tools files you import. ', b('Add to world'), ' copies one into your world. ',
      'Its optional 5etools download is the only time the Library goes online.'),
    p(b('Import'), ' reads Obsidian or Markdown folders, CSV, World Anvil, Foundry VTT, 5e.tools files, D&D Beyond and V5 sheet PDFs, character files and backups. ',
      'It can also copy worlds from an older install, which it never changes.'),

    h('💾 Backups'),
    p('MundusMaker keeps a daily copy of each world (the last 7) and moves deleted things to the trash. ',
      b('⏳ History'), ' on an entry brings back one of its last 10 versions.'),
    p(b('Settings'), ' (⚙ in the top bar) has world backups, the trash, a second backup folder and the data folder. ',
      'To use two computers, put the data folder in Dropbox, Drive or Syncthing and edit on one at a time. If your sync tool makes a conflict copy, ', b('Compare'), ' shows both versions.'),

    h('⌨️ Shortcuts'),
    p(kbd('Ctrl+K'), ' search · ', kbd('Ctrl+S'), ' save now · ', kbd('Esc'), ' stop editing · click any dice to roll.'),

    el('p', { class: 'muted small', style: 'margin-top:24px' },
      'MundusMaker is free and open source (MIT). The bundled monsters and D&D options come from the SRD 5.1 and 5.2 by Wizards of the Coast LLC, under CC-BY-4.0. ',
      'The Vampire and Cthulhu tools are unofficial fan tools with no rules text. Full notices are in Settings → About.')));
}
