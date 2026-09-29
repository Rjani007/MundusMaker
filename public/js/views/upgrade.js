// First start beside an older MundusMaker (scripts/upgrade.js on the server).
// Either a notice of what was copied automatically, or one question about what
// to bring over when that couldn't be decided safely. Copy-only, always: the
// old folder never changes. Resolves when the dialog closes.

import { el, toast } from '../util.js';
import { api } from '../api.js';
import { state, refreshWorlds } from '../state.js';
import { quitMundusMaker } from '../quit.js';

const LATER_KEY = 'mundusmaker.upgrade-later';
const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const REASONS = { 'untouched sample': 'the unchanged sample world, already here', 'already copied': 'already copied' };

export async function maybeShowUpgrade() {
  if (!state.gm) return;
  let info;
  try { info = await api.upgradeStatus(); } catch { return; }
  if (info.notice) return showNotice(info.notice);
  let later = false;
  try { later = !!sessionStorage.getItem(LATER_KEY); } catch { /* storage unavailable */ }
  if (info.choice && !later) return showChoice(info.choice);
}

function dialog(children) {
  let close;
  const closed = new Promise((resolve) => { close = resolve; });
  const box = el('div', { class: 'dialog upgrade-dialog', role: 'dialog', 'aria-modal': 'true' }, children);
  const overlay = el('div', { class: 'overlay' }, box);
  document.body.append(overlay);
  return { box, closed, close: () => { overlay.remove(); close(); } };
}

function showNotice(notice) {
  const from = notice.from?.version ? `MundusMaker ${notice.from.version}` : 'your older MundusMaker';
  const d = dialog([
    el('h2', {}, '📦 Your worlds came along'),
    el('p', {}, `MundusMaker copied ${plural(notice.copied.length, 'world')} from ${from} in `, el('code', {}, notice.from?.path || ''), ':'),
    el('ul', {}, notice.copied.map((w) => el('li', {}, w.name, el('span', { class: 'muted small' }, ` · ${plural(w.entities, 'entry', 'entries')}`)))),
    notice.packs ? el('p', { class: 'muted small' }, `${plural(notice.packs, 'library pack')} came along too.`) : null,
    el('p', { class: 'muted' }, 'That folder was not changed. Once you have checked your worlds here, you can delete it, or keep it as a backup.'),
    el('div', { class: 'row', style: 'margin-top:14px' }, el('span', { class: 'spacer' }),
      el('button', { class: 'primary', onclick: async () => { d.close(); try { await api.upgradeDismiss('notice'); } catch { /* shows again next time */ } } }, 'Got it')),
  ]);
  return d.closed;
}

function showChoice(choice) {
  const status = el('p', { class: 'small', role: 'status' });
  const cards = el('div', {});
  const d = dialog([
    el('h2', {}, '📦 Bring your campaigns from an older MundusMaker?'),
    el('p', { class: 'muted' }, 'Worlds are copied. Nothing in the older folder is changed, and you can decide again later from the Import page.'),
    cards, status,
    el('div', { class: 'row', style: 'margin-top:14px' },
      el('button', { class: 'ghost', onclick: async () => { d.close(); try { await api.upgradeDismiss('choice'); } catch { /* asks again next time */ } } }, 'Don’t ask again'),
      el('span', { class: 'spacer' }),
      el('button', { onclick: () => { try { sessionStorage.setItem(LATER_KEY, '1'); } catch { /* asks again on reload */ } d.close(); } }, 'Not now')),
  ]);
  const render = (candidates) => cards.replaceChildren(...candidates.map((c) => candidateCard(c, { status, refresh, finish: d.close })));
  async function refresh() {
    try {
      const info = await api.upgradeStatus();
      if (!info.choice) { d.close(); return; }
      render(info.choice.candidates);
    } catch (err) { status.textContent = err.message; }
  }
  render(choice.candidates);
  return d.closed;
}

