/**
 * This mod was called Workshop, and its state files were named after it. An install that
 * ran it before the rename still has them, so each store carries its own across the first
 * time it resolves its path: every path function below calls migrateLegacyState() before
 * returning, which is what orders the move ahead of any read no matter which store loads
 * first.
 *
 * A move, never a copy or a merge. When the new name already exists it wins and the old
 * file is left exactly where it was, so a daemon can never overwrite state it has already
 * written under the new name. The stored data holds no absolute paths (images are
 * addressed by file name inside their directory), so a rename is the whole migration.
 * `workshop-seq.json` is not carried: nothing has read it since ids became UUIDs (#705).
 */

const fs = require('fs');
const { statePath } = require('../../paths');

const RENAMED = [
  ['workshop.json', 'inbox.json'],
  ['workshop-chat.json', 'inbox-chat.json'],
  ['workshop-permissions.json', 'inbox-permissions.json'],
  ['workshop-images', 'inbox-images'],
];

// Keyed by state dir, not a boolean: a test repoints HOME between cases, and a second
// daemon on DEEPSTEVE_HOME is a different install with its own files to carry.
const migrated = new Set();

function migrateLegacyState() {
  const dir = statePath();
  if (migrated.has(dir)) return;
  migrated.add(dir);
  for (const [from, to] of RENAMED) {
    const src = statePath(from);
    const dst = statePath(to);
    try {
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst);
    } catch (err) {
      // Loud rather than silent: a store that starts empty here writes the new name, and
      // from then on the old file is never carried — so this line is the only trace.
      console.error(`[inbox] could not move ${src} to ${dst}: ${err.message}`);
    }
  }
}

module.exports = { migrateLegacyState, RENAMED };
