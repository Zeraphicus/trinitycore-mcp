import * as fs from 'fs';
import * as path from 'path';
import { DB2FileLoader } from '../parsers/db2/DB2FileLoader';
import { DB2FileSystemSource } from '../parsers/db2/DB2FileSource';
import { resolveDataPath } from '../version/BuildManifest';

const tables = new Map<string, { loader: DB2FileLoader; source: DB2FileSystemSource }>();
let directory = '';

/** Cache identity belongs to the selected data directory, not just the table name. */
export function openClientTable(fileName: string): DB2FileLoader {
  if (!/^[A-Za-z0-9_]+\.db2$/i.test(fileName)) throw new Error('Expected a DB2 table filename without a path');
  const current = path.resolve(resolveDataPath('db2'));
  if (directory !== current) { resetClientTables(); directory = current; }
  const key = fileName.toLowerCase();
  const cached = tables.get(key);
  if (cached) return cached.loader;
  const actual = fs.readdirSync(current).find(name => name.toLowerCase() === key);
  if (!actual) throw new Error(`Client table unavailable: ${fileName}`);
  const source = new DB2FileSystemSource(path.join(current, actual));
  const loader = new DB2FileLoader();
  try { loader.load(source); } catch (error) { source.close(); throw error; }
  tables.set(key, { loader, source });
  return loader;
}

export function resetClientTables(): void {
  for (const table of tables.values()) table.source.close();
  tables.clear();
  directory = '';
}
