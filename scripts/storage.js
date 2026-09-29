'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');

// The temporary file is on the same volume as its destination. Never unlink
// the old file to work around a failed rename: it is the user's last good copy.
function atomicWrite(file, contents) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, 'wx');
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

function revision(contents) {
  return '"' + createHash('sha256').update(contents).digest('hex') + '"';
}

function readVersion(file) {
  try {
    const bytes = fs.readFileSync(file);
    return { bytes, revision: revision(bytes) };
  } catch (err) {
    if (err.code === 'ENOENT') return { bytes: null, revision: null };
    throw err;
  }
}

module.exports = { atomicWrite, revision, readVersion };
