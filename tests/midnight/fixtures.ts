// Tiny synthetic WDC5, not a redistributed client file. Two one-row sections.
export function denseFixture(inline = false, single = false): Buffer {
  const n = single ? 1 : 2;
  const start = 204 + n * 40 + 8 + 48;
  const sectionSize = 8 + (inline ? 0 : 4) + 20;
  const b = Buffer.alloc(start + sectionSize * n);
  b.write('WDC5'); b.writeUInt32LE(n, 136); b.writeUInt32LE(2, 140);
  b.writeUInt32LE(8, 144); b.writeUInt32LE(6636, 160);
  b.writeUInt32LE(single ? 6636 : 1296372, 164);
  b.writeInt16LE(inline ? 1 : -1, 174); b.writeUInt32LE(2, 176);
  b.writeUInt32LE(1, 184); b.writeUInt32LE(48, 188); b.writeUInt32LE(n, 200);
  const fields = 204 + n * 40;
  b.writeUInt16LE(4, fields + 6);
  for (let f = 0; f < 2; f++) {
    b.writeUInt16LE(f * 32, fields + 8 + f * 24);
    b.writeUInt16LE(32, fields + 10 + f * 24);
  }
  for (let i = 0; i < n; i++) {
    const h = 204 + i * 40, offset = start + i * sectionSize;
    const id = i === 0 ? 6636 : 1296372;
    b.writeUInt32LE(offset, h + 8); b.writeUInt32LE(1, h + 12);
    b.writeUInt32LE(inline ? 0 : 4, h + 24); b.writeUInt32LE(20, h + 28);
    b.writeUInt32LE(28 + i, offset); b.writeUInt32LE(inline ? id : 42, offset + 4);
    if (!inline) b.writeUInt32LE(id, offset + 8);
    const rel = offset + 8 + (inline ? 0 : 4);
    b.writeUInt32LE(1, rel); b.writeUInt32LE(85948 + i, rel + 12);
    b.writeUInt32LE(0, rel + 16); // section-local row index
  }
  return b;
}

