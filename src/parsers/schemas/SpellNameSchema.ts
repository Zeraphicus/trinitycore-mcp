import { DB2Record } from '../db2/DB2Record';

/** SpellName has one localized string and an external ID; no gameplay columns. */
export class SpellNameSchema {
  static readonly SCHEMA_NAME = 'SpellNameSchema';
  static readonly VALID_BUILDS = { from: 69875, to: 69875 };
  static readonly LAYOUT_HASHES = new Map<number, number>([[69875, 0x782ee721]]);
  static parse(record: DB2Record) { return { id: record.getId(), name: record.getString(0) }; }
}
