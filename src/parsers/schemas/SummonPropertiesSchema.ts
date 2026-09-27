import { DB2Record } from '../db2/DB2Record';

/** DB2Metadata/DB2LoadInfo: four signed scalars and a signed Flags[2] array. */
export class SummonPropertiesSchema {
  static readonly SCHEMA_NAME = 'SummonPropertiesSchema';
  static readonly VALID_BUILDS = { from: 69875, to: 69875 };
  static readonly LAYOUT_HASHES = new Map<number, number>([[69875, 0xa4ca5ecf]]);
  static parse(record: DB2Record) {
    return {
      id: record.getId(), control: record.getInt32(0), faction: record.getInt32(1),
      title: record.getInt32(2), slot: record.getInt32(3),
      flags: [record.getInt32(4, 0), record.getInt32(4, 1)],
    };
  }
}
