import { queryDBC } from '../../src/tools/dbc';
import { openClientTable } from '../../src/tools/client-table';
import { DB2FileLoader } from '../../src/parsers/db2/DB2FileLoader';
import { DB2MemorySource } from '../../src/parsers/db2/DB2FileSource';
import { denseFixture } from './fixtures';
jest.mock('../../src/tools/client-table');
beforeEach(() => {
  const loader = new DB2FileLoader(); loader.load(new DB2MemorySource(denseFixture()));
  (openClientTable as jest.Mock).mockReturnValue(loader);
});
test('query-dbc accepts IDs beyond row count and reports ordinal separately', async () => {
  expect(await queryDBC('Fixture.db2', 1296372)).toMatchObject({ success: true, recordId: 1296372, rowIndex: 1, parentId: 85949 });
  expect(await queryDBC('Fixture.db2', undefined, 1)).toMatchObject({ success: true, recordId: 1296372, rowIndex: 1 });
  expect(await queryDBC('Fixture.db2', 1)).toMatchObject({ success: false, error: expect.stringContaining('not found') });
});
test.each([[undefined, undefined], [1, 1], [-1, undefined], [1.2, undefined], [undefined, 999]])('rejects invalid lookup %s/%s', async (id, row) => {
  expect((await queryDBC('Fixture.db2', id, row)).success).toBe(false);
});
