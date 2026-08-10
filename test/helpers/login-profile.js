/**
 * Seed a scratch $HOME's login profile — every file the daemon's shell might read.
 *
 * Standalone suites put a stub `claude` in `$HOME/bin` and need the session's shell
 * to find it. `spawnSession` runs sessions under `resolveLoginShell()`'s shell with
 * its login flag, and WHICH profile that sources depends on the shell:
 *
 *   zsh   → ~/.zshenv, ~/.zprofile
 *   bash  → /etc/profile, then the FIRST of ~/.bash_profile, ~/.bash_login, ~/.profile
 *   sh/dash/ksh → ~/.profile
 *
 * Thirteen suites used to write `~/.zprofile` alone, which was correct on macOS and
 * silently inert on Linux — where the shell is bash. It stayed invisible because the
 * pane ALSO inherited the daemon's PATH, which those suites prepend `$HOME/bin` to.
 * #630 made the login shell load-bearing on both engines, and a login shell REWRITES
 * PATH rather than adding to it: Debian's `/etc/profile` assigns `PATH=` outright, so
 * an inherited `$HOME/bin` is discarded and the stub becomes unfindable. Writing all
 * three files is what keeps `npm run test:standalone` meaningful on Linux.
 *
 * (`.bash_profile` makes bash skip `.profile`. Harmless — they get the same content.)
 */
const fs = require('node:fs');
const path = require('node:path');

const PROFILE_FILES = ['.zprofile', '.bash_profile', '.profile'];

/**
 * @param {string} home  a scratch HOME (must already exist)
 * @param {string} line  one shell line, e.g. 'export PATH="$HOME/bin:$PATH"'
 */
function writeLoginProfile(home, line) {
  for (const name of PROFILE_FILES) {
    fs.writeFileSync(path.join(home, name), `${line}\n`);
  }
}

module.exports = { writeLoginProfile, PROFILE_FILES };
