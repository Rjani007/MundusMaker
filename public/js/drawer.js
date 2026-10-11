// Phone layout: below the breakpoint the entry list (#sidebar) is a drawer
// that the ☰ button slides over the page. PHONE must match the max-width of
// the phone block at the end of app.css.

const PHONE = window.matchMedia('(max-width: 700px)');

export function wireDrawer() {
  const toggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  const layout = document.getElementById('layout');
  const view = document.getElementById('view');
  const backdrop = document.getElementById('drawerBackdrop');
  const nav = document.getElementById('mainnav');
  const isOpen = () => layout.classList.contains('drawer-open');

  const setOpen = (open) => {
    open = open && PHONE.matches;
    if (open === isOpen()) return;
    layout.classList.toggle('drawer-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    // the page under the backdrop can't be tapped, so Tab must not reach it either
    view.inert = open;
    if (open) sidebar.focus({ preventScroll: true });
    // a tapped entry, or a backdrop tap that blurred the drawer: focus goes back
    // to the button, but never away from a nav link or control picked meanwhile
    else if (sidebar.contains(document.activeElement) || document.activeElement === document.body) toggle.focus({ preventScroll: true });
  };

  // focusable as a whole, so opening it doesn't summon the on-screen keyboard
  sidebar.tabIndex = -1;
  toggle.addEventListener('click', () => setOpen(!isOpen()));
  backdrop.addEventListener('click', () => setOpen(false));
  PHONE.addEventListener('change', () => { if (!PHONE.matches) setOpen(false); });
  window.addEventListener('hashchange', () => {
    setOpen(false);
    // route() marks the active tab after this listener; keep it in the strip's view
    setTimeout(() => {
      const a = nav.querySelector('a.active');
      if (!a || !PHONE.matches) return;
      const n = nav.getBoundingClientRect(), r = a.getBoundingClientRect();
      if (r.left < n.left) nav.scrollLeft -= n.left - r.left + 12;
      else if (r.right > n.right - 32) nav.scrollLeft += r.right - n.right + 44;
    }, 0);
  });
  // on document, so it runs before main.js's window listener: Ctrl+K focuses the
  // search box, which is out of sight while the drawer is closed
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && isOpen()) setOpen(false);
    else if ((ev.ctrlKey || ev.metaKey) && /^k$/i.test(ev.key)) setOpen(true);
  });
  wireKeyboard();
}

// The on-screen keyboard leaves a phone a few hundred pixels of page, so while
// something is typed into, the top bar keeps only its first row (app.css,
// body.keyboard-up). The keyboard shows as the page getting much shorter than
// it has been at this width.
function wireKeyboard() {
  const tallest = new Map(); // width -> tallest height seen: the height without a keyboard
  const typing = () => {
    const field = document.activeElement;
    return !!field && (field.tagName === 'TEXTAREA' || field.isContentEditable
      || (field.tagName === 'INPUT' && !/^(checkbox|radio|range|color|file|button|submit|reset|image)$/.test(field.type)));
  };
  const update = () => {
    const width = window.innerWidth, height = window.visualViewport?.height ?? window.innerHeight;
    if (height > (tallest.get(width) || 0)) tallest.set(width, height);
    document.body.classList.toggle('keyboard-up', PHONE.matches && typing() && height < tallest.get(width) * 0.8);
  };
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  document.addEventListener('focusin', update);
  document.addEventListener('focusout', () => setTimeout(update, 0)); // activeElement moves on after focusout
  update();
}
