// Settings → Second backup folder (1.9). The server copies every world into a
// folder the GM chooses, on a schedule, and keeps the newest N of its own
// backups there. Restores are copies: the backup is never changed.

import { el, toast } from '../util.js';
import { refreshWorlds } from '../state.js';
import { api } from '../api.js';

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export function folderBackupCard() {
  const wrap = el('div', { class: 'card', hidden: true }, el('h3', {}, 'Second backup folder'));
  const body = el('div', {});
  wrap.append(body);

  async function refresh() {
    let info;
    try { info = await api.folderBackup(); } catch { wrap.hidden = true; return; }
    wrap.hidden = false;
    body.replaceChildren();
    if (!info.available) {
      body.append(el('p', { class: 'muted small' }, info.reason));
      return;
    }
    const s = info.settings;
    const dir = el('input', { type: 'text', value: s.dir, placeholder: 'e.g. E:\\MundusMaker backups', 'aria-label': 'Backup folder', style: 'flex:1;min-width:240px' });
    const every = el('select', { 'aria-label': 'How often' },
      [[6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Once a day'], [168, 'Once a week']].map(([v, l]) => el('option', { value: v, selected: v === s.everyHours }, l)));
    const keep = el('input', { type: 'number', min: 1, max: 60, value: s.keep, 'aria-label': 'Backups to keep', style: 'width:70px' });
    const save = el('button', { class: 'primary small', onclick: async () => {
      try {
        const r = await api.setFolderBackup({ dir: dir.value.trim(), everyHours: Number(every.value), keep: Number(keep.value) });
        toast(r.enabled ? 'Backups will be copied to that folder.' : 'Second-folder backups are off.');
        refresh();
      } catch (err) { toast(err.message, 6000); }
    } }, dir.value ? 'Save' : 'Turn on');
    const now = el('button', { class: 'small', disabled: !s.dir, onclick: async () => {
      now.disabled = true;
      try { const r = await api.runFolderBackup(); toast(`Backed up ${r.worlds} ${r.worlds === 1 ? 'world' : 'worlds'}.`); refresh(); }
      catch (err) { toast(`Backup failed: ${err.message}`, 6000); now.disabled = false; }
    } }, 'Back up now');
    body.append(
      el('p', { class: 'muted small' }, 'A copy of every world in another folder, ideally on another drive, a USB stick or a network share. MundusMaker keeps its newest backups there and removes only older backups it made itself. Nothing else in the folder is touched.'),
      el('div', { class: 'row' }, dir),
      el('div', { class: 'row', style: 'margin-top:6px' }, every, el('label', { class: 'small' }, 'Keep ', keep, ' backups'), save, now,
        s.dir ? el('button', { class: 'ghost small', onclick: async () => { await api.setFolderBackup({ dir: '' }); toast('Second-folder backups are off. Existing backups stay in the folder.'); refresh(); } }, 'Turn off') : null),
      el('p', { class: 'muted small' }, s.last ? `Last backup: ${when(s.last)}.` : s.dir ? 'No backup yet. The first one runs within a few minutes, or use Back up now.' : ''),
      info.lastError ? el('p', { class: 'notice warn' }, `The last backup failed (${when(info.lastError.at)}): ${info.lastError.message}`) : '');
    if (info.backups.length) {
      const list = el('details', {}, el('summary', {}, `Backups in this folder (${info.backups.length})`));
      for (const b of info.backups) {
        list.append(el('div', { class: 'fb-row' },
          el('div', {}, el('strong', {}, when(b.created)), el('span', { class: 'muted small' }, ` · MundusMaker ${b.version || '?'}${b.ours ? '' : ' · made by another copy of MundusMaker'}`)),
          el('div', { class: 'fb-worlds' }, b.worlds.map((w) => el('span', { class: 'fb-world' }, `${w.name} (${w.entries})`,
            el('button', { class: 'ghost small', title: 'Copy this world back in as a separate world. The backup is not changed.', onclick: async () => {
              if (!confirm(`Restore “${w.name}” from this backup as a separate world? Your current worlds are not changed.`)) return;
              try { const r = await api.restoreFolderBackup(b.name, w.id); await refreshWorlds(); toast(`Restored as “${r.restored.name}”. Pick it in the world switcher.`, 6000); }
              catch (err) { toast(err.message, 6000); }
            } }, 'Restore'))))));
      }
      body.append(list);
    }
  }
  refresh();
  return wrap;
}
