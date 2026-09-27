import { jsonResponse } from '../../src/tools/registry/types';
test('BigInts retain exact decimal precision recursively without changing numbers', () => {
  const data = { large: 12345678901234567890n, id: 123n, nested: { values: [456n, 42, 1.5] } };
  expect(JSON.parse(jsonResponse(data).content[0].text!)).toEqual({
    large: '12345678901234567890', id: '123', nested: { values: ['456', 42, 1.5] }
  });
});
