'use strict';
const fs = require('node:fs'), path = require('node:path');
const cache = new Map(), root = path.resolve(__dirname, '../public/js');
function moduleUrl(file) {
  const absolute = path.resolve(root, file);
  if (cache.has(absolute)) return cache.get(absolute);
  const src = fs.readFileSync(absolute, 'utf8').replace(/from '(\.\.?\/[^']+)'/g, (_, rel) => `from '${moduleUrl(path.relative(root, path.resolve(path.dirname(absolute), rel)))}'`);
  const url = 'data:text/javascript;base64,' + Buffer.from(src).toString('base64'); cache.set(absolute, url); return url;
}
module.exports = file => import(moduleUrl(file));
