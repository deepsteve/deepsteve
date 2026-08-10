// One-shot terminal runs (#631) — the pure half.
//
// Agents open plain terminal tabs to run commands they cannot run from their own
// session (Claude Code's worktree isolation guard refuses anything reaching the shared
// checkout, #617) and then never close them: 102 terminal sessions across this
// install's history, ZERO closed by an agent. `run_in_terminal` is the disposable
// alternative — it runs one command in a visible tab, hands the output and exit code
// back to the caller, records the run, and tears its own tab down.
//
// This module holds the parts with no daemon in them: how the command is wrapped, how
// its exit status comes back, and the bounded log. The wiring (spawn, watch, close)
// lives in mods/deepsteve-core/tools.js, the same split merge-worktree.js uses.
//
// It sits at the repo ROOT deliberately: restart.sh's `cp *.js` and release.sh's
// root-js loop ship root modules automatically, while engines/ and mods/ have
// hand-maintained lists. Same reason as tmux-path.js, html-source.js, terminal-env.js.
// It is also dependency-free so it loads on the bare CI `unit` job, which runs with
// --ignore-scripts and therefore has no node-pty binding.

const fs = require('fs');
const path = require('path');

// Human-readable AND machine-parseable on purpose. It is printed into the pane the
// user is watching, so it doubles as the "this run is over" line; and it is how the
// daemon learns the exit code, which is why it has to survive being read back.
const MARKER_PREFIX = '[deepsteve] run ';

const DEFAULT_MAX_RUNS = 500;
const DEFAULT_MAX_OUTPUT_BYTES = 32768;

/** POSIX single-quote an argv element for a command line a shell will parse. */
function posixQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * A run nonce: 8 lowercase hex characters. Validated rather than trusted because it is
 * interpolated into a single-quoted shell string AND into a RegExp — both of which are
 * safe for hex and neither of which is safe for arbitrary text.
 */
function isValidNonce(nonce) {
  return typeof nonce === 'string' && /^[0-9a-f]{8}$/.test(nonce);
}

/**
 * The shell program a one-shot run executes.
 *
 *   (
 *   <command>
 *   )
 *   __ds_ec=$?
 *   printf '\n[deepsteve] run <nonce> exited %s\n' "$__ds_ec"
 *   exec <shell> -l
 *
 * Four deliberate choices:
 *
 *  - **The command runs in a SUBSHELL.** Not for scoping — so that a command calling
 *    `exit` ends the *command* rather than the run. Without it, `foo; exit 3` killed
 *    the shell before the marker could be printed, and under tmux that is not merely
 *    "no exit code": the pane dies before the attach client has painted it, so the
 *    daemon (which never reads tmux's own history) sees literally nothing but tmux's
 *    `[exited]`. With the subshell, `$?` is 3 and the run reports normally.
 *  - **Newline-delimited, never `{ … };`.** `$?` on the next line is already the
 *    command's status, including for a multi-line command or one ending in a comment.
 *  - **The exit code comes off the STREAM, not the engine.** Under tmux the PTY we own
 *    is an *attach client*; its exit code belongs to tmux, not to the pane's command.
 *    `onExit`'s code is therefore useless here and printing it is the only answer that
 *    works on both engines.
 *  - **`exec <shell> -l` instead of exiting.** The tab stays live and usable after the
 *    command finishes, so a user watching it can claim it (typing cancels the deferred
 *    close, #627). A shell that simply exited would take the tab with it instantly and
 *    leave no window in which to do that.
 *
 * A command ending in a line continuation (`\`) or an open `&&` swallows the `)` and
 * the marker never appears; the caller falls back to its no-marker path and reports
 * `exit_code: null` rather than guessing.
 */
function wrapRunCommand(command, { nonce, shellPath, loginFlag } = {}) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('command is required');
  if (!isValidNonce(nonce)) throw new Error(`invalid run nonce: ${nonce}`);
  if (!shellPath) throw new Error('shellPath is required');
  const loginShell = [posixQuote(shellPath), ...(loginFlag ? [loginFlag] : [])].join(' ');
  return [
    '(',
    command.replace(/\s+$/, ''),
    ')',
    '__ds_ec=$?',
    `printf '\\n${MARKER_PREFIX}${nonce} exited %s\\n' "$__ds_ec"`,
    `exec ${loginShell}`,
  ].join('\n');
}

