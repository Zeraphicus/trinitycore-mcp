import { traceSpellChain } from '../../src/tools/spell-chain';
import { getSpellInfo } from '../../src/tools/spell';
import { queryDBC } from '../../src/tools/dbc';
jest.mock('../../src/tools/spell');
jest.mock('../../src/tools/dbc');
jest.mock('../../src/database/connection', () => ({ queryWorld: jest.fn(async () => []) }));
const spell = getSpellInfo as jest.Mock;
beforeEach(() => { jest.clearAllMocks(); });
const info = (id: number, triggers: number[] = []) => ({ spellId: id, name: `Spell ${id}`,
  clientEffectsStatus: { status: 'available' }, clientEffects: triggers.map((target, i) => ({
    recordId: id * 100 + i, effectIndex: i, effect: 64, triggerSpell: target,
    provenance: { source: 'SpellEffect.db2', recordId: id * 100 + i },
  })) });
test('cycles terminate and shared targets are expanded only once', async () => {
  spell.mockImplementation(async id => info(id, id === 1 ? [2, 2] : [1]));
  const r = await traceSpellChain(1, { maxDepth: 8 });
  expect(spell).toHaveBeenCalledTimes(2);
  expect(r.edges.filter(e => e.type === 'TRIGGERS')).toHaveLength(3);
});
test('maximum depth preserves evidence edges but does not expand beyond the boundary', async () => {
  spell.mockImplementation(async id => info(id, [id + 1]));
  const r = await traceSpellChain(1, { maxDepth: 0 });
  expect(spell).toHaveBeenCalledTimes(1);
  expect(r.nodes.find(n => n.id === 'spell:2')?.status).toBe('depth-limit');
});
test('missing referenced records are explicit and do not become invented data', async () => {
  spell.mockResolvedValue({ ...info(1), clientEffects: [{ recordId: 100, effect: 28,
    effectIndex: 0, miscValue1: 237409, miscValue2: 6636, triggerSpell: 0,
    provenance: { source: 'SpellEffect.db2', recordId: 100 } }] });
  (queryDBC as jest.Mock).mockResolvedValue({ success: false, error: 'Record not found' });
  const r = await traceSpellChain(1, { includeCreature: false });
  expect(r.nodes.find(n => n.id === 'summonProperties:6636')?.status).toBe('unavailable');
  expect(r.edges.some(e => e.type === 'SUMMONS')).toBe(true);
});
test('dummy effects do not imply a Lesser Ghoul edge', async () => {
  spell.mockResolvedValue({ ...info(85948), clientEffects: [{ recordId: 1, effect: 3, triggerSpell: 0 }] });
  const r = await traceSpellChain(85948);
  expect(r.edges.filter(e => e.type !== 'HAS_EFFECT')).toEqual([]);
});
test.each([-1, 11, 1.5])('rejects invalid depth %s', async maxDepth => {
  await expect(traceSpellChain(1, { maxDepth })).rejects.toThrow(/maxDepth/);
});
