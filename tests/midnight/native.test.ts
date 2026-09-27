import * as path from 'path';
const addon = path.resolve(__dirname, '../../build/Release/casc_native.node');
afterEach(() => { jest.resetModules(); jest.dontMock(addon); });
test('missing native addon does not prevent import; requesting CASC fails clearly', () => {
  jest.doMock(addon, () => { throw new Error('native dependency missing'); }, { virtual: true });
  const { CASCStorage } = require('../../src/casc/CASCNative');
  expect(() => new CASCStorage('/client')).toThrow(/CASC native addon.*native dependency missing/);
});
test('available native storage remains callable', () => {
  const native = { isOpen: () => true };
  const constructor = jest.fn(() => native);
  jest.doMock(addon, () => ({ CASCStorage: constructor }), { virtual: true });
  const { CASCStorage } = require('../../src/casc/CASCNative');
  const storage = new CASCStorage('/client', 2);
  expect(constructor).toHaveBeenCalledWith('/client', 2);
  expect(storage.isOpen()).toBe(true);
});
