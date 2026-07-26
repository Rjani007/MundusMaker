// The in-world calendar: months and how long they are, the odd day that belongs
// to no month, the ages years are counted in, and the current date.
// Route #/calendar — replaces the dashboard's cramped Calendar card.
//
// NOTHING IS WRITTEN TO world.json BY OPENING THIS PAGE. Every control renders
// from calMonths()/slotsOf(), which supply the defaults (30-day months, no
// special days, no ages) without touching the data; world.calendar only grows a
// monthDays / intercalary / ages / todayDate key inside an event handler, i.e.
// after the user actually changes something. Five real worlds and every
// distributed 0.8 build must stay byte-identical on disk until edited.
//
// NO CLAMP: shortening a month never rewrites a date that falls past its end.
// Those entries are listed as a warning and left exactly as they are.
// NO REORDER: entity.date.month is a POSITION, so moving a month would silently
// redate everything. Months can only be appended, and only the last one can be
// removed — and only when nothing is dated in it. Do not add drag handles.

import { el, toast, slugify, uid, helpTip } from '../util.js';
import { state, visibleEntities, scheduleWorldSave } from '../state.js';
import { calMonths, slotsOf, formatDate } from '../calendar.js';

export function render(container) {
  const w = state.world;
  const cal = (w.calendar ??= {});   // state.js already guarantees this; no save is scheduled
  const save = scheduleWorldSave;
  const era = () => w.era || '';

  /**
   * Entities whose date matches. `n` counts ALL of them (a GM-only entry still
   * owns its date, and losing it would be real data loss); `names` only ever
   * holds entries the current view may show, so player preview never learns the
   * name of a hidden entry — just that a number of them exist.
   */
  function datedWhere(pred) {
    const n = [...state.entities.values()].filter((e) => e.date && pred(e.date)).length;
    const names = visibleEntities().filter((e) => e.date && pred(e.date)).map((e) => e.name);
    return { n, names, hidden: n - names.length };
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /**
   * A ✕ that survives being clicked out of a focused input. Same pattern (and
   * same reason) as entity.js ctrlBtn: mousedown blurs the field, blur can fire
   * `change`, `change` can rebuild the list — and the button is then a detached
   * node the click never reaches. Cancelling pointerdown's default keeps focus
   * put; `onclick` still fires, so Enter/Space still work for keyboard users.
   */
  function xBtn(title, onclick) {
    const b = el('button', { class: 'ghost danger small', title, onclick }, '✕');
    b.addEventListener('pointerdown', (ev) => ev.preventDefault());
    return b;
  }

  // ---------- months ----------

  const monthsWrap = el('div', {});
  const monthWarn = el('div', {});

  /**
   * Materialise monthDays[] — ONLY from an edit handler. The values written are
   * exactly what calMonths() was already showing in the boxes, so nothing the
   * user can see changes; it is a parallel array (never months:[{name,days}])
   * because a 0.8 build renders months.join(', ') into one text box and rewrites
   * the whole array from it. Parallel arrays degrade there; objects corrupt.
   */
  function monthDays() {
    const want = (cal.months || []).length;
    if (!Array.isArray(cal.monthDays) || cal.monthDays.length !== want) {
      cal.monthDays = calMonths(cal).map((m) => m.days);
    }
    return cal.monthDays;
  }

  function removeMonth(i) {
    const months = calMonths(cal);
    const name = months[i]?.name || `Month ${i + 1}`;
    const used = datedWhere((d) => !d.special && d.month === i + 1).n;
    if (used) {
      toast(`${name} can’t be removed — ${plural(used, 'entry is', 'entries are')} dated in it.`, 4500);
      return;
    }
    const after = (cal.intercalary || []).filter((ic) => (ic.after ?? 0) >= i + 1);
    if (after.length) {
      toast(`${name} can’t be removed — “${after[0].name || after[0].id}” sits after it. Move that day first.`, 5000);
      return;
    }
    cal.months.splice(i, 1);
    if (Array.isArray(cal.monthDays)) cal.monthDays.splice(i, 1);
    if (!cal.months.length) { cal.months = undefined; cal.monthDays = undefined; }
    save();
    refreshMonths();
    monthsChanged();
  }

  function addMonth() {
    if (!Array.isArray(cal.months)) cal.months = [];
    cal.months.push('');
    if (Array.isArray(cal.monthDays)) cal.monthDays.push(30);
    save();
    refreshMonths();
    monthsChanged();
    const inputs = monthsWrap.querySelectorAll('input.cal-name');
    inputs[inputs.length - 1]?.focus();
  }

  function refreshMonths() {
    monthsWrap.innerHTML = '';
    const months = calMonths(cal);
    if (!months.length) {
      monthsWrap.append(el('div', { class: 'muted small' },
        'No months yet — dates print as 1026.09.14. Add one to start naming them.'));
    }
    months.forEach((m, i) => {
      const nameInput = el('input', {
        class: 'cal-name', value: m.name, placeholder: `Month ${i + 1}`,
        oninput: (ev) => { cal.months[i] = ev.target.value; save(); monthsChanged(); },
      });
      // min/step before value — a number input snaps to the default step otherwise
      const daysInput = el('input', {
        class: 'cal-days', type: 'number', min: 1, step: 1, value: m.days,
        title: 'How many days in this month',
        oninput: (ev) => {
          const v = Math.round(Number(ev.target.value));
          if (!Number.isFinite(v) || v < 1) return;   // mid-typing "" — don't write junk
          monthDays()[i] = v;
          save();
          refreshWarn();
          refreshPreview();
        },
      });
      monthsWrap.append(el('div', { class: 'cal-row' },
        el('span', { class: 'cal-num' }, `${i + 1}.`),
        nameInput,
        daysInput,
        el('span', { class: 'cal-unit' }, 'days'),
        i === months.length - 1
          ? xBtn(`Remove ${m.name || 'the last month'}`, () => removeMonth(i))
          : el('span', { class: 'cal-nodel' })));
    });
  }

  function refreshWarn() {
    monthWarn.innerHTML = '';
    // Only complain about a length the user actually declared. A world that has
    // never touched monthDays is only *defaulting* to 30 and gets no warning.
    if (!Array.isArray(cal.monthDays)) return;
    const months = calMonths(cal);
    const rows = [];
    months.forEach((m, i) => {
      const over = datedWhere((d) => !d.special && d.month === i + 1 && Number.isFinite(d.day) && d.day > m.days);
      if (over.n) rows.push({ name: m.name || `Month ${i + 1}`, days: m.days, ...over });
    });
    if (!rows.length) return;
    monthWarn.append(el('div', { class: 'notice warn', style: 'margin-top:12px' },
      'Some dates fall past the end of their month. Nothing was changed — they are kept and shown exactly as written.',
      rows.map((r) => el('div', { class: 'small', style: 'margin-top:6px' },
        `${r.name} is ${plural(r.days, 'day', 'days')}: `,
        r.names.join(', '),
        r.hidden ? `${r.names.length ? ' + ' : ''}${plural(r.hidden, 'GM-only entry', 'GM-only entries')}` : ''))));
  }

  // ---------- special (intercalary) days ----------

  const interWrap = el('div', {});

  function removeInter(ic) {
    const used = datedWhere((d) => d.special === ic.id).n;
    if (used) {
      toast(`“${ic.name || ic.id}” can’t be removed — ${plural(used, 'entry is', 'entries are')} dated on it.`, 4500);
      return;
    }
    const arr = cal.intercalary || [];
    const i = arr.indexOf(ic);
    if (i >= 0) arr.splice(i, 1);
    if (!arr.length) cal.intercalary = undefined;
    save();
    refreshInter();
    refreshPreview();
  }

  const interName = el('input', {
    placeholder: 'e.g. Mid-year’s Day', style: 'flex:1;min-width:0',
  });
  function addInter() {
    const name = interName.value.trim();
    if (!name) { interName.focus(); return; }
    // The id is generated once and never follows a rename — entity dates point
    // at it. Renaming the day is safe; there is no id to keep in sync by hand.
    const base = slugify(name);
    const used = new Set((cal.intercalary || []).map((x) => x.id));
    let id = base;
    while (used.has(id)) id = `${base}-${uid().slice(0, 4)}`;
    (cal.intercalary ??= []).push({ id, name, after: calMonths(cal).length, days: 1 });
    interName.value = '';
    save();
    refreshInter();
    refreshPreview();
  }
  interName.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') addInter(); });

  function refreshInter() {
    interWrap.innerHTML = '';
    const list = [...(cal.intercalary || [])].sort((a, b) => (a.after ?? 0) - (b.after ?? 0));
    if (!list.length) {
      interWrap.append(el('div', { class: 'muted small' }, 'None yet.'));
      return;
    }
    const months = calMonths(cal);
    for (const ic of list) {
      const afterSel = el('select', {
        class: 'cal-after', title: 'Where in the year this day falls',
        onchange: (ev) => { ic.after = Number(ev.target.value); save(); refreshInter(); refreshPreview(); },
      },
        el('option', { value: 0 }, months.length ? `Before ${months[0].name || 'month 1'}` : 'At the start of the year'),
        months.map((m, i) => el('option', { value: i + 1 }, `After ${m.name || `month ${i + 1}`}`)));
      afterSel.value = String(Math.min(ic.after ?? 0, months.length));
      interWrap.append(el('div', { class: 'cal-row' },
        el('input', {
          class: 'cal-name', value: ic.name || '', placeholder: 'Name of the day',
          oninput: (ev) => { ic.name = ev.target.value; save(); refreshPreview(); },
        }),
        afterSel,
        el('input', {
          class: 'cal-days', type: 'number', min: 1, step: 1, value: ic.days ?? 1,
          title: 'How many days it lasts',
          oninput: (ev) => {
            const v = Math.round(Number(ev.target.value));
            if (!Number.isFinite(v) || v < 1) return;
            ic.days = v;
            save();
          },
        }),
        el('span', { class: 'cal-unit' }, 'days'),
        xBtn(`Remove ${ic.name || ic.id}`, () => removeInter(ic))));
    }
  }

  // ---------- ages ----------

  const agesWrap = el('div', {});
  const ageName = el('input', { placeholder: 'e.g. Age of Ash', style: 'flex:1;min-width:0' });
  const ageYear = el('input', { class: 'cal-year', type: 'number', step: 1, placeholder: 'Starts' });

  function addAge() {
    const name = ageName.value.trim();
    if (!name) { ageName.focus(); return; }
    const y = Math.round(Number(ageYear.value));
    (cal.ages ??= []).push({ name, startYear: Number.isFinite(y) && ageYear.value.trim() !== '' ? y : 0 });
    ageName.value = '';
    ageYear.value = '';
    save();
    refreshAges();
    refreshPreview();
  }
  ageName.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') addAge(); });
  ageYear.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') addAge(); });

  // The rows show ages in start-year order, but re-sorting on every keystroke
  // would make rows jump under the cursor — so the year is SAVED on input and
  // the list is only rebuilt on change, and then only if the order really moved.
  const sortedAges = () => [...(cal.ages || [])].sort((a, b) => (a.startYear ?? 0) - (b.startYear ?? 0));
  let ageOrder = [];
  function reorderAges() {
    const next = sortedAges();
    if (next.length !== ageOrder.length || next.some((a, i) => a !== ageOrder[i])) refreshAges();
  }

  function refreshAges() {
    agesWrap.innerHTML = '';
    const list = sortedAges();
    ageOrder = list;
    if (!list.length) {
      agesWrap.append(el('div', { class: 'muted small' },
        `None — years print with the era suffix${era() ? ` “${era()}”` : ''}.`));
      return;
    }
    for (const age of list) {
      agesWrap.append(el('div', { class: 'cal-row' },
        el('input', {
          class: 'cal-name', value: age.name || '', placeholder: 'Name of the age',
          oninput: (ev) => { age.name = ev.target.value; save(); refreshPreview(); },
        }),
        el('span', { class: 'cal-unit' }, 'from year'),
        el('input', {
          class: 'cal-year', type: 'number', step: 1, value: age.startYear ?? '',
          title: 'The first year of this age',
          // saved on input — blur never fires in a background tab
          oninput: (ev) => {
            const raw = ev.target.value.trim();
            const v = Math.round(Number(raw));
            age.startYear = raw === '' || !Number.isFinite(v) ? undefined : v;
            save();
            refreshPreview();
          },
          onchange: () => { reorderAges(); refreshPreview(); },
        }),
        xBtn(`Remove ${age.name || 'this age'}`, () => {
          const arr = cal.ages || [];
          const i = arr.indexOf(age);
          if (i >= 0) arr.splice(i, 1);
          if (!arr.length) cal.ages = undefined;
          save();
          refreshAges();
          refreshPreview();
        })));
    }
  }

  // ---------- today ----------

  const todaySlot = el('select', {
    class: 'cal-after',
    onchange: (ev) => {
      const v = ev.target.value;
      const d = (cal.todayDate ??= {});
      // month and special are mutually exclusive — picking one drops the other
      if (!v) { delete d.month; delete d.special; }
      else if (v.startsWith('m:')) { d.month = Number(v.slice(2)); delete d.special; }
      else { d.special = v.slice(2); delete d.month; }
      pruneToday();
      save();
      refreshTodayLine();
      refreshPreview();
    },
  });

  function fillSlotOptions() {
    todaySlot.innerHTML = '';
    todaySlot.append(el('option', { value: '' }, '— no month —'));
    for (const s of slotsOf(cal)) {
      todaySlot.append(s.kind === 'month'
        ? el('option', { value: `m:${s.month}` }, s.name || `Month ${s.month}`)
        : el('option', { value: `s:${s.id}` }, `${s.name || s.id} (special day)`));
    }
    const t = cal.todayDate || {};
    const want = t.special ? `s:${t.special}` : Number.isFinite(t.month) ? `m:${t.month}` : '';
    // A month or special day the calendar no longer declares keeps its own
    // option rather than being silently reset to "none" (no clamp).
    if (want && ![...todaySlot.options].some((o) => o.value === want)) {
      todaySlot.append(el('option', { value: want },
        t.special ? `${t.special} (no longer in the calendar)` : `Month ${t.month}`));
    }
    todaySlot.value = want;
  }

  function pruneToday() {
    const d = cal.todayDate;
    if (!d) return;
    for (const k of ['year', 'month', 'day', 'special']) {
      const v = d[k];
      if (v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) delete d[k];
    }
    if (!Object.keys(d).length) cal.todayDate = undefined;
  }

  const todayYear = el('input', {
    class: 'cal-year', type: 'number', step: 1, value: cal.todayDate?.year ?? '', placeholder: 'Year',
    oninput: (ev) => {
      const raw = ev.target.value.trim();
      const v = Math.round(Number(raw));
      const d = (cal.todayDate ??= {});
      d.year = raw === '' || !Number.isFinite(v) ? undefined : v;
      pruneToday();
      save();
      refreshTodayLine();
      refreshPreview();
    },
  });

  const todayDay = el('input', {
    class: 'cal-days', type: 'number', min: 1, step: 1, value: cal.todayDate?.day ?? '', placeholder: 'Day',
    oninput: (ev) => {
      const raw = ev.target.value.trim();
      const v = Math.round(Number(raw));
      const d = (cal.todayDate ??= {});
      d.day = raw === '' || !Number.isFinite(v) || v < 1 ? undefined : v;
      pruneToday();
      save();
      refreshTodayLine();
      refreshPreview();
    },
  });

  const todayText = el('input', {
    value: cal.today || '', style: 'width:100%', placeholder: 'e.g. 14 Harvestmoon 1026 AR',
    oninput: (ev) => { cal.today = ev.target.value.trim() || undefined; save(); },
  });

  const todayLine = el('div', { class: 'cal-preview' });
  const useBtn = el('button', {
    class: 'small',
    title: 'Copy the date above into the line the Timeline prints',
    onclick: () => {
      const s = formatDate(cal.todayDate, cal, era());
      if (!s) { toast('Give the date a year first.'); return; }
      cal.today = s;
      todayText.value = s;
      save();
      toast('Printed date updated');
    },
  }, '↓ Use as the printed date');

  function refreshTodayLine() {
    const s = formatDate(cal.todayDate, cal, era());
    todayLine.textContent = s || '—';
  }

  // ---------- live preview ----------

  const previewWrap = el('div', {});

  /** A believable date in this calendar: today's where it is set, defaults otherwise. */
  function sampleDate() {
    const t = cal.todayDate || {};
    const ages = (cal.ages || []).filter((a) => Number.isFinite(a.startYear)).sort((a, b) => a.startYear - b.startYear);
    const year = Number.isFinite(t.year) ? t.year : (ages.length ? ages[ages.length - 1].startYear : 1026);
    if (t.special) return { year, special: t.special, day: t.day };
    if (Number.isFinite(t.month)) return { year, month: t.month, day: t.day ?? 14 };
    const first = slotsOf(cal).find((s) => s.kind === 'month');
    if (first) return { year, month: first.month, day: Math.min(14, first.days) };
    return { year };
  }

  function refreshPreview() {
    previewWrap.innerHTML = '';
    const sample = sampleDate();
    const lines = [['A date on an entry', formatDate(sample, cal, era())],
                   ['A year on its own', formatDate({ year: sample.year }, cal, era())]];
    const special = (cal.intercalary || [])[0];
    if (special) lines.push(['A special day', formatDate({ year: sample.year, special: special.id }, cal, era())]);
    for (const [label, text] of lines) {
      previewWrap.append(el('div', { class: 'row small', style: 'gap:8px' },
        el('span', { class: 'muted', style: 'width:135px;flex:none' }, `${label}:`),
        el('span', { class: 'cal-preview' }, text || '—')));
    }
  }

  /** Anything that shows a month name or position has to follow a month edit. */
  function monthsChanged() {
    refreshInter();
    refreshWarn();
    fillSlotOptions();
    refreshTodayLine();
    refreshPreview();
  }

  refreshMonths();
  refreshInter();
  refreshAges();
  refreshWarn();
  fillSlotOptions();
  refreshTodayLine();
  refreshPreview();

  // ---------- page ----------

  container.append(el('div', { class: 'page' },
    el('h1', {}, 'Calendar'),
    el('p', { class: 'muted small', style: 'margin:-8px 0 16px' },
      'How a year works in this world. Dates on individual entries are set on the entry itself — see the ',
      el('a', { href: '#/timeline' }, 'Timeline'), '.'),

    el('div', { class: 'card' },
      el('h3', {}, 'Months'),
      el('div', { class: 'small muted', style: 'margin-bottom:10px' },
        'In order, with their lengths. ',
        helpTip('Months are addressed by position, so an existing date like “14 Harvestmoon” means “month 9”. That is why months can’t be reordered, and why only the last one can be removed — and only if nothing is dated in it. Shortening a month never changes a date that was already written.')),
      monthsWrap,
      el('div', { class: 'cal-add' },
        el('button', { onclick: addMonth }, '+ Add month')),
      monthWarn),

    el('div', { class: 'card' },
      el('h3', {}, 'Special days'),
      el('div', { class: 'small muted', style: 'margin-bottom:10px' },
        'Single days that sit between months and belong to none of them — a midwinter feast, a leap day.'),
      interWrap,
      el('div', { class: 'cal-add' },
        interName,
        el('button', { onclick: addInter }, '+ Add day')),
      // Holidays are ENTRIES, not a list on the calendar — that is the one place
      // a GM looks for them, so the signpost belongs here.
      el('div', { class: 'small muted', style: 'margin-top:14px' },
        'Looking for holidays? A feast that falls on the same date every year is an ',
        el('strong', {}, 'entry'), ', not a calendar setting — make one (an Event works well), give it a date and tick ',
        el('strong', {}, '“Repeats every year”'), '. It then has its own page, its own secrets and its own backlinks, and shows up on the ',
        el('a', { href: '#/timeline' }, 'Timeline'), ' under “Every year”.')),

    el('div', { class: 'card' },
      el('h3', {}, 'Ages'),
      el('div', { class: 'small muted', style: 'margin-bottom:10px' },
        'Years stay absolute — an age only replaces the era suffix, so 1026 prints as “1026 Age of Ash”. Ages also band the ',
        el('a', { href: '#/timeline' }, 'Timeline'), ' and the exported book. ',
        helpTip('An age applies to every year from its first year until the next age begins. Numbering never restarts, so nothing you have already dated moves. Ages are not secret: a hidden age would change how unrelated years print and give itself away.')),
      agesWrap,
      el('div', { class: 'cal-add' },
        ageName, ageYear,
        el('button', { onclick: addAge }, '+ Add age'))),

    el('div', { class: 'card' },
      el('h3', {}, 'Preview'),
      previewWrap),

    el('div', { class: 'card' },
      el('h3', {}, 'Today in this world'),
      el('div', { class: 'cal-row' }, todayYear, todaySlot, todayDay),
      el('div', { class: 'row', style: 'margin-top:8px' },
        el('span', { class: 'muted small' }, 'Reads as:'), todayLine, el('span', { class: 'spacer' }), useBtn),
      el('div', { class: 'small muted', style: 'margin:14px 0 4px' },
        'Printed on the Timeline (free text — write it however you like):'),
      todayText)));
}
