import { DB2FileLoader } from '../../src/parsers/db2/DB2FileLoader';
import { DB2MemorySource } from '../../src/parsers/db2/DB2FileSource';
import { getClientEffects } from '../../src/tools/client-effects';
import { openClientTable } from '../../src/tools/client-table';
import { getSpellInfo } from '../../src/tools/spell';
jest.mock('../../src/tools/client-table');
jest.mock('../../src/database/connection', () => ({ queryWorld: jest.fn(async (sql: string) =>
  sql.includes('FROM serverside_spell_effect') ? [{ effectIndex: 0, effect: 3 }] : [{ name: 'Fixture spell' }]) }));

// Synthetic WDC5 row using the source-verified field widths and array dimensions.
// The chosen values are the user's independent 69875 regression assertions.
function effectTable(effect: number, misc1: number, misc2: number, spellId: number, recordId: number) {
  const widths = Array.from({ length: 29 }, (_, f) => f < 2 || f === 28 ? 2 : 4);
  const counts = Array.from({ length: 29 }, (_, f) => f === 27 ? 4 : f >= 25 ? 2 : 1);
  let size = 0;
  const offsets = widths.map((width, f) => { const offset = size; size += width * counts[f]; return offset; });
  const start = 244 + 29 * 28;
  const b = Buffer.alloc(start + size + 4 + 20);
  b.write('WDC5'); b.writeUInt32LE(1, 136); b.writeUInt32LE(29, 140); b.writeUInt32LE(size, 144);
  b.writeUInt32LE(0x5362e3d4, 156); b.writeUInt32LE(recordId, 160); b.writeUInt32LE(recordId, 164);
  b.writeUInt16LE(4, 172); b.writeUInt32LE(29, 176); b.writeUInt32LE(1, 184);
  b.writeUInt32LE(29 * 24, 188); b.writeUInt32LE(1, 200);
  b.writeUInt32LE(start, 212); b.writeUInt32LE(1, 216); b.writeUInt32LE(4, 228); b.writeUInt32LE(20, 232);
  for (let f = 0; f < 29; f++) {
    b.writeInt16LE(32 - widths[f] * 8, 244 + f * 4); b.writeUInt16LE(offsets[f], 246 + f * 4);
    b.writeUInt16LE(offsets[f] * 8, 244 + 116 + f * 24);
    b.writeUInt16LE(widths[f] * counts[f] * 8, 246 + 116 + f * 24);
  }
  b.writeInt32LE(1, start + offsets[2]); b.writeUInt32LE(effect, start + offsets[3]);
  b.writeInt32LE(misc1, start + offsets[25]); b.writeInt32LE(misc2, start + offsets[25] + 4);
  b.writeUInt32LE(recordId, start + size);
  b.writeUInt32LE(1, start + size + 4); b.writeUInt32LE(spellId, start + size + 16);
  const loader = new DB2FileLoader(); loader.load(new DB2MemorySource(b, 'SpellEffect.db2')); return loader;
}

test.each([
  [85948, 30, 6, 0], [275430, 28, 237409, 3772], [1282535, 28, 237409, 6636],
  [1294026, 28, 237409, 6706], [1294029, 28, 237409, 6707], [1277098, 28, 258578, 6686],
])('decodes a source-layout fixture for spell %i without a client installation', (spellId, effect, miscValue1, miscValue2) => {
  (openClientTable as jest.Mock).mockReturnValue(effectTable(effect, miscValue1, miscValue2, spellId, 1296372));
  expect(getClientEffects(spellId)).toEqual([expect.objectContaining({ spellId, recordId: 1296372,
    effectIndex: 1, effect, miscValue1, miscValue2 })]);
});

test('get-spell-info keeps client effects separate from server-side overrides', async () => {
  (openClientTable as jest.Mock).mockReturnValue(effectTable(30, 6, 0, 85948, 87375));
  const info = await getSpellInfo(85948);
  expect(info.clientEffects?.[0].effect).toBe(30);
  expect(info.effects[0].effect).toBe(30);
  expect(info.serverSideEffects?.[0].effect).toBe(3);
});

test('unknown layout fails explicitly instead of returning empty client effects', () => {
  const loader = effectTable(28, 237409, 6636, 1282535, 1296372);
  jest.spyOn(loader, 'getLayoutHash').mockReturnValue(1234);
  (openClientTable as jest.Mock).mockReturnValue(loader);
  expect(() => getClientEffects(1282535)).toThrow(/layout mismatch/);
});
