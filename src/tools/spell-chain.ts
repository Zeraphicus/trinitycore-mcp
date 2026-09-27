import { getSpellInfo } from './spell';
import { queryDBC } from './dbc';
import { queryWorld } from '../database/connection';
import { getActiveBuild } from '../version/BuildManifest';

export interface TraceOptions {
  maxDepth?: number;
  includeServerSide?: boolean;
  includeSummons?: boolean;
  includeCreature?: boolean;
  includeScripts?: boolean;
}
interface Node { id: string; type: string; status: string; data?: unknown; }
interface Edge { from: string; to: string; type: string; provenance: unknown; }

/** Only decoded triggers and summon parameters form execution edges. Bindings are associations. */
export async function traceSpellChain(spellId: number, options: TraceOptions = {}) {
  if (!Number.isSafeInteger(spellId) || spellId <= 0) throw new Error('spellId must be a positive integer');
  const maxDepth = options.maxDepth ?? 3;
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) throw new Error('maxDepth must be an integer from 0 to 10');
  for (const key of ['includeServerSide', 'includeSummons', 'includeCreature', 'includeScripts'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  }
  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const queue = [{ id: spellId, depth: 0 }];
  const visited = new Set<number>();
  const scheduled = new Set<number>([spellId]);
  const warnings: string[] = [];
  const edge = (from: string, to: string, type: string, provenance: unknown) => edges.push({ from, to, type, provenance });
  let truncated = false;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    const id = `spell:${current.id}`;
    const info = await getSpellInfo(current.id);
    nodes.set(id, { id, type: 'spell', status: info.error ? 'unavailable' : 'available',
      data: { spellId: current.id, name: info.name, error: info.error,
        clientEffectsStatus: info.clientEffectsStatus,
        ...(options.includeServerSide ? { serverSideEffects: info.serverSideEffects,
          serverSideEffectsStatus: info.serverSideEffectsStatus } : {}) } });
    if (info.clientEffectsStatus?.status === 'unavailable') warnings.push(`${id}: ${info.clientEffectsStatus.error}`);
    for (const effect of info.clientEffects ?? []) {
      if (nodes.size >= 2000 || edges.length >= 4000) { truncated = true; break; }
      const effectId = `effect:${effect.recordId}`;
      nodes.set(effectId, { id: effectId, type: 'clientEffect', status: 'available', data: effect });
      edge(id, effectId, 'HAS_EFFECT', effect.provenance);
      if (effect.triggerSpell > 0) {
        const target = `spell:${effect.triggerSpell}`;
        edge(effectId, target, 'TRIGGERS', { ...effect.provenance, field: 'EffectTriggerSpell' });
        if (!nodes.has(target)) nodes.set(target, { id: target, type: 'spell', status: 'depth-limit' });
        if (current.depth < maxDepth && !scheduled.has(effect.triggerSpell)) {
          if (scheduled.size >= 200) truncated = true;
          else { scheduled.add(effect.triggerSpell); queue.push({ id: effect.triggerSpell, depth: current.depth + 1 }); }
        }
      }
      if (options.includeSummons !== false && effect.effect === 28) {
        const creatureId = `creature:${effect.miscValue1}`;
        const propertiesId = `summonProperties:${effect.miscValue2}`;
        edge(effectId, creatureId, 'SUMMONS', { ...effect.provenance, field: 'EffectMiscValue[0]' });
        edge(effectId, propertiesId, 'REFERENCES', { ...effect.provenance, field: 'EffectMiscValue[1]' });
        if (!nodes.has(propertiesId)) {
          const result = await queryDBC('SummonProperties.db2', effect.miscValue2);
          nodes.set(propertiesId, { id: propertiesId, type: 'summonProperties',
            status: result.success ? 'available' : 'unavailable', data: result });
        }
        if (!nodes.has(creatureId)) {
          const node: Node = { id: creatureId, type: 'creature', status: 'not-requested' };
          if (options.includeCreature !== false) {
            try {
              const rows = await queryWorld('SELECT entry, name, subname, AIName, ScriptName FROM creature_template WHERE entry = ? LIMIT 1', [effect.miscValue1]);
              node.status = rows.length ? 'available' : 'missing';
              node.data = { source: 'world.creature_template', entry: effect.miscValue1, row: rows[0] ?? null };
            } catch (error) { node.status = 'unavailable'; node.data = { error: String(error) }; }
          }
          nodes.set(creatureId, node);
        }
      }
    }
    if (options.includeScripts) {
      try {
        const rows = await queryWorld('SELECT spell_id, ScriptName FROM spell_script_names WHERE spell_id IN (?, ?) LIMIT 100', [current.id, -current.id]);
        for (const row of rows) {
          const target = `script:${row.ScriptName}`;
          nodes.set(target, { id: target, type: 'scriptBinding', status: 'associated', data: row });
          edge(id, target, 'SCRIPT_BOUND', { source: 'world.spell_script_names', row,
            note: 'Binding association only; does not establish a direct execution edge.' });
        }
      } catch (error) { warnings.push(`Script bindings unavailable for ${current.id}: ${String(error)}`); }
    }
    if (truncated) break;
  }
  return { spellId, build: getActiveBuild().build, maxDepth, truncated,
    limits: { spells: 200, nodes: 2000, edges: 4000 }, nodes: [...nodes.values()], edges, warnings,
    note: 'Client triggers include all decoded difficulties. Server-side effects are separate annotations; script bindings are associations.' };
}
