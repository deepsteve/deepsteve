/**
 * Startup reattach for surviving tmux sessions (#620, repaired in #626).
 *
 * This is the startup half of the durability promise: shutdown detaches (tears
 * down our attach PTY and leaves the tmux session running), and on the next boot
 * this reattaches — a fresh `tmux attach-session` PTY onto the SAME pane, same
 * pid, same conversation. The agent process never stopped; only the daemon's pipe
 * into it is rebuilt.
 *
 * Why it lives here rather than inline in server.js (#626):
 *
 *   1. It ran at module scope, above `const wss`, and its last statement reached
 *      wss.clients through recordRecentSession → broadcastRecentSessions. Every
 *      session on every boot threw `Cannot access 'wss' before initialization`
 *      into the per-session catch, so `tmux: reattached session …` had never once
 *      been printed. The throw happened to land after every load-bearing
 *      statement, so nothing was actually lost — but it destroyed the only
 *      evidence that reattach works, and anything added to the loop ahead of it
 *      would have gone silently missing.
 *   2. It had no test coverage at all. test/integration-standalone/ runs only via
 *      `npm run test:standalone`, never in CI, and the ownership rule was pinned
 *      in test/unit/engine-default.test.js against a hand-written MIRROR of this
 *      logic. A module with injected dependencies can be driven directly by the CI
 *      unit job, which runs bare on ubuntu with no tmux, no zsh and
 *      `--ignore-scripts` (so no node-pty binding either).
 *
 * Root-level so it ships automatically: restart.sh does `cp *.js`, release.sh does
 * `for rootjs in *.js`. Same placement rationale as pending-opens.js,
 * fork-resolve.js, html-source.js and merge-worktree.js.
 */

/** Default attach dimensions. The browser resizes on connect. */
const REATTACH_COLS = 120;
const REATTACH_ROWS = 40;

/**
 * The ownership rule: what should startup do with a `ds-<id>` tmux session it
 * found on the socket?
 *
 * Destroy ONLY what this daemon can positively identify as its own AND finished.
 *
 * #625 moved us onto our own socket, so "everything here is ours" is now SUPPOSED
 * to be true — but this rule stays verbatim as the second line of defence, because
 * every way it can still be false is a way we cannot identify the session:
 * state.json lost, rolled back or hand-edited; the daemon died between spawn() and
 * saveState(); a human ran `tmux -S <ours> new -s ds-foo`; two daemons sharing one
 * DEEPSTEVE_HOME. Tightening this to "destroy unknown" would buy garbage collection
 * of a rare orphan and cost a fresh way to kill a live agent — which is the trade
 * #625 exists to refuse. Consequence accepted by design: a genuinely orphaned ds-*
 * session is never garbage-collected, and `tmux kill-session` is the manual out.
 *
 * @param {object|undefined} meta - this id's state.json record, if any
 * @returns {'leave-alone'|'reclaim'|'reattach'}
 */
function reattachAction(meta) {
  if (!meta) return 'leave-alone';
  // Ours and finished: the kill didn't take. Reclaim it — and do NOT resurrect it
  // as live, which is what the pre-#620 code did (it also deleted the tombstone on
  // the way past).
  if (meta.closed) return 'reclaim';
  return 'reattach';
}

/**
 * Reattach every surviving tmux session this daemon owns.
 *
 * Call this at module scope AFTER the WebSocket servers exist — see the note at
 * the call site in server.js. Returns a summary rather than logging a verdict, so
 * the caller decides whether to persist.
 *
 * @param {object} deps
 * @param {object} deps.tmuxEngine       - listSessions/reattach/detach/destroy/onExit
 * @param {object} deps.savedState       - the state.json map, mutated in place
 * @param {Map}    deps.shells           - the live shell map, mutated in place
 * @param {Function} deps.log
 * @param {Function} deps.getAgentConfig
 * @param {Function} deps.wireShellOutput
 * @param {Function} deps.watchClaudeSessionDir
 * @param {Function} deps.unwatchClaudeSessionDir
 * @param {Function} deps.handleShellGone
 * @param {Function} deps.recordRecentSession
 * @param {string} [deps.socketPath] - our tmux socket (#625), named in the
 *   "not ours to kill" message so the reclaim command can be copy-pasted.
 * @param {{cols?: number, rows?: number}} [deps.size]
 * @returns {{found: string[], reattached: string[], leftAlone: string[], reclaimed: string[], failed: string[]}}
 */
