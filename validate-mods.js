#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const modsDir = path.join(__dirname, 'mods');
const modDirs = fs.readdirSync(modsDir).filter(d =>
  fs.statSync(path.join(modsDir, d)).isDirectory()
);

let errors = 0;

for (const mod of modDirs) {
  const jsonPath = path.join(modsDir, mod, 'mod.json');
  if (!fs.existsSync(jsonPath)) {
    console.error(`[${mod}] missing mod.json`);
    errors++;
    continue;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    console.error(`[${mod}] invalid JSON: ${e.message}`);
    errors++;
    continue;
  }

  for (const field of ['name', 'version', 'description']) {
    if (!manifest[field]) {
      console.error(`[${mod}] missing required field: ${field}`);
      errors++;
    }
  }

  if (manifest.version && !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    console.error(`[${mod}] invalid version "${manifest.version}" (expected x.y.z)`);
    errors++;
  }

  if ((manifest.display === 'panel' || manifest.display === 'tab') && !manifest.entry) {
    console.error(`[${mod}] display="${manifest.display}" requires an "entry" field`);
    errors++;
  }
}

if (errors) {
  console.error(`\n${errors} error(s) found. Fix mod.json files before release.`);
  process.exit(1);
} else {
  console.log(`All ${modDirs.length} mods validated successfully.`);
}
