import { queryHotfixes } from '../database/connection';

// Deliberately limited to client investigation data. No arbitrary SQL or identifier input.
export const HOTFIX_TABLES = ['spell_name', 'spell_effect', 'summon_properties', 'creature',
  'creature_display_info', 'spell_misc', 'spell_aura_options', 'spell_aura_restrictions',
  'spell_categories', 'spell_cooldowns', 'spell_levels', 'spell_power'] as const;

function allowed(table: string): string {
  if (!(HOTFIX_TABLES as readonly string[]).includes(table)) throw new Error('Hotfix table is not allowed');
  return `\`${table}\``;
}

export async function listHotfixTables() {
  const rows = await queryHotfixes('SHOW TABLES');
  const present = new Set(rows.flatMap((row: Record<string, unknown>) => Object.values(row)));
  return { tables: HOTFIX_TABLES.filter(table => present.has(table)), readOnly: true };
}

export async function describeHotfixTable(table: string) {
  const identifier = allowed(table);
  return { table, columns: await queryHotfixes(`SHOW COLUMNS FROM ${identifier}`), readOnly: true };
}

export async function queryHotfixRecord(table: string, id: number, verifiedBuild?: number) {
  const identifier = allowed(table);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error('ID must be a nonnegative safe integer');
  if (verifiedBuild !== undefined && !Number.isSafeInteger(verifiedBuild)) throw new Error('VerifiedBuild must be a safe integer');
  const description = await describeHotfixTable(table);
  const fields = new Set(description.columns.map((column: { Field: string }) => column.Field));
  if (!fields.has('ID')) throw new Error('This table has no ID column');
  if (verifiedBuild !== undefined && !fields.has('VerifiedBuild')) throw new Error('This table has no VerifiedBuild column');
  const params = verifiedBuild === undefined ? [id] : [id, verifiedBuild];
  const filter = verifiedBuild === undefined ? '' : ' AND `VerifiedBuild` = ?';
  const order = fields.has('VerifiedBuild') ? ' ORDER BY `VerifiedBuild` DESC' : '';
  const records = await queryHotfixes(`SELECT * FROM ${identifier} WHERE \`ID\` = ?${filter}${order} LIMIT 100`, params);
  return { table, id, verifiedBuild, records, limit: 100, possiblyTruncated: records.length === 100,
    provenance: 'Configured hotfix database; VerifiedBuild is preserved, not assumed to match the client.', readOnly: true };
}
