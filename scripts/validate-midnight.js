// Standalone stdio acceptance test. Uses ignored .env / MCP_MANIFEST_PATH.
// No client data or database credentials are written into the portable report.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env') });

async function main() {
  const client = new Client({ name: 'midnight-acceptance', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/index.js')],
    cwd: root, stderr: 'pipe', env: { ...process.env, LOG_LEVEL: 'error' } });
  if (transport.stderr) transport.stderr.on('data', () => {});
  const results = {};
  async function call(name, args) {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
    assert(!response.isError, `${name}: ${JSON.stringify(response.content)}`);
    return JSON.parse(response.content[0].text);
  }
  try {
    await client.connect(transport);
    const builds = await call('list-builds', {});
    assert.equal(builds.activeBuild, '12.1.0.69875');
    results.activeBuild = builds.activeBuild;
    results.spells = [];
    for (const [spellId, index, effect, misc1, misc2] of [
      [85948, 1, 30, 6, 0], [275430, 1, 28, 237409, 3772], [1282535, 1, 28, 237409, 6636],
      [1294026, 1, 28, 237409, 6706], [1294029, 1, 28, 237409, 6707], [1277098, 1, 28, 258578, 6686],
      [46585, 0, 28, 26125, 4973],
    ]) {
      const info = await call('get-spell-info', { spellId });
      const row = info.clientEffects.find(e => e.effectIndex === index && e.difficultyId === 0);
      assert(row, `Missing effect for ${spellId}`);
      assert.deepEqual([row.effect, row.miscValue1, row.miscValue2], [effect, misc1, misc2]);
      results.spells.push({ spellId, name: info.name, clientEffects: info.clientEffects,
        serverSideEffects: info.serverSideEffects, serverSideEffectsStatus: info.serverSideEffectsStatus });
    }
    results.effect = await call('query-dbc', { dbcFile: 'SpellEffect.db2', recordId: 1296372 });
    assert(results.effect.success); assert.equal(results.effect.parentId, 1282535);
    results.summon = await call('query-dbc', { dbcFile: 'SummonProperties.db2', recordId: 6636 });
    assert(results.summon.success); assert.equal(results.summon.data.control, 1); assert.equal(results.summon.data.title, 3);
    results.chain = await call('trace-spell-chain', { spellId: 1282535, includeScripts: true });
    assert(results.chain.edges.some(e => e.type === 'SUMMONS' && e.to === 'creature:237409'));
    const festering = await call('trace-spell-chain', { spellId: 85948, includeScripts: true });
    assert(!festering.edges.some(e => e.type === 'SUMMONS'));
    results.festeringChain = festering;
    results.schema = await call('validate-build-schemas', {});
    assert.equal(results.schema.summary.ok, false); // unfinished schemas must stay visible
    results.hotfixTables = await call('list-hotfix-tables', {});
    results.hotfix = await call('query-hotfix-record', { table: 'summon_properties', id: 6636 });
    results.hotfixEffect = await call('query-hotfix-record', { table: 'spell_effect', id: 1296372 });
    results.sourceAPI = [];
    for (const [className, methodName] of [['TempSummon'], ['Guardian'], ['Minion'], ['Pet'],
      ['Spell', 'EffectSummonType'], ['Spell', 'SummonGuardian'], ['Map', 'SummonCreature']]) {
      const response = await client.callTool({ name: 'get-trinity-api', arguments: { className, methodName } });
      assert(!response.isError);
      const text = response.content[0].text;
      assert(text.includes('Header SHA-256:') && text.includes('```cpp'), `${className}: no extracted declaration`);
      // Do not publish the machine path contained in the tool's full output.
      results.sourceAPI.push({ className, methodName, extracted: true,
        revision: /Checkout revision: (.*)/.exec(text)?.[1] });
    }
    results.status = 'PASS';
  } finally {
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'logs/midnight-acceptance.json'), JSON.stringify(results, null, 2));
    await client.close();
  }
  console.log(JSON.stringify({ status: results.status, build: results.activeBuild, spells: results.spells.length,
    effectId: results.effect.recordId, summonId: results.summon.recordId, schema: results.schema.summary,
    report: 'logs/midnight-acceptance.json' }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
