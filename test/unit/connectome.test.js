// The Connectome mod's tests. The mod is ES modules, so its tests are too (test/unit/connectome/),
// and this loads them under the unit suite's *.test.js glob.
//
// Run: node --test test/unit/connectome.test.js

(async () => {
  await import('./connectome/circuit.test.mjs');
  await import('./connectome/network.test.mjs');
})();
