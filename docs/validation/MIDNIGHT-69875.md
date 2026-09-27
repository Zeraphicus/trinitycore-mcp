# Midnight investigation tooling

The acceptance data is pinned to client 12.1.0.69875 and TrinityCore source
`08299e865e01d341240cbad4144afabc0975926b`. No gameplay source, client files,
database dumps, credentials, or machine paths are part of this change.

## Configuration and installation

Copy `config/builds.json` to ignored `config/builds.local.json`, configure its
active build and data paths, and set `MCP_MANIFEST_PATH=config/builds.local.json`
in `.env`. An example without machine paths is in `config/builds.midnight.example.json`.
Use a SELECT-only database account and the existing `TRINITY_DB_HOTFIXES` setting.
Never put database passwords into the manifest or commit `.env`.

`npm install` installs the JavaScript tools without implicitly building CascLib.
Native extraction remains opt-in through `npm run fetch:casclib` and
`npm run build:native`; missing native source/build material is not repaired here.
A missing addon is reported only when CASC storage is requested.

69875 has no verified opcode table. Its manifest entry deliberately omits
`opcodeTable`; no 69214/69497 table has been copied or relabeled.

## Query contracts

- `query-dbc` takes exactly one of `recordId` (actual DB2 identity) or `rowIndex`
  (physical zero-based position). Results preserve `recordId`, `rowIndex`,
  `sectionId`, and `parentId`. Lookup does not infer a spell ID from a record ID.
- `get-spell-info.clientEffects` contains decoded SpellEffect records, including
  difficulty and provenance. `serverSideEffects` remains separate. The legacy
  `effects` property now aliases base-difficulty **client** effects. This is an
  intentional semantic change for callers that previously consumed server effects.
  Availability statuses distinguish an empty table result from a read failure.
- `trace-spell-chain` follows `EffectTriggerSpell` and effect 28 summon parameters.
  `HAS_EFFECT`, `TRIGGERS`, `SUMMONS`, `REFERENCES`, and `SCRIPT_BOUND` edges retain
  their source. A script binding is an association, not proof of execution.
  Server-side effects are optional annotations, not merged execution edges.
  Other aura/proc relationships and summon effect variants are not inferred.
  Depth is 0–10 (default 3); spell/node/edge budgets bound expansion. Repeated
  spells are expanded once, and missing references remain visible.
- `get-trinity-api` extracts the configured checkout's declarations for summon
  classes and Spell/Map creation methods. It records the source path, line,
  revision and working-file digest. It is a declaration extractor, not a C++
  semantic parser or a complete call graph; inherited methods are not expanded.
- Hotfix tools accept an allowlisted table and numeric ID, optionally an exact
  `verifiedBuild`. SQL values are bound and queries return at most 100 rows.
  `VerifiedBuild` is reported as stored, never assumed to equal the client build.

## Field provenance

`clientEffects` maps `recordId` from the ID table; `spellId` from the section's
SpellID relationship; `difficultyId` from DifficultyID (field 1, signed short);
`effectIndex` from EffectIndex (2); `effect` from Effect (3); `aura` from
EffectAura (0); `triggerSpell` from EffectTriggerSpell (15); `miscValue1/2` from
EffectMiscValue[0/1] (25); and `targetA/B` from ImplicitTarget[0/1] (28).
The remaining numeric properties retain their matching SpellEffectSchema names.
Indices beyond the legacy three effect slots are preserved.

SummonProperties maps Control/Faction/Title/Slot to fields 0–3 and both signed
Flags elements to field 4. Flags are not reduced to one lossy combined Number.
All BigInt MCP values serialize as exact decimal strings recursively.

## Structural evidence and limits

`midnight-69875-metadata.json` records the five priority tables' actual file hashes,
headers, source metadata types, signedness, array dimensions, ID and parent fields,
and expanded DB2LoadInfo names where the configured source supplies them.
An external-ID header's IndexField is not meaningful: flags bit 0x4 denotes the
external ID table, corresponding to metadata IndexField = -1.

The three verified decoders are the dedicated SpellName parser, SpellEffect, and
SummonProperties. Their layout hashes, field mapping and decoded samples agree
with the pinned source and the assertions below. Creature and CreatureDisplayInfo
headers match metadata, but their typed decoders are **unverified**. The older
wide SpellSchema is also unverified: SpellName itself contains no gameplay columns.
The report contains 3 verified, 18 unverified, 0 mismatched, 0 missing schemas;
`summary.ok` is false while any schema is unverified.

The read-only hotfix cross-check found no matching rows for SpellEffect 1296372
or SummonProperties 6636. It therefore provides no independent hotfix value
verification for those IDs. The summon creature association resolves through
world.creature_template to entry 237409, Lesser Ghoul.

## Reproduce

```powershell
npm run build
npm test -- --runInBand --forceExit
npm run lint
$env:MIDNIGHT_DATA_TEST = '1'
$env:MCP_MANIFEST_PATH = 'config/builds.local.json'
npm test -- --runInBand tests/midnight/pinned-data.test.ts
node scripts/validate-midnight.js
```

The ordinary suite has synthetic WDC5 fixtures requiring no client installation.
The pinned-data suite explicitly skips without the opt-in flag. The standalone
test starts a real stdio MCP server and checks tools through the MCP SDK; its
local report is `logs/midnight-acceptance.json`.

The initial unmodified-local-config suite reported 23 opcode/startup failures
because upstream tests assume the checked-in 69497 manifest. Moving machine paths
and the active 69875 selection to the ignored manifest resolves that interference.
The baseline also left Jest open handles after reporting its results. `--forceExit`
is used for finite full-suite runs; it does not disable assertions, but it does not
prove shutdown cleanliness. No upstream test was weakened to conceal a failure.

## Required client assertions

| Spell | Index | Effect | MiscValue1 | MiscValue2 |
|---|---:|---:|---:|---:|
| 85948 Festering Strike | 1 | 30 ENERGIZE | 6 | 0 |
| 275430 Lesser Ghoul | 1 | 28 SUMMON | 237409 | 3772 |
| 1282535 | 1 | 28 SUMMON | 237409 | 6636 |
| 1294026 | 1 | 28 SUMMON | 237409 | 6706 |
| 1294029 | 1 | 28 SUMMON | 237409 | 6707 |
| 1277098 | 1 | 28 SUMMON | 258578 | 6686 |
| 46585 comparator | 0 | 28 SUMMON | 26125 | 4973 |

Festering Strike also has DUMMY effects at indices 2 and 3. Direct ID 1296372
resolves to SpellEffect row 608329, parent spell 1282535. SummonProperties 6636
resolves to row 1776, Control 1, Title 3, Flags `[4719122, 0]`.

These assertions establish readiness for the client effect/summon portion of the
Lesser Ghoul investigation. They do not establish a Festering Strike → Lesser Ghoul
execution relationship or fix the gameplay issue. Native CASC build repair,
verified 69875 opcodes, all-schema verification, and complete API coverage remain
outside this first PR.
