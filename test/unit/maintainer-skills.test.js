// Drift guard for maintainer-only skills.
//
// `skills/release.md` drives *this repo's* release process — it bumps the version, pushes
// tags, and publishes to GitHub. It has nothing to do with the project a user points
// DeepSteve at, so it must not reach them: not in the generated `install.sh`, and not on
// the public skills page at deepsteve.com. It lives only in a git clone, disabled like
// every other skill until someone turns it on in Mods.
//
// The mechanism is one frontmatter key. `release.sh` skips any skill whose frontmatter
// carries `maintainer: true` when embedding, and emits an `rm -f` for it so an upgrade
// clears the copy an older build left in ~/.deepsteve/skills. Both halves matter: without
// the skip it ships to everyone, without the rm it lingers in every existing install.
//
// The failure mode this catches is silent. Drop the key while editing the frontmatter and
// nothing breaks, nothing warns — the next `release.sh` just quietly puts a
// "publish a DeepSteve release" command in front of every user.
//
// Pure file reads — no server boot, no shell — so it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/maintainer-skills.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SKILLS_DIR = path.join(ROOT, 'skills');

const releaseSh = fs.readFileSync(path.join(ROOT, 'release.sh'), 'utf8');
const releasingMd = fs.readFileSync(path.join(ROOT, 'RELEASING.md'), 'utf8');

/** Frontmatter of one skill file, parsed the way server.js parseSkillFrontmatter does. */
function frontmatter(id) {
  const content = fs.readFileSync(path.join(SKILLS_DIR, `${id}.md`), 'utf8');
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return meta;
}

const skillIds = fs.readdirSync(SKILLS_DIR)
  .filter(f => f.endsWith('.md'))
  .map(f => f.slice(0, -3))
  .sort();

const maintainerOnly = skillIds.filter(id => frontmatter(id).maintainer === 'true');

test('skills/release.md is still marked maintainer-only', () => {
  assert.ok(skillIds.includes('release'), 'skills/release.md is gone — update this guard');
  assert.strictEqual(frontmatter('release').maintainer, 'true',
    'skills/release.md must keep `maintainer: true` in its frontmatter. Without it, release.sh\n' +
    '  embeds it into install.sh and every DeepSteve user gets a /deepsteve:release command\n' +
    '  that publishes releases of this repo.');
});

test('withholding does not swallow the user-facing skills', () => {
  // A predicate that matched everything would produce an installer with no skills at all
  // and no error anywhere. Pin that the withheld set is a strict, small subset.
  assert.ok(maintainerOnly.length < skillIds.length,
    'every skill is marked maintainer-only — install.sh would ship none of them');
  const shipped = skillIds.filter(id => !maintainerOnly.includes(id));
  assert.ok(shipped.length > 0, 'no skill is left for the installed build');
});

/** The body of release.sh's `for skill in skills/*.md` loop. */
function skillEmbedLoop() {
  const match = releaseSh.match(/for skill in skills\/\*\.md; do\n([\s\S]*?)\ndone/);
  assert.ok(match, 'release.sh no longer has a `for skill in skills/*.md` loop — did the ' +
    'skill embedding move? This guard reads that loop to check the maintainer filter.');
  return match[1];
}

test('release.sh still filters embedded skills on the frontmatter flag', () => {
  const loop = skillEmbedLoop();
  assert.match(loop, /maintainer/,
    'release.sh embeds every skills/*.md with no maintainer check — skills/release.md would\n' +
    '  ship to every user. Restore the `maintainer: true` skip in the embed loop.');
  assert.match(loop, /continue/,
    'the maintainer check in release.sh no longer skips the file it matches');
});

test('release.sh still deletes a withheld skill on upgrade', () => {
  // Installs made before a skill was withheld already have the file, and the server lists
  // whatever is in skills/ — so a skip alone leaves it in Mods forever on those machines.
  assert.match(skillEmbedLoop(), /rm -f .*INSTALL_DIR\/\$skill/,
    'release.sh no longer emits an `rm -f` for withheld skills, so an existing install that\n' +
    '  already has skills/release.md keeps showing /deepsteve:release in Mods after upgrading.');
});

test('the npm allowlist excludes every maintainer-only skill', () => {
  // The second distribution channel needs the same withholding (#636). release.sh's
  // frontmatter filter only governs install.sh; `npm publish` reads package.json's
  // `files`, and an entry naming `skills/` ships the whole directory — so the
  // exclusion has to be stated there too, or `npm install -g deepsteve` hands every
  // user a command that publishes releases of THIS repo. Worse than the curl case:
  // an npm version cannot be corrected in place once published.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const files = pkg.files || [];
  assert.ok(files.length > 0, 'package.json has no "files" allowlist — every skill would ship');
  for (const id of maintainerOnly) {
    assert.ok(files.includes(`!skills/${id}.md`),
      `package.json "files" must carry "!skills/${id}.md". Without it, npm ships the\n` +
      `  maintainer-only skill that release.sh deliberately withholds from install.sh.`);
  }
});

test('RELEASING.md tells the maintainer the skill ships disabled', () => {
  // The skill is the documented way to cut a release, and it is off by default in a fresh
  // clone. Without this line the first step of a release is an unexplained missing command.
  assert.match(releasingMd, /maintainer-only/i,
    'RELEASING.md must say /deepsteve:release is maintainer-only and absent from install.sh');
  assert.match(releasingMd, /enable/i,
    'RELEASING.md must say the skill has to be enabled in Mods before it can be invoked');
});
