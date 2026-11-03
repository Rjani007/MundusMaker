// Player wiki search. Copied into every exported wiki as assets/wiki.js.
// The index arrives through <script src="assets/search-index.js">, because
// browsers refuse fetch() on file:// pages. Nothing here touches the network.
(function () {
  'use strict';
  var index = window.MUNDUS_WIKI_INDEX || [];
  var input = document.getElementById('wiki-search');
  var box = document.getElementById('wiki-results');
  if (!input || !box) return;

  function fold(s) {
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  }
  var folded = index.map(function (e) {
    return { t: fold(e.t), c: fold(e.c), x: fold(e.x) };
  });

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // A short excerpt around the first matching word, taken from the original
  // text. Folding can change lengths, so offsets are mapped per character.
  function excerpt(entry, words) {
    var text = entry.x || '';
    var lower = fold(text);
    var at = -1;
    for (var i = 0; i < words.length && at < 0; i++) at = lower.indexOf(words[i]);
    if (at < 0 || lower.length !== text.length) return escapeHtml(entry.s || '');
    var start = Math.max(0, at - 50), end = Math.min(text.length, at + 110);
    var out = escapeHtml(text.slice(start, end));
    words.forEach(function (w) {
      if (!w) return;
      var rx = new RegExp('(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
      out = out.replace(rx, '<mark>$1</mark>');
    });
    return (start ? '… ' : '') + out + (end < text.length ? ' …' : '');
  }

  function search(q) {
    var words = fold(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    var hits = [];
    folded.forEach(function (f, i) {
      var score = 0;
      for (var w = 0; w < words.length; w++) {
        var word = words[w];
        if (f.t === word) score += 100;
        else if (f.t.indexOf(word) === 0) score += 60;
        else if (f.t.indexOf(word) >= 0) score += 40;
        else if (f.c.indexOf(word) >= 0) score += 15;
        else if (f.x.indexOf(word) >= 0) score += 5;
        else return;
      }
      hits.push({ i: i, score: score });
    });
    hits.sort(function (a, b) {
      return b.score - a.score || index[a.i].t.localeCompare(index[b.i].t);
    });
    return hits.slice(0, 30).map(function (h) { return { entry: index[h.i], words: words }; });
  }

  var active = -1;
  function show() {
    var q = input.value.trim();
    active = -1;
    if (!q) { box.hidden = true; box.innerHTML = ''; return; }
    var hits = search(q);
    box.innerHTML = hits.length
      ? hits.map(function (h) {
        return '<a href="' + escapeHtml(h.entry.u) + '" role="option">' + escapeHtml(h.entry.t)
          + '<span class="r-type">' + escapeHtml(h.entry.c) + '</span>'
          + '<span class="r-snip">' + excerpt(h.entry, h.words) + '</span></a>';
      }).join('')
      : '<div class="none">Nothing matches “' + escapeHtml(q) + '”.</div>';
    box.hidden = false;
  }
  function move(step) {
    var links = box.querySelectorAll('a');
    if (!links.length) return;
    if (active >= 0) links[active].classList.remove('active');
    active = (active + step + links.length) % links.length;
    links[active].classList.add('active');
    links[active].scrollIntoView({ block: 'nearest' });
  }

  input.addEventListener('input', show);
  input.addEventListener('focus', show);
  input.addEventListener('keydown', function (ev) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
    else if (ev.key === 'Enter') {
      var links = box.querySelectorAll('a');
      var pick = links[active >= 0 ? active : 0];
      // a click, not a location change, so the online viewer can catch it
      if (pick) pick.click();
    } else if (ev.key === 'Escape') { input.value = ''; show(); input.blur(); }
  });
  document.addEventListener('click', function (ev) {
    if (!box.contains(ev.target) && ev.target !== input) box.hidden = true;
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === '/' && document.activeElement !== input && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      ev.preventDefault(); input.focus();
    }
  });
})();
