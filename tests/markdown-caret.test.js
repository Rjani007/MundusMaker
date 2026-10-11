'use strict';
// A tap on a rendered block opens the editor at the tapped word (entity.js):
// shownChars() repeats the markdown grammar to map shown text back to the
// source, so it is checked against renderMarkdown() itself.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = require('./module-loader');

const EDGE_CASES = [
  'Plain words only.',
  'Go to [[Port Vellen|the port]] now, or [[ Kestrel Vane ]] will.',
  'a **bold** word, an *italic* one and `code` too',
  '***both*** and **unclosed and *half',
  'First line\nsecond line\n\n- item **one**\n- item [[Two]]\n\n> said the man\n>no space',
  'Image ![a map](/assets/w/map.png) between, ![remote](https://example.com/x.png) stays',
  "It's <b>not</b> HTML & \"quoted\" 2d6+3",
  'Windows\r\nline\r\n\r\n- ends',
  'trailing blanks   \n  leading blanks',
  '- ',
  '',
];

function sampleTexts() {
  const dir = path.join(__dirname, '..', 'sample', 'entities');
  const texts = [];
  for (const name of fs.readdirSync(dir)) {
    const entity = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
    for (const block of entity.blocks || []) if (typeof block.text === 'string' && block.text) texts.push(block.text);
  }
  return texts;
}

test('shownChars marks exactly the characters renderMarkdown shows', async () => {
  const { shownChars, renderMarkdown, unesc } = await load('markdown.js');
  const hooks = { link: (target, display) => (display || target).trim(), image: () => '' };
  const texts = [...EDGE_CASES, ...sampleTexts()];
  assert.ok(texts.length > 20, 'the sample world has text to check');
  for (const text of texts) {
    const rendered = unesc(renderMarkdown(text, hooks).replace(/<[^>]*>/g, ''));
    const kind = shownChars(text);
    assert.equal(kind.length, text.length);
    assert.equal(text.split('').filter((_, i) => kind[i]).join(''), rendered, JSON.stringify(text));
  }
});

test('a tap lands in the source next to the word it hit, outside links and bold runs', async () => {
  const { sourceCaret } = await load('markdown.js');
  // shown: the rendered text before the caret; blanks are not counted
  const at = (text, shown, startOfNext = /\s$/.test(shown) || shown === '') => sourceCaret(text, shown.replace(/\s/g, '').length, startOfNext);
  assert.equal(at('The keeper sleeps', 'The kee'), 7);
  const link = 'Go to [[Port Vellen|the port]] now';
  assert.equal(at(link, 'Go to '), 6, 'before the link, not inside its target');
  assert.equal(at(link, 'Go to the po'), link.indexOf('rt]]'), 'inside the shown words');
  assert.equal(at(link, 'Go to the port'), link.indexOf(' now'), 'after the link');
  const bold = 'a **bold** word';
  assert.equal(at(bold, 'a '), 2);
  assert.equal(at(bold, 'a bold'), bold.indexOf(' word'));
  const lines = 'First line\n\n- item one\n> said';
  assert.equal(at(lines, 'First line'), 10, 'the end of a line');
  assert.equal(at(lines, 'First line\n', true), lines.indexOf('item'), 'the start of a list item, after its marker');
  assert.equal(at(lines, 'First line\nitem one\n', true), lines.indexOf('said'), 'after a quote marker');
  assert.equal(at(lines, ''), 0);
  assert.equal(at(lines, 'First line item one said'), lines.length, 'past the end');
  assert.equal(at('', ''), 0);
});
