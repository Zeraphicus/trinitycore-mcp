import { extractClass } from '../../src/tools/source-api';
const source = `// class Guardian { fake };\nclass Guardian;\nclass TC_GAME_API Guardian : public Minion
{
 public:
  void InitStats(uint32 level);
  bool Active() const { return true; }
};
class Pet final : public Guardian { void Save(); };`;
test('extracts a definition, ignoring forward declarations and comments', () => {
  const result = extractClass(source, 'Guardian');
  expect(result?.text).toContain('InitStats');
  expect(result?.text).not.toContain('Save');
  expect(result?.line).toBe(3);
});
test('returns exact method declaration and line', () => {
  expect(extractClass(source, 'Guardian', 'InitStats')).toEqual({ line: 6, text: '  void InitStats(uint32 level);' });
});
test('missing methods and classes remain absent', () => {
  expect(extractClass(source, 'Guardian', 'Invented')).toBeNull();
  expect(extractClass(source, 'Minion')).toBeNull();
});
