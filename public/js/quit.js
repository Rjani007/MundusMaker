// Quit: stops the local server once every change in this tab has been saved.
// Launchers start MundusMaker without a visible window, so this (and the tray
// or menu-bar icon) is how a GM stops it. The top bar's ⏻ Quit and Settings
// both call quitMundusMaker().

import { el } from './util.js';
import { api } from './api.js';
import { requireSaved } from './state.js';

export async function quitMundusMaker() {
  if (!confirm('Quit MundusMaker?\n\nYour changes are saved first. To use it again, start MundusMaker the way you usually do.')) return false;
  try {
    await requireSaved();
  } catch (err) {
    alert(`MundusMaker is still running, because some changes could not be saved yet.\n\n${err.message}`);
    return false;
  }
  try {
    await api.quit();
  } catch (err) {
    alert(`MundusMaker could not be stopped: ${err.message}`);
    return false;
  }
  showStopped();
  return true;
}

export function showStopped() {
  document.body.replaceChildren(el('div', { class: 'page', style: 'max-width:560px;margin:15vh auto;padding:0 16px' },
    el('h1', {}, 'MundusMaker has stopped'),
    el('p', {}, 'Your worlds are saved. You can close this tab.'),
    el('p', { class: 'muted' },
      'To start it again: on Windows, use the MundusMaker shortcut or double-click Start-MundusMaker in its folder. ',
      'On a Mac, open MundusMaker.app. On Linux, run start-mundusmaker.sh.')));
}
