// Copies the jsPDF UMD build out of node_modules into public/vendor so the app
// runs fully offline with no node_modules present. Run once after `npm install`.
'use strict';
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'jspdf', 'dist', 'jspdf.umd.min.js');
const destDir = path.join(__dirname, '..', 'public', 'vendor');
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, path.join(destDir, 'jspdf.umd.min.js'));
console.log('vendored jspdf.umd.min.js -> public/vendor/');
