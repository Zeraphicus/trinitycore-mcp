import { openClientTable } from './client-table';
import { SpellEffectSchema, SpellEffectName } from '../parsers/schemas/SpellEffectSchema';
import { getActiveBuild } from '../version/BuildManifest';

/** Field names map directly to SpellEffectSchema/DB2LoadInfo, including its SpellID relationship. */
export function getClientEffects(spellId: number) {
  if (!Number.isSafeInteger(spellId) || spellId <= 0) throw new Error('spellId must be a positive integer');
  const table = openClientTable('SpellEffect.db2');
  if (table.getLayoutHash() !== 0x5362e3d4 || table.getHeader().fieldCount !== 29) {
    throw new Error('SpellEffect layout mismatch: this parser requires layout 0x5362e3d4 with 29 inline fields');
  }
  const relation = table.getParentLookupTable();
  if (!relation) throw new Error('SpellEffect has no decoded SpellID relationship table');
  return relation.getChildren(spellId).map(rowIndex => {
    const record = table.getRecordByIndex(rowIndex)!;
    const e = SpellEffectSchema.parse(record);
    return {
      recordId: e.id, spellId: e.spellID, rowIndex, sectionId: record.getIdentity().sectionId,
      difficultyId: e.difficultyID, effectIndex: e.effectIndex, effect: e.effect,
      effectName: SpellEffectName[e.effect] ?? `EFFECT_${e.effect}`,
      aura: e.effectAura, triggerSpell: e.effectTriggerSpell,
      miscValue1: e.effectMiscValue[0], miscValue2: e.effectMiscValue[1],
      targetA: e.implicitTarget[0], targetB: e.implicitTarget[1],
      basePoints: e.effectBasePoints, radiusIndex: e.effectRadiusIndex[0],
      effectBonusCoefficient: e.effectBonusCoefficient, bonusCoefficientFromAP: e.bonusCoefficientFromAP,
      coefficient: e.coefficient, variance: e.variance, auraPeriod: e.effectAuraPeriod,
      chainTargets: e.effectChainTargets, pvpMultiplier: e.pvpMultiplier,
      provenance: { source: 'SpellEffect.db2', build: getActiveBuild().build,
        layoutHash: '0x5362e3d4', relation: 'SpellID', recordId: e.id },
    };
  }).sort((a, b) => a.difficultyId - b.difficultyId || a.effectIndex - b.effectIndex || a.recordId - b.recordId);
}

export type ClientEffect = ReturnType<typeof getClientEffects>[number];