/** The marker this run's wrapper will print, as a RegExp. Nonce-scoped by design. */
function markerRegex(nonce) {
  if (!isValidNonce(nonce)) throw new Error(`invalid run nonce: ${nonce}`);
  return new RegExp(`\\[deepsteve\\] run ${nonce} exited (\\d+)`);
}

/**
 * The exit code from a chunk of screen text, or null when this run's marker is not in
 * it. Nonce-scoped, so a command that happens to echo the marker text (a `cat` of this
 * source file, say) cannot fake another run's completion.
 */
function parseExitMarker(text, nonce) {
  const m = markerRegex(nonce).exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Split captured screen lines at this run's marker.
 *
 * Returns `{ output, exitCode, found }`. The marker line and everything after it are
 * dropped — the linger shell's prompt draws below it, and neither belongs in a
 * transcript of what the command printed. `found: false` means the run ended without
 * a marker (the command called `exit`, or the tab was closed), in which case every
 * line is output and the exit code is unknown rather than assumed.
 */
function splitAtMarker(lines, nonce) {
  const re = markerRegex(nonce);
  const all = Array.isArray(lines) ? lines : String(lines || '').split(/\r\n|\n|\r/);
  const at = all.findIndex((l) => re.test(l));
  if (at === -1) return { output: trimTrailingBlanks(all).join('\n'), exitCode: null, found: false };
  const exitCode = Number(re.exec(all[at])[1]);
  return { output: trimTrailingBlanks(all.slice(0, at)).join('\n'), exitCode, found: true };
}

function trimTrailingBlanks(lines) {
  const out = lines.slice();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

/**
 * Tail-truncate output to a byte budget. Keeps the END: a failing command's diagnosis
 * is in its last lines, and the head is the part a caller can re-derive by re-running.
 */
function capOutput(text, maxBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  const s = String(text || '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { output: s, truncated: false };
  const buf = Buffer.from(s, 'utf8');
  // slice on a byte boundary, then let toString drop a partial leading code point
  const tail = buf.subarray(buf.length - maxBytes).toString('utf8');
  return { output: tail, truncated: true };
}

/**
 * The durable record of what agents ran.
 *
 * A bounded JSONL, the same load-on-start / append / rewrite-only-when-trimming shape
 * as mods/session-lifecycle/tools.js. Unlike that one it is NOT gated behind a setting:
 * this is the audit trail for the escape hatch agents use to reach the un-isolated main
 * checkout, and an audit trail that defaults to off is not an audit trail.
 *
 * Every fs call is best-effort — a logging failure must never break a run.
 */
function createRunLog({ file, maxRuns = DEFAULT_MAX_RUNS, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  let runs = [];
  let nextId = 1;

  try {
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { runs.push(JSON.parse(line)); } catch { /* skip a malformed line */ }
      }
      if (runs.length > maxRuns) runs = runs.slice(-maxRuns);
      nextId = runs.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;
    }
  } catch { /* start empty */ }

  return {
    get file() { return file; },
    /** Append one run. Returns the stored record (with its id and capped output). */
    append(record) {
      const { output, truncated } = capOutput(record.output, maxOutputBytes);
      const stored = { ...record, id: nextId++, output, truncated: truncated || !!record.truncated };
      runs.push(stored);
      let trimmed = false;
      if (runs.length > maxRuns) { runs = runs.slice(-maxRuns); trimmed = true; }
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (trimmed) fs.writeFileSync(file, runs.map((r) => JSON.stringify(r)).join('\n') + '\n');
        else fs.appendFileSync(file, JSON.stringify(stored) + '\n');
      } catch { /* best-effort — never throw into a run */ }
      return stored;
    },
    /** Most recent first, newest `limit` runs, optionally for one session. */
    list({ limit = 50, session } = {}) {
      let result = runs;
      if (session) result = result.filter((r) => r.session_id === session);
      const n = Math.max(1, Math.min(500, Math.round(Number(limit) || 50)));
      return result.slice(-n).reverse();
    },
    get size() { return runs.length; },
  };
}

module.exports = {
  MARKER_PREFIX,
  DEFAULT_MAX_RUNS,
  DEFAULT_MAX_OUTPUT_BYTES,
  posixQuote,
  isValidNonce,
  wrapRunCommand,
  markerRegex,
  parseExitMarker,
  splitAtMarker,
  capOutput,
  createRunLog,
};
