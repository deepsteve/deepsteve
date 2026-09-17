// The Fly TikTok app's tests: its brain, the 3D layout of the brain, and the phone bridge's pure
// parts. They are ES modules like the app (test/unit/fly-tiktok/), loaded here under the unit
// suite's *.test.js glob.
//
// Run: node --test test/unit/fly-tiktok.test.js

(async () => {
  await import('./fly-tiktok/brain.test.mjs');
  await import('./fly-tiktok/cns.test.mjs');
  await import('./fly-tiktok/task-clock.test.mjs');
  await import('./fly-tiktok/phone-bridge-lib.test.mjs');
})();
