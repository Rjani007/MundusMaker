// Character files: one character's sheet as a small JSON file, to move it to another
// world, keep a copy, or take it to an online table such as Elysium (which reads and
// writes the same format). Pure: no DOM, no network, so tests load it in Node.
//
// { format: 'mundusmaker.character', version: 1, exported, app, name, system, data, portrait? }
//   data      the sheet block's data exactly as its sheet module stores it
//   portrait  optional data:image/(png|jpeg|webp|gif);base64 URL, never SVG
// Only the sheet travels: other blocks, relations, fields and the gmOnly flag stay home.

export const CHARACTER_FILE = 'mundusmaker.character';
export const CHARACTER_FILE_VERSION = 1;
export const PORTRAIT_LIMIT = 1.5 * 1024 * 1024;
const PORTRAIT = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function characterFile(entity, block, { app = 'MundusMaker', portrait = null, now = new Date() } = {}) {
  const out = {
    format: CHARACTER_FILE,
    version: CHARACTER_FILE_VERSION,
    exported: now.toISOString(),
    app,
    name: String(entity.name || ''),
    system: block.system,
    data: block.data ?? {},
  };
  if (portrait && PORTRAIT.test(portrait) && portrait.length <= PORTRAIT_LIMIT * 4 / 3 + 64) out.portrait = portrait;
  return out;
}

/**
 * Checks a parsed character file. Returns { name, system, data, portrait } or throws an
 * Error that says, in plain words, what is wrong. systems: the sheet systems this build knows.
 */
export function readCharacterFile(obj, systems) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.format !== CHARACTER_FILE) {
    throw new Error('This is not a MundusMaker character file.');
  }
  if (!Number.isInteger(obj.version) || obj.version < 1) throw new Error('This character file has no version, so it can’t be read safely.');
  if (obj.version > CHARACTER_FILE_VERSION) throw new Error('This character file was made by a newer version. Update MundusMaker to import it.');
  if (!Object.hasOwn(systems, obj.system)) {
    throw new Error(`This character uses a sheet this MundusMaker doesn’t know (${String(obj.system || 'none')}).`);
  }
  if (!obj.data || typeof obj.data !== 'object' || Array.isArray(obj.data)) throw new Error('This character file has no sheet in it.');
  const name = String(obj.name ?? '').trim().slice(0, 120);
  const portrait = typeof obj.portrait === 'string' && PORTRAIT.test(obj.portrait) ? obj.portrait : null;
  return { name, system: obj.system, data: obj.data, portrait };
}

export function characterFileName(name) {
  const base = String(name || 'character').normalize('NFKD').replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
  return `${base || 'character'}.character.json`;
}

/** 'image/png' etc. and the base64 payload of a portrait data URL, for the assets upload. */
export function portraitParts(dataUrl) {
  const m = PORTRAIT.exec(dataUrl || '') && /^data:(image\/\w+);base64,(.*)$/.exec(dataUrl);
  if (!m) return null;
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[m[1]];
  return { type: m[1], ext, base64: m[2] };
}
