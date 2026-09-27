import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';

const HEADERS: Record<string, string> = {
  TempSummon: 'Entities/Creature/TemporarySummon.h', Minion: 'Entities/Creature/TemporarySummon.h',
  Guardian: 'Entities/Creature/TemporarySummon.h', Pet: 'Entities/Pet/Pet.h',
  Spell: 'Spells/Spell.h', Map: 'Maps/Map.h', Player: 'Entities/Player/Player.h',
  Unit: 'Entities/Unit/Unit.h', Creature: 'Entities/Creature/Creature.h',
};

/** Mask comments and strings while preserving offsets/lines for source citations. */
function mask(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g,
    text => text.replace(/[^\n]/g, ' '));
}

export function extractClass(source: string, className: string, methodName?: string) {
  if (!/^[A-Za-z_]\w*$/.test(className) || (methodName && !/^[A-Za-z_]\w*$/.test(methodName))) {
    throw new Error('Expected a C++ class/method identifier');
  }
  const clean = mask(source);
  const start = new RegExp(`\\bclass\\s+(?:[A-Z_]+\\s+)?${className}\\b[^;{]*\\{`).exec(clean);
  if (!start) return null;
  const open = start.index + start[0].length - 1;
  let depth = 1, end = open + 1;
  while (depth > 0 && end < clean.length) {
    if (clean[end] === '{') depth++;
    if (clean[end] === '}') depth--;
    end++;
  }
  if (depth) throw new Error(`Unterminated class ${className}`);
  if (!methodName) return { line: source.slice(0, start.index).split('\n').length, text: source.slice(start.index, end + 1) };
  const body = clean.slice(open + 1, end - 1);
  const match = new RegExp(`\\b${methodName}\\s*\\(`).exec(body);
  if (!match) return null;
  const offset = open + 1 + match.index;
  const lineStart = source.lastIndexOf('\n', offset) + 1;
  const terminator = clean.slice(offset).search(/[;{]/);
  return { line: source.slice(0, lineStart).split('\n').length,
    text: source.slice(lineStart, offset + terminator + 1).trimEnd() };
}

/** Extract the configured checkout on demand; never substitute authored prose for source. */
export function getSourceAPI(className: string, methodName?: string): string | null {
  const relative = HEADERS[className];
  if (!relative) return null;
  const root = process.env.TRINITY_ROOT;
  if (!root) return `Source API unavailable: set TRINITY_ROOT to the TrinityCore checkout (${className}).`;
  const file = path.join(root, 'src/server/game', relative);
  if (!fs.existsSync(file)) return `Source API unavailable: header not found at ${file}`;
  const source = fs.readFileSync(file, 'utf8');
  const result = extractClass(source, className, methodName);
  if (!result) return `Declaration ${className}${methodName ? `::${methodName}` : ''} not found in ${file}.`;
  let revision = 'unavailable';
  try { revision = execFileSync('git', ['-c', `safe.directory=${path.resolve(root).replace(/\\/g, '/')}`, '-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Non-Git source distributions remain usable. */ }
  const hash = createHash('sha256').update(source).digest('hex');
  return `# ${className}${methodName ? `::${methodName}` : ''}\n\nExtracted declaration (not semantic call-graph analysis).\nSource: ${file}:${result.line}\nCheckout revision: ${revision}\nHeader SHA-256: ${hash}\nThe digest identifies the working file, including local modifications.\n\n\`\`\`cpp\n${result.text}\n\`\`\``;
}
