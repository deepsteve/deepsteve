/**
 * Is the Node.js running this daemon one with a known security hole?
 *
 * package.json's `engines` admits Node >= 18, and that range includes lines that are
 * end-of-life — a security release never patches them. Nothing else in deepsteve looks at the
 * runtime, so a user on one of those lines stays exposed and is never told. server.js calls
 * nodeVersionWarnings() once at boot and logs whatever it returns.
 *
 * Advisory only, never fatal. Refusing to boot would take every agent session down with it,
 * on a machine whose node the user may not be able to change right now.
 *
 * Lives at the repo root, not inside server.js, so a plain `node --test` can require it
 * without booting a daemon — same reason as release-check.js. Root *.js files are copied by
 * restart.sh and release.sh by glob and covered by package.json's `files`, so it ships with no
 * deploy-script change.
 */

// One entry per advisory. `fixed` maps each release line that got a patch to its first patched
// version, exactly as the nodejs.org security release post lists them. A line NOT in `fixed` is
// read by its position:
//   - older than the newest line listed: end-of-life when the fix shipped, so never fixed;
//   - newer than every line listed: branched after the fix, so not affected.
// To record a new advisory, append an entry. To record a late backport, add its line.
const NODE_ADVISORIES = [
  {
    id: 'CVE-2026-111497',
    title: 'Brotli decoder out-of-bounds write, can lead to remote code execution',
    url: 'https://nodejs.org/en/blog/vulnerability/october-2026-security-releases',
    fixed: { 22: '22.23.4', 24: '24.22.1', 26: '26.12.1' },
  },
];

// `process.versions.node` has no leading `v`; `process.version` does. A nightly or
// self-built node carries a suffix (`27.0.0-pre`), which says nothing about the patch level
// beyond what the numbers already do, so it is ignored.
function parseNodeVersion(raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(typeof raw === 'string' ? raw : '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * The advisories that apply to `version`.
 *
 * @returns {Array<{id, title, url, running, line, fixedIn, upgradeTo}>} `fixedIn` is this
 *   line's patched release, or null when the line will never get one; `upgradeTo` is what to
 *   move to — this line's patch, or else the patched releases of every newer line. Empty when
 *   nothing applies or the version string cannot be read.
 */
function affectingAdvisories(version, advisories = NODE_ADVISORIES) {
  const running = parseNodeVersion(version);
  if (!running) return [];
  const line = running[0];
  const hits = [];
  for (const adv of advisories) {
    const hit = { id: adv.id, title: adv.title, url: adv.url, running: running.join('.'), line };
    const ownFix = adv.fixed[line];
    if (ownFix) {
      if (compareVersions(running, parseNodeVersion(ownFix)) >= 0) continue;
      hits.push({ ...hit, fixedIn: ownFix, upgradeTo: [ownFix] });
      continue;
    }
    const lines = Object.keys(adv.fixed).map(Number).sort((a, b) => a - b);
    if (line > lines[lines.length - 1]) continue;
    hits.push({ ...hit, fixedIn: null, upgradeTo: lines.filter(l => l > line).map(l => adv.fixed[l]) });
  }
  return hits;
}

/** One log line per advisory that applies to `version`. */
function nodeVersionWarnings(version, advisories = NODE_ADVISORIES) {
  return affectingAdvisories(version, advisories).map(hit => {
    const what = `WARNING: Node.js ${hit.running} is affected by ${hit.id} (${hit.title}).`;
    const fix = hit.fixedIn
      ? `Upgrade to Node.js ${hit.fixedIn} or later.`
      : `Node.js ${hit.line}.x is end-of-life and will never get a fix — upgrade to a patched line: ${hit.upgradeTo.map(v => `${v}+`).join(', ')}.`;
    return `[node-security] ${what} ${fix} ${hit.url}`;
  });
}

module.exports = { NODE_ADVISORIES, parseNodeVersion, affectingAdvisories, nodeVersionWarnings };
