import { DB2CachedFileLoader } from "../../src/parsers/db2/DB2CachedFileLoader";
import { DB2FileLoader } from '../../src/parsers/db2/DB2FileLoader';
import { DB2MemorySource } from '../../src/parsers/db2/DB2FileSource';

import { denseFixture } from './fixtures';

test.each([false, true])('ID and ordinal are distinct (inline=%s)', inline => {
  const loader = new DB2FileLoader();
  loader.load(new DB2MemorySource(denseFixture(inline)));
  expect(loader.getRecord(6636).getId()).toBe(6636);
  expect(loader.getRecord(1296372).getUInt32(0)).toBe(29);
  expect(loader.getRecordByIndex(0)?.getId()).toBe(6636);
  expect(loader.getRecordByIndex(1)?.getId()).toBe(1296372);
  expect(() => loader.getRecord(1)).toThrow(/not found/);
  expect(loader.getParentLookupTable()?.getChildren(85949)).toEqual([1]);
});

test('single-record ID tables are loaded and reload discards old identity', () => {
  const loader = new DB2FileLoader();
  loader.load(new DB2MemorySource(denseFixture()));
  loader.load(new DB2MemorySource(denseFixture(false, true)));
  expect(loader.getRecord(6636).getId()).toBe(6636);
  expect(() => loader.getRecord(1296372)).toThrow(/not found/);
});

test('cached bulk reads use physical ordinals, while point reads use IDs', () => {
  const loader = new DB2CachedFileLoader('Fixture.db2');
  loader.load(new DB2MemorySource(denseFixture()));
  expect(loader.getAllRecords().map(r => r.getId())).toEqual([6636, 1296372]);
  expect(loader.getCachedRecord(1296372).getUInt32(0)).toBe(29);
});
