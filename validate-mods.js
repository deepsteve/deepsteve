#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * Validate one parsed manifest. Pure — returns human-readable error strings, [] when clean.
 *
 * Exported so test/unit/mod-tools-source.test.js can exercise the rules directly.
 * release.sh:159 is the ONLY caller of the CLI below, so a rule enforced solely there is
 * a rule no pull request ever runs (#644).
 */
function validateManifest(mod, manifest) {
  const errors = [];

  for (const field of ['name', 'version', 'description']) {
    if (!manifest[field]) {
      errors.push(`[${mod}] missing required field: ${field}`);
    }
  }

  if (manifest.version && !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
    errors.push(`[${mod}] invalid version "${manifest.version}" (expected x.y.z)`);
  }

  if ((manifest.display === 'panel' || manifest.display === 'tab') && !manifest.entry) {
    errors.push(`[${mod}] display="${manifest.display}" requires an "entry" field`);
  }

  // #644: the tool inventory is derived from the mod's tools.js at MCP init and served by
  // GET /api/mods. A manifest copy is read by nothing and drifted the moment it existed.
  if ('tools' in manifest) {
    errors.push(`[${mod}] mod.json must not declare "tools" — tools.js is the only source of truth (#644). Delete the key.`);
  }

  return errors;
}

function main() {
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

    for (const msg of validateManifest(mod, manifest)) {
      console.error(msg);
      errors++;
    }
  }

  if (errors) {
    console.error(`\n${errors} error(s) found. Fix mod.json files before release.`);
    process.exit(1);
  } else {
    console.log(`All ${modDirs.length} mods validated successfully.`);
  }
}

// Guarded so requiring this file is side-effect free: the unit test imports
// validateManifest, and release.sh:184-186 embeds every root *.js into install.sh.
if (require.main === module) main();

module.exports = { validateManifest };
