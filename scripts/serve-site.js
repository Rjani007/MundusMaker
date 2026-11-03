'use strict';
// Serves site/ (the MundusMaker website) on http://localhost:<port> for local
// work. wiki/search.js comes from public/wiki/wiki.js, as the Pages workflow
// copies it. The pages talk to the local Supabase stack (npx supabase start).
//   node scripts/serve-site.js [port]   (or PORT=...; default 4895)
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'site');
const SEARCH = path.join(__dirname, '..', 'public', 'wiki', 'wiki.js');
const port = Number(process.argv[2] || process.env.PORT || 4895);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

http.createServer((req, res) => {
  let file;
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    file = pathname === '/wiki/search.js' ? SEARCH : path.join(ROOT, path.normalize(pathname));
    if (file !== SEARCH && !file.startsWith(ROOT + path.sep)) file = null;
  } catch { file = null; }
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`MundusMaker website on http://localhost:${port}`));
