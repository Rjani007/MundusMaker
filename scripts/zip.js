// Small ZIP32 writer for distributables. Explicit Unix modes make macOS/Linux
// launchers executable even when the release is assembled on Windows.
'use strict';
const fs = require('fs');
const zlib = require('zlib');
const table = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) value = table[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function writeZip(file, entries) {
  if (entries.length >= 65535) throw new Error('ZIP32 entry limit exceeded');
  const fd = fs.openSync(file, 'w'), central = [], seen = new Set();
  let offset = 0;
  function write(data) {
    let done = 0;
    while (done < data.length) done += fs.writeSync(fd, data, done, data.length - done);
    offset += data.length;
    if (offset >= 0xffffffff) throw new Error('ZIP32 size limit exceeded');
  }
  try {
    for (const entry of entries) {
      if (!entry.name || entry.name.startsWith('/') || /[\\\x00-\x1f:]/.test(entry.name) || entry.name.split('/').some(p => p === '..' || p === '.') || seen.has(entry.name)) throw new Error('Unsafe or duplicate ZIP path: ' + entry.name);
      seen.add(entry.name);
      const name = Buffer.from(entry.name, 'utf8'), directory = entry.name.endsWith('/');
      if (name.length > 65535) throw new Error('ZIP name too long');
      const data = directory ? Buffer.alloc(0) : entry.data ?? fs.readFileSync(entry.file);
      const compressed = directory ? data : zlib.deflateRawSync(data, { level: 9 });
      const crc = crc32(data), start = offset, method = directory ? 0 : 8;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
      header.writeUInt16LE(method, 8); header.writeUInt16LE(0x21, 12); // 1980-01-01: reproducible archive metadata
      header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
      write(header); write(name); write(compressed);
      const record = Buffer.alloc(46);
      record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE(0x314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8);
      record.writeUInt16LE(method, 10); record.writeUInt16LE(0x21, 14); record.writeUInt32LE(crc, 16);
      record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(data.length, 24); record.writeUInt16LE(name.length, 28);
      const mode = (directory ? 0o040000 : 0o100000) | (entry.mode ?? (directory ? 0o755 : 0o644));
      record.writeUInt32LE(((mode << 16) | (directory ? 0x10 : 0)) >>> 0, 38); record.writeUInt32LE(start, 42);
      central.push(record, name);
    }
    const start = offset;
    central.forEach(write);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(offset - start, 12); end.writeUInt32LE(start, 16); write(end);
  } finally { fs.closeSync(fd); }
}
module.exports = { crc32, writeZip };