function reattachSurvivingTmuxSessions({
  tmuxEngine,
  savedState,
  shells,
  log,
  getAgentConfig,
  wireShellOutput,
  watchClaudeSessionDir,
  unwatchClaudeSessionDir,
  handleShellGone,
  recordRecentSession,
  socketPath = null,
  size = {},
}) {
  const summary = { found: [], reattached: [], leftAlone: [], reclaimed: [], failed: [] };
  if (!tmuxEngine) return summary;

  const cols = size.cols || REATTACH_COLS;
  const rows = size.rows || REATTACH_ROWS;

  const ids = tmuxEngine.listSessions();
  summary.found = ids;
  if (ids.length === 0) return summary;

  log(`tmux: found ${ids.length} surviving session(s): ${ids.join(', ')}`);

  for (const id of ids) {
    const meta = savedState[id];
    const action = reattachAction(meta);

    if (action === 'leave-alone') {
      log(`tmux: session ${id} is on our socket but absent from state.json — leaving it ` +
          `alone (not ours to kill). Reclaim it manually with: ` +
          `tmux${socketPath ? ` -S ${socketPath}` : ''} kill-session -t ds-${id}`);
      summary.leftAlone.push(id);
      continue;
    }

    if (action === 'reclaim') {
      log(`tmux: session ${id} is closed (${meta.closeReason || 'unknown'}) but its tmux session survived — reclaiming`);
      try {
        tmuxEngine.destroy(id);
        summary.reclaimed.push(id);
      } catch (e) {
        log(`tmux: failed to reclaim closed session ${id}: ${e.message}`);
        summary.failed.push(id);
      }
      continue;
    }

    // --- critical phase ---------------------------------------------------
    // Everything here is load-bearing: after it the session is live, readable,
    // and its exit is noticed. It is wrapped per session because it runs on every
    // boot for every session — an exception escaping here (a pty.spawn failure
    // inside reattach, say) would take the daemon down before it ever serves a
    // request, losing every OTHER session too.
    //
    // On failure we roll all the way back rather than leaving a half-wired entry.
    // That is deliberately self-healing: savedState keeps a non-closed record, the
    // tmux session stays alive (detach, never destroy), the ownership rule above
    // protects it meanwhile, and the next boot simply tries again.
    let wired = false;
    try {
      if (!tmuxEngine.reattach(id, cols, rows)) {
        // Vanished between listSessions() and here. Leave the saved entry alone:
        // a later WS connect restores it the normal way.
        log(`tmux: failed to reattach session ${id} — its tmux session is gone`);
        summary.failed.push(id);
        continue;
      }

      const agentConfig = getAgentConfig(meta.agentType || 'claude');

      // Carry the saved record back WHOLESALE rather than naming fields. This is
      // the third writer of a shell entry (with the WS restore and spawn paths),
      // and it used to hand-list a subset — so every field added to
      // serializeShellEntry since was silently dropped on reattach and then wiped
      // from state.json by the next save: forkParent (the #497 fork-steal guard),
      // planMode, model/effort (#592), allowedTools (#612), scheduled (#597).
      // Spreading means a future serialized field is inherited here for free
      // instead of quietly going missing.
      shells.set(id, {
        ...meta,
        clients: new Set(),
        agentType: meta.agentType || 'claude',
        engine: tmuxEngine,
        engineType: 'tmux',
        restored: true,
        waitingForInput: false,
        lastActivity: meta.lastActivity || Date.now(),
        createdAt: meta.createdAt || Date.now(),
      });
      wired = true;

      wireShellOutput(id);
      if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
      tmuxEngine.onExit(id, () => {
        if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
        // Reason named explicitly (#625): a reattached session has no closeReasons
        // entry — nothing in THIS process ever asked it to close — so without this
        // the line would read `reason=exited` for the one case where "the pane died
        // on its own" is the whole diagnosis.
        handleShellGone(id, 'tmux-pane-exited');
      });
      delete savedState[id]; // saved → live promotion, not a close

      // Logged HERE, at the end of the critical phase, not after the best-effort
      // work below. The whole point of #626: this line is the only evidence that
      // reattach — and therefore the entire durability story — actually works, so
      // nothing optional may sit between the session becoming live and saying so.
      log(`tmux: reattached session ${id} (${meta.name || meta.cwd})`);
      summary.reattached.push(id);
    } catch (e) {
      if (wired) {
        try { unwatchClaudeSessionDir(id); } catch {}
        shells.delete(id);
        savedState[id] = meta;      // restore: still ours, still not closed
        try { tmuxEngine.detach(id); } catch {}  // release our pipe; the agent lives on
      }
      log(`tmux: FAILED to reattach session ${id} — rolled back, its tmux session is still running ` +
          `and the next restart will retry: ${e.stack || e.message}`);
      summary.failed.push(id);
      continue;
    }

    // --- best-effort phase ------------------------------------------------
    // Nothing below may affect whether the session is live. Separately guarded so
    // a failure here can never be reported as, or mistaken for, a reattach
    // failure — which is exactly what #626 was.
    try {
      // The WS restore path bumps recency and this one didn't, so a session that
      // came back via reattach silently fell out of the recents ring.
      // (No emitSessionOpen: restores deliberately don't emit 'open'. The
      // resulting close-with-no-open gap in the #485 lifecycle log is pre-existing
      // and shared by every restore path.)
      recordRecentSession(id);
    } catch (e) {
      log(`tmux: session ${id} reattached, but recording it as recent failed: ${e.message}`);
    }
  }

  return summary;
}

module.exports = { reattachAction, reattachSurvivingTmuxSessions, REATTACH_COLS, REATTACH_ROWS };
