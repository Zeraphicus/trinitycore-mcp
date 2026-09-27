import { queryHotfixRecord, describeHotfixTable } from '../../src/tools/hotfix';
import { queryHotfixes } from '../../src/database/connection';
jest.mock('../../src/database/connection', () => ({ queryHotfixes: jest.fn() }));
const query = queryHotfixes as jest.Mock;
beforeEach(() => query.mockReset());
test.each(['spell_effect; DROP TABLE spell_effect', 'mysql.user', 'characters', '`spell_effect`'])('rejects table %s before SQL', async table => {
  await expect(queryHotfixRecord(table, 1)).rejects.toThrow(/allowed/);
  expect(query).not.toHaveBeenCalled();
});
test('record and VerifiedBuild are bound values, with a bounded result', async () => {
  query.mockResolvedValueOnce([{ Field: 'ID' }, { Field: 'VerifiedBuild' }]).mockResolvedValueOnce([{ ID: 6636 }]);
  expect((await queryHotfixRecord('summon_properties', 6636, 69875)).records).toEqual([{ ID: 6636 }]);
  expect(query.mock.calls[1]).toEqual([
    'SELECT * FROM `summon_properties` WHERE `ID` = ? AND `VerifiedBuild` = ? ORDER BY `VerifiedBuild` DESC LIMIT 100', [6636, 69875]
  ]);
});
test('describe uses only a constant allowlisted identifier', async () => {
  query.mockResolvedValue([{ Field: 'ID', Type: 'int' }]);
  expect((await describeHotfixTable('spell_effect')).columns).toHaveLength(1);
});
test('rejects SQL text masquerading as an ID', async () => {
  await expect(queryHotfixRecord('spell_effect', '1 OR 1=1' as any)).rejects.toThrow(/integer/);
  expect(query).not.toHaveBeenCalled();
});
