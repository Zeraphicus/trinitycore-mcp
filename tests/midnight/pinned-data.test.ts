import { loadBuildManifest } from '../../src/version/BuildManifest';
import { queryDBC } from '../../src/tools/dbc';
import { getSpellInfo } from '../../src/tools/spell';
import { resetClientTables } from '../../src/tools/client-table';
import { resetSpellDetailTables } from '../../src/tools/spell-detail';
jest.mock('../../src/database/connection', () => ({ queryWorld: jest.fn(async () => []) }));
const pinned = process.env.MIDNIGHT_DATA_TEST === '1' ? describe : describe.skip;
pinned('pinned 12.1.0.69875 client files (opt in, never bundled)', () => {
  beforeAll(async () => { await loadBuildManifest(process.env.MCP_MANIFEST_PATH); });
  afterAll(() => { resetClientTables(); resetSpellDetailTables(); });
  test('direct ID 1296372 is a summon effect for spell 1282535', async () => {
    const r = await queryDBC('SpellEffect.db2', 1296372);
    expect(r.success).toBe(true); expect(r.recordId).toBe(1296372);
    expect(r.rowIndex).not.toBe(1296372); expect(r.parentId).toBe(1282535);
    expect(r.data).toMatchObject({ effect: 28, effectIndex: 1, effectMiscValue: [237409, 6636] });
    expect(await queryDBC('SpellEffect.db2', undefined, r.rowIndex)).toEqual(r);
  });
  test('SummonProperties 6636 is addressed by ID', async () => {
    const r = await queryDBC('SummonProperties.db2', 6636);
    expect(r.success).toBe(true); expect(r.data).toMatchObject({ id: 6636, control: 1, title: 3 });
  });
  test.each([
    [85948, 1, 30, 6, 0], [275430, 1, 28, 237409, 3772],
    [1282535, 1, 28, 237409, 6636], [1294026, 1, 28, 237409, 6706],
    [1294029, 1, 28, 237409, 6707], [1277098, 1, 28, 258578, 6686],
    [46585, 0, 28, 26125, 4973],
  ])('spell %i has the independently known effect', async (spellId, effectIndex, effect, miscValue1, miscValue2) => {
    const info: any = await getSpellInfo(spellId);
    expect(info.clientEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ effectIndex, effect, miscValue1, miscValue2 })
    ]));
    expect(info.serverSideEffects).toEqual([]);
  });
  test('Scourge Strike and Festering Strike names and later dummy slots', async () => {
    expect((await getSpellInfo(55090)).name).toBe('Scourge Strike');
    const f: any = await getSpellInfo(85948);
    expect(f.name).toBe('Festering Strike');
    expect(f.clientEffects.filter((e: any) => e.effectIndex >= 2).map((e: any) => e.effect)).toEqual([3, 3]);
  });
});