function candidateCard(c, { status, refresh }) {
  // card headings are styled in capitals, so the folder path gets its own line
  const title = [el('h3', {}, c.version ? `MundusMaker ${c.version}` : 'An older MundusMaker'),
    el('div', { class: 'muted small', style: 'margin:-4px 0 6px' }, el('code', {}, c.path))];
  if (c.running) {
    return el('div', { class: 'card' }, title,
      el('div', { class: 'notice warn' },
        `This copy is still running${c.running.version ? ` (version ${c.running.version})` : ''}. Quit it first: close its window, or use Quit in its tray or menu-bar icon. Then check again.`),
      el('div', { class: 'row', style: 'margin-top:8px' },
        c.running.canQuit ? el('button', {
          onclick: async (ev) => {
            ev.target.disabled = true;
            try { await api.upgradeQuitOld(c.path); status.textContent = 'The older copy is stopping…'; setTimeout(refresh, 1500); }
            catch (err) { status.textContent = err.message; ev.target.disabled = false; }
          },
        }, 'Quit it for me') : null,
        el('button', { onclick: refresh }, 'Check again')));
  }

  const boxes = c.worlds.map((w) => {
    const box = el('input', { type: 'checkbox', checked: w.copyable, disabled: !w.copyable });
    box.dataset.world = w.id;
    return el('label', { class: 'row small', style: 'gap:6px' }, box, w.name,
      el('span', { class: 'muted' }, ` · ${plural(w.entities, 'entry', 'entries')}${w.copyable ? '' : ` · ${REASONS[w.reason] || w.reason}`}`));
  });
  const packBox = c.packs?.count ? el('input', { type: 'checkbox', checked: true }) : null;
  const adopt = c.external ? el('input', { type: 'radio', name: `how-${c.path}`, checked: true }) : null;
  const copyInstead = c.external ? el('input', { type: 'radio', name: `how-${c.path}` }) : null;
  const done = el('div', { class: 'small', role: 'status' });

  const act = el('button', {
    class: 'primary',
    onclick: async () => {
      act.disabled = true;
      try {
        if (adopt?.checked) {
          await api.setDataDir(c.dataDir, false);
          try { await api.upgradeDismiss('choice'); } catch { /* the new folder has worlds, so it won't ask there */ }
          done.replaceChildren('✓ MundusMaker will use that folder after it restarts. ',
            el('button', { class: 'small', onclick: () => quitMundusMaker() }, 'Quit now'));
          return;
        }
        const worldIds = boxes.map((row) => row.querySelector('input')).filter((b) => b.checked && !b.disabled).map((b) => b.dataset.world);
        if (!worldIds.length && !packBox?.checked) { toast('Tick at least one world to copy'); act.disabled = false; return; }
        const result = await api.upgradeCopy(c.path, worldIds, !!packBox?.checked);
        await refreshWorlds();
        done.textContent = `✓ Copied ${plural(result.copied.length, 'world')}${result.packs.length ? ` and ${plural(result.packs.length, 'library pack')}` : ''}. The older folder was not changed.`;
        toast(`Copied ${plural(result.copied.length, 'world')} from ${c.version ? `MundusMaker ${c.version}` : 'the older MundusMaker'}`);
      } catch (err) {
        done.textContent = `Could not finish: ${err.message}`;
        act.disabled = false;
      }
    },
  }, c.external ? 'Continue' : 'Copy selected');

  return el('div', { class: 'card' }, title,
    c.external ? el('div', {},
      el('p', { class: 'small' }, 'It keeps its worlds outside its own folder, in ', el('code', {}, c.dataDir),
        '. That is usually a folder Dropbox, OneDrive or Syncthing shares between your devices.'),
      el('label', { class: 'row small', style: 'gap:6px' }, adopt, 'Keep using that folder (recommended: your devices stay in step)'),
      el('label', { class: 'row small', style: 'gap:6px' }, copyInstead, 'Copy its worlds into this version’s own folder')) : null,
    el('div', { style: 'margin:6px 0' }, boxes),
    packBox ? el('label', { class: 'row small', style: 'gap:6px' }, packBox,
      `Library packs (${c.packs.count}, ${size(c.packs.bytes)})`) : null,
    el('div', { class: 'row', style: 'margin-top:8px' }, act), done);
}
