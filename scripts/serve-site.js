'use strict';
// Serves site/ (the MundusMaker website) on http://localhost:<port> for local
// work. wiki/search.js comes from public/wiki/wiki.js, as the Pages workflow
// copies it, and app/ is the app in the browser, served straight from the
// repo by scripts/stage-web.js's list. The pages talk to the local Supabase
// stack (npx supabase start).
//   node scripts/serve-site.js [port]   (or PORT=...; default 4895)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { webEntries } = require('./stage-web');

const ROOT = path.join(__dirname, '..', 'site');
const SEARCH = path.join(__dirname, '..', 'public', 'wiki', 'wiki.js');
const port = Number(process.argv[2] || process.env.PORT || 4895);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
};

const notFound = (res) => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); };
const send = (res, name, data) => {
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(data);
};

http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { return notFound(res); }
  if (pathname === '/app') { res.writeHead(301, { Location: '/app/' }); res.end(); return; }
  if (pathname.startsWith('/app/')) {
    const rel = pathname.endsWith('/') ? `${pathname.slice(5)}index.html` : pathname.slice(5);
    const entry = webEntries({ build: 'dev' }).find((e) => e.path === rel);
    if (!entry) return notFound(res);
    return send(res, rel, entry.data || fs.readFileSync(entry.file));
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  let file = pathname === '/wiki/search.js' ? SEARCH : path.join(ROOT, path.normalize(pathname));
  if (file !== SEARCH && !file.startsWith(ROOT + path.sep)) file = null;
  if (!file) return notFound(res);
  fs.readFile(file, (err, data) => (err ? notFound(res) : send(res, file, data)));
}).listen(port, '127.0.0.1', () => console.log(`MundusMaker website on http://localhost:${port}`));
