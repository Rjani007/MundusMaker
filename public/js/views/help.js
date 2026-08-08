// In-app quick start for GMs — especially first-time testers.

import { el } from '../util.js';

export function render(container) {
  const h = (t) => el('h3', { style: 'margin:20px 0 6px;font-size:16px' }, t);
  const p = (...kids) => el('p', { class: 'small', style: 'margin:4px 0;color:var(--text)' }, kids);
  const kbd = (t) => el('code', {}, t);

  container.append(el('div', { class: 'page' },
    el('h1', {}, 'How MundusMaker works'),
    el('div', { class: 'notice' },
      'Everything lives on your computer as plain files — no account, no cloud, no AI. Close the black window to stop; your work autosaves as you type (watch the ✓ in the top bar).'),

    h('✍️ Write your world'),
    p('Create entries from the sidebar or dashboard: characters, NPCs, locations, factions, items, events, creatures, sessions, notes. Click any text to edit it. ',
      'New entries start with a few suggested headings for their type — write into them or delete them, they\'re just blocks. ',
      'Type ', kbd('[[Name]]'), ' to link to another entry — an autocomplete pops up after ', kbd('[['), '. Links you haven\'t written yet show ',
      el('span', { style: 'color:var(--accent2)' }, 'orange'), ' — click one to create the page. Hovering a link shows a preview card. Every page lists what links to it (backlinks). ',
      kbd('**bold**'), ', ', kbd('*italic*'), ', ', kbd('- lists'), ' and ', kbd('> quotes'), ' work in any text block.'),
    p('Hover a block for its buttons: ', el('strong', {}, 'Edit'), ', a Text / Heading / Quote picker, 🔒, the arrows to move it, and ✕. ',
      'Deleted something by accident? An ', el('strong', {}, 'Undo'), ' button appears in the corner for a few seconds.'),

    h('📚 Type pages'),
    p('Click a type name — the sidebar heading, a dashboard card, the badge on an entry — for that type\'s own page: every entry of that kind in one table, ',
      'sortable, with the type\'s own fields as columns. Handy for spotting the stubs you never went back and filled in.'),

    h('📇 Details fields'),
    p('The Details card holds quick facts (Kind, Region, Population…). They\'re suggestions from the entry\'s type — hover the ',
      el('code', {}, '?'), ' bubbles to see what goes where, fill in the ones you want, and hit ✕ to hide ones you don\'t need (they can be restored). ',
      'Blank fields never show up for players or in exports. “+ Add field” makes your own.'),

    h('🔒 Secrets — the whole point'),
    p('Any block, relation, or map marker can be locked with the 🔒 button: players never see it. An entire entry can be made GM-only. ',
      'The toggle in the top-right switches between ', el('strong', {}, 'GM view'), ' and ', el('strong', {}, 'Player preview'),
      ' so you can check exactly what your table would see. Exports respect the same locks.'),

    h('⚔ NPCs, statblocks, dice, encounters'),
    p('Add a ', el('strong', {}, '+ ⚔ Statblock'), ' to any entry. Click ', el('strong', {}, '📖 From bestiary…'),
      ' inside it to copy stats from the 322 bundled SRD monsters (your NPC keeps its name — a harbormaster wearing Veteran stats takes ten seconds). ',
      'Dice like ', kbd('2d6+3'), ' and attack bonuses are clickable everywhere — try it. ',
      el('strong', {}, '+ 💀 Encounter'), ' blocks budget XP against your party and rate the fight Easy → Deadly.'),

    h('🗺 Maps'),
    p('Attach a map to any entry (or make one from the Maps tab) at any scale: world, region, town, building interior, or dungeon. Maps are generated from a seed — hit 🎲 until you like one, then edit by hand: ',
      'raise/lower terrain on world and region maps (the new Atlas style adds climate, lakes, nations and named settlements), paint floors, doors, windows and stairs on dungeons and buildings (rooms, caves, crypts, mines or sewers — dungeons can go several levels deep), pick town layouts (coastal harbor, planned city, riverside…) with optional named wards, and set terrain and street styles.'),
    p('Then make it yours: 🏰 ', el('strong', {}, 'Place'), ' stamps houses, castles, cities, forests, ruins and more; ✏️ ',
      el('strong', {}, 'Draw'), ' sketches roads, rivers, walls, travel routes and borders — end a border stroke where it started and it closes into a tinted territory (that\'s how you mark countries). ',
      'Markers, labels and a compass rose round it out. Anything can be 🔒 secret (the trap — or the true border — stays off the player map), and anything placed can link to an entry: double-click it to jump there. ',
      'Linked/named things become a numbered key under the map in PDF exports. ',
      'Exporting a PNG? Pick a resolution up to 4× — maps re-render sharp for printing instead of just being stretched.'),

    h('📅 Calendar, timeline & sessions'),
    p('Give any entry a date ("+ Add to timeline") and it appears in chronological order. The ', el('strong', {}, 'Calendar'),
      ' tab is where a year is defined: months and how long each one is, special days that belong to no month, and ',
      el('strong', {}, 'ages'), ' — name one and every year from its first prints as "1026 Age of Ash" instead of your era suffix. Years stay absolute, so nothing you already dated moves.'),
    p(el('strong', {}, 'Holidays and festivals'), ' are entries, not calendar settings. Make one (an Event does nicely), give it a date and tick ',
      kbd('Repeats every year'), ' — it loses its year, reads as "Every year on 14 Harvestmoon", and gets its own section at the bottom of the Timeline. ',
      'Because it\'s an ordinary entry it can hold secret blocks, be GM-only, and be [[linked]] like anything else.'),
    p('After each game, write a ', el('strong', {}, 'Session'), ' entry with [[links]] to whoever showed up: every NPC then automatically lists which sessions they appeared in.'),

    h('📄 Sharing with players'),
    p('The Export tab builds a PDF of your world: the ', el('strong', {}, 'player edition'),
      ' strips every secret (it tells you exactly how many), the GM edition keeps them highlighted. Maps and portraits are included.'),

    h('⬇ Bring your existing world'),
    p('The Import page (dashboard → Import…) reads a folder of Obsidian/Markdown notes, the bundled SRD bestiary, or a bestiary JSON from a local 5e.tools download.'),

    h('💾 Your data & backups'),
    p('Worlds are folders of readable JSON in the ', kbd('data'), ' folder next to the app. MundusMaker keeps a daily snapshot of each world (last 7, in ',
      kbd('data/.snapshots'), ') and deleted things go to ', kbd('data/.trash'), ' instead of vanishing. ',
      'Every entry also keeps its own history: the ⏳ History button on an entry lists the last 10 versions and restores any of them (the current state is saved first, so restoring is always safe). ',
      'To sync between devices, point the data folder at Dropbox/Drive/Syncthing from the dashboard\'s Sync card. One-click JSON backups live there too.'),

    h('🔤 Words this app uses'),
    p(el('strong', {}, 'Wiki-link'), ' — ', kbd('[[Name]]'), ' inside any text block. It jumps to that entry, or offers to create it. ',
      el('strong', {}, 'Backlink'), ' — the same link seen from the other end: every entry lists what points at it, so an NPC shows the sessions they turned up in without you keeping a list. ',
      el('strong', {}, 'GM-only'), ' — an entry players never see anywhere, exports included; the 🔒 button on a single block, relation or map pin hides just that piece instead.'),

    h('⌨️ Shortcuts'),
    p(kbd('Ctrl+K'), ' search · ', kbd('Ctrl+S'), ' save now · ', kbd('Esc'), ' close/finish editing · click any dice to roll it.'),

    el('p', { class: 'muted small', style: 'margin-top:24px' },
      'MundusMaker is free and open source (MIT). Bundled monsters are from the SRD 5.1 by Wizards of the Coast LLC, CC-BY-4.0.')));
}
