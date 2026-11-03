// Reads a ZIP in the browser: stored and deflated entries, which is what
// MundusMaker's exports write (zipFilesCompressed in handouts/output.js).
// No dependencies; inflating uses the browser's DecompressionStream.

export async function readZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('This file is not a ZIP.');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const names = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || view.getUint32(at, true) !== 0x02014b50) throw new Error('This ZIP is damaged.');
    const method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = names.decode(buf.subarray(at + 46, at + 46 + nameLength));
    at += 46 + skip;
    entries.push({
      name, size, dir: name.endsWith('/'),
      async bytes() {
        if (local + 30 > buf.length || view.getUint32(local, true) !== 0x04034b50) throw new Error('This ZIP is damaged.');
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const data = buf.subarray(start, start + packed);
        let out;
        if (method === 0) out = data.slice();
        else if (method === 8) {
          out = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
        } else throw new Error(`${name} is compressed in a way MundusMaker doesn't use.`);
        if (out.length !== size) throw new Error('This ZIP is damaged.');
        return out;
      },
    });
  }
  return entries;
}
