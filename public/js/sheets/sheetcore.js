// The sheet-system registry — mirrors MAP_KINDS in maps/mapcore.js.
// Each system module exports: label, tagline, defaults(), html(data, opts),
// editor(block, save), writePdf(w, data), summary(data), searchText(data),
// loadData() (async, cached) and wizard { intro, steps, finish }.

import * as dnd2024 from './dnd2024.js';
import * as vtm5 from './vtm5.js';
import * as coc7 from './coc7.js';
import { wireSheetRolls, handleSheetClick } from './sheetlib.js';

export const SHEET_SYSTEMS = { dnd2024, vtm5, coc7 };

export { handleSheetClick };

// one capture-phase listener for every rendered sheet's roll links
wireSheetRolls();
