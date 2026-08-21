const { z } = require('zod');
const { randomUUID } = require('crypto');
const path = require('path');
const { execFileSync } = require('child_process');
const { mergeWorktree } = require('./merge-worktree');
const { stateDir, spawnCwdProblem } = require('../../paths');
const { splitAtMarker, capOutput, createRunLog } = require('../../terminal-run');

// git via execFile with an argv array — no shell, so no quoting/injection concerns
// and no dependence on `zsh -l` for PATH (git is /usr/bin/git, already on the
// LaunchAgent's PATH; the CI unit runner has no zsh at all). Never throws: a
// non-zero exit is a value, since "merge failed" is an expected outcome here.
function runGit(args, cwd) {
  try {
    const stdout = execFileSync('git', args, {
      cwd, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: stdout || '', stderr: '' };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message || '' };
  }
}

// "2 minutes" / "45 seconds" — the auto-close delay in words, so the agent has a
// sentence to paraphrase to the user instead of an epoch timestamp (#627).
function describeDelay(seconds) {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const mins = Math.round(seconds / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

// Derive a short, single-line tab name from a shell command (used when a
// terminal tab is opened with a `command` but no explicit `name`).
function deriveTabName(cmd) {
  const oneLine = cmd.replace(/\s+/g, ' ').trim();
  const MAX = 24;
  return oneLine.length > MAX ? oneLine.slice(0, MAX - 1) + '…' : oneLine;
}

/**
 * Refuse a spawn whose cwd is gone (#632), or null to proceed.
 *
 * spawnSession throws on its own and the MCP SDK turns that into an isError result,
 * so this is about the message rather than about safety: the default cwd here is the
 * CALLER's, and the way it goes stale is a worktree that merge_worktree removed out
 * from under the very session now asking for a terminal. Telling the agent to pass an
 * explicit cwd is the actionable half.
 */
function refuseCwdProblem(problem) {
  return {
    content: [{ type: 'text', text: `${problem.message} — pass an explicit \`cwd\` that exists.` }],
    isError: true,
  };
}

function refuseMissingCwd(cwd) {
  const problem = spawnCwdProblem(cwd);
  return problem ? refuseCwdProblem(problem) : null;
}

// Control keys meta_type can send (#519). Values are the raw bytes written to the
// PTY — both engines pass them through unchanged. `C-a`…`C-z` map to control chars.
const KEY_MAP = {
  Escape: '\x1b', Enter: '\r', Tab: '\t', Backspace: '\x7f',
  Up: '\x1b[A', Down: '\x1b[B', Right: '\x1b[C', Left: '\x1b[D',
  Home: '\x1b[H', End: '\x1b[F',
  PageUp: '\x1b[5~', PageDown: '\x1b[6~', Delete: '\x1b[3~',
};
const VALID_KEYS = `${Object.keys(KEY_MAP).join(', ')}, C-a…C-z`;
function keyToBytes(key) {
  if (KEY_MAP[key]) return KEY_MAP[key];
  const ctrl = /^C-([a-z])$/i.exec(key);
  if (ctrl) return String.fromCharCode(ctrl[1].toLowerCase().charCodeAt(0) & 0x1f);
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// meta_type timing knobs, exported so unit tests can shrink them. keyGapMs: Ink
// only recognizes control bytes that arrive as separate stdin reads. settleMs:
// how long to let the echo/redraw reach the scrollback before reading it back.
const TIMINGS = { keyGapMs: 250, settleMs: 500, waitForIdleMs: 30000, idlePollMs: 250 };

// run_in_terminal knobs (#631), exported alongside TIMINGS for the same reason.
// maxWatchMs is an absolute ceiling on the poll loop, independent of the caller's
// timeout: the tool call may return long before the command does, and a watcher whose
// marker never arrives must not poll for the daemon's whole lifetime.
const RUN_TIMINGS = {
  pollMs: 250,
  defaultTimeoutSec: 120,
  maxTimeoutSec: 900,
  captureLines: 2000,   // how much of the interpreted screen becomes captured output
  scanLines: 60,        // cheap tail scanned each poll for the completion marker
  maxWatchMs: 12 * 60 * 60 * 1000,
};

// Created by init() and shared with registerRoutes(); mcp-server.js always calls init
// first. Lazily, not at require time, so a test that repoints HOME before requiring
// this module (the test/unit/project-mods.test.js pattern) still gets a scratch path.
let runLog = null;
function getRunLog() {
  if (!runLog) runLog = createRunLog({ file: path.join(stateDir(), 'terminal-runs.jsonl') });
  return runLog;
}

function init(context) {
  const {
    shells, closeSession, handleShellGone, spawnSession, sessionEnv, getSpawnArgs, mcpConfigArgs, getAgentConfig, wireShellOutput, getDefaultEngine, getForegroundCommand,
    watchClaudeSessionDir, unwatchClaudeSessionDir, resolveForkParentSession, saveState,
    validateWorktree, ensureWorktree, sessionPaths, submitToShell,
    deliverPromptWhenReady, startIssueSession,
    reloadClients, deliverToWindow, settings, log, isShuttingDown,
    emitSessionOpen,
    stripEscapeSequences, readTerminalScreen, sessionInputState, maybeInheritRemoteControl, requestMetaControlsConsent,
    armSessionAutoClose,
  } = context;

  // Read the interpreted terminal buffer maintained at the PTY boundary. Tests
  // and third-party embedders without that context helper retain a transcript
  // fallback for compatibility.
  async function screenLines(entry, n) {
    if (readTerminalScreen) return readTerminalScreen(entry, n);
    const raw = (entry.scrollback || []).join('').slice(-16384);
    const lines = stripEscapeSequences(raw).split(/\r\n|\n|\r/).map((l) => l.replace(/\s+$/g, ''));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n);
  }

  return {
    get_my_session_id: {
      description: 'Get the deepsteve session ID for the calling session. No parameters needed. Use this instead of running `echo $DEEPSTEVE_SESSION_ID`.',
      schema: {},
      handler: async (args, extra) => {
        const shellId = extra?.requestInfo?.url?.searchParams?.get('shellId');
        if (!shellId || !shells.has(shellId)) {
          return { content: [{ type: 'text', text: 'Could not determine session ID. Run `echo $DEEPSTEVE_SESSION_ID` instead.' }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ session_id: shellId }) }] };
      },
    },
    get_session_info: {
      description: 'Get live session metadata for a deepsteve session: tab name, cwd (your actual working directory — the worktree path for worktree sessions), repoRoot (the main repo checkout), worktree (the worktree name, or null), runningCommand (for a plain terminal session, the command running in it right now, or null if it is idle at its prompt; always null for agent sessions), state ("idle" = the agent is at its input prompt, "busy" = mid-task, "unknown" = not classifiable for this agent type), and metaControls (whether the Meta Controls setting is on, i.e. whether meta_type will type without asking the user first). Use `get_my_session_id` to get your session ID.',
      schema: {
        session_id: z.string().describe('The deepsteve session ID. Use `get_my_session_id` to get this value.'),
      },
      handler: async ({ session_id }) => {
        const entry = shells.get(session_id);
        if (!entry) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
        }
        const fallbackName = entry.cwd ? path.basename(entry.cwd) : 'shell';
        const { cwd, repoRoot } = sessionPaths(entry);
        return {
          content: [{ type: 'text', text: JSON.stringify({
            id: session_id,
            name: entry.name || fallbackName || 'root',
            cwd,
            repoRoot,
            worktree: entry.worktree || null,
            windowId: entry.windowId || null,
            agentType: entry.agentType || 'claude',
            runningCommand: entry.agentType === 'terminal' ? getForegroundCommand(session_id) : null,
            createdAt: entry.createdAt || null,
            elapsedMs: entry.createdAt ? Date.now() - entry.createdAt : null,
            // Kept in lockstep with GET /api/shells/:id/info (#519).
            state: sessionInputState(entry),
            metaControls: !!settings.metaControlsEnabled,
          }, null, 2) }]
        };
      },
    },
    close_session: {
      description: 'Close a deepsteve session and its browser tab. Gracefully terminates the Claude process. With no arguments, closes the calling session. Pass session_id to close a different session.',
      schema: {
        session_id: z.string().optional().describe('The deepsteve session ID to close. If omitted, closes the calling session (auto-detected from the MCP request).'),
      },
      handler: async ({ session_id }, extra) => {
        const targetId = session_id || extra?.requestInfo?.url?.searchParams?.get('shellId');
        if (!targetId) {
          return { content: [{ type: 'text', text: 'Could not determine session to close.' }] };
        }
        if (!closeSession(targetId)) {
          return { content: [{ type: 'text', text: `Session "${targetId}" not found.` }] };
        }
        return { content: [{ type: 'text', text: `Session "${targetId}" closed.` }] };
      },
    },
    meta_type: {
      description: 'Type text and/or control keys into a deepsteve session\'s terminal — a server-side PTY write, so it works regardless of which browser tab is focused (or whether a browser is open at all). With no session_id, types into the calling session. The result is truthful: it reports the session\'s input state before typing ("idle" = at its prompt, "busy" = mid-task, "unknown" = unclassifiable agent type), whether the typed text actually appeared on the session\'s screen (`landed`, a readback heuristic), and the screen tail after typing — check these instead of assuming success. Use wait_for_idle to hold off until the agent reaches its prompt, and clear_first to press Escape once first (clears staged composer text). Requires the Meta Controls setting: if it is off, this call shows the user an in-browser consent dialog and waits up to 60s for their decision.',
      schema: {
        text: z.string().optional().describe('Text to type. At least one of `text` / `keys` is required.'),
        keys: z.array(z.string()).optional().describe(`Control keys to press BEFORE typing \`text\`, in order (e.g. ["Escape"] to cancel a menu, ["C-c"] to interrupt). Valid: ${VALID_KEYS}.`),
        session_id: z.string().optional().describe('Target session ID. If omitted, types into the calling session.'),
        submit: z.boolean().optional().describe('Press Enter after typing `text` (default true). Set false to stage input without submitting. Ignored when no `text` is given.'),
        clear_first: z.boolean().optional().describe('Press Escape once before `keys`/`text` to clear any staged input in the composer (default false).'),
        wait_for_idle: z.boolean().optional().describe('If the session is busy, wait (up to 30s) for it to reach its input prompt before typing; on timeout nothing is typed and the result says so. Recommended when targeting an agent session that may be mid-task.'),
      },
      handler: async ({ text, keys, session_id, submit, clear_first, wait_for_idle }, extra) => {
        const callerId = extra?.requestInfo?.url?.searchParams?.get('shellId');
        const targetId = session_id || callerId;
        if (!text && (!keys || keys.length === 0)) {
          return { content: [{ type: 'text', text: 'Nothing to send: provide `text` and/or `keys`.' }] };
        }
        // Validate keys before anything else — don't prompt the user for consent
        // on a call that was malformed anyway.
        const keyBytes = [];
        for (const k of keys || []) {
          const b = keyToBytes(k);
          if (b === null) {
            return { content: [{ type: 'text', text: `Unknown key "${k}". Valid keys: ${VALID_KEYS}.` }] };
          }
          keyBytes.push(b);
        }
        const entry = targetId ? shells.get(targetId) : null;
        if (!entry) {
          return { content: [{ type: 'text', text: `Session "${targetId || 'unknown'}" not found.` }] };
        }

        if (!settings.metaControlsEnabled) {
          // Ask the human in the browser instead of failing opaquely (#519).
          const outcome = await requestMetaControlsConsent({ requesterId: callerId, targetId });
          if (outcome !== 'confirmed') {
            const why = {
              declined: 'The user declined to enable it just now (declines cool down for 60s — do not retry immediately; if this is needed, ask the user to enable Meta Controls in deepsteve Settings).',
              timeout: 'The user did not respond to the consent dialog within 60s. Ask them directly, then retry.',
              'no-clients': 'No browser window is connected to approve enabling it. Ask the user to open the deepsteve UI, or to enable Meta Controls in deepsteve Settings.',
            }[outcome] || `Consent not granted (${outcome}).`;
            return { content: [{ type: 'text', text: `Meta Controls is disabled. ${why}` }] };
          }
        }

        const stateBefore = sessionInputState(entry);
        if (wait_for_idle && stateBefore === 'busy') {
          const deadline = Date.now() + TIMINGS.waitForIdleMs;
          while (Date.now() < deadline && shells.has(targetId) && !entry.waitingForInput) {
            await sleep(TIMINGS.idlePollMs);
          }
          if (!shells.has(targetId)) {
            return { content: [{ type: 'text', text: `Session "${targetId}" closed while waiting for idle. Nothing was typed.` }] };
          }
          if (!entry.waitingForInput) {
            return { content: [{ type: 'text', text: JSON.stringify({
              session_id: targetId, state_before: 'busy', timed_out_waiting: true,
              submitted: false, landed: false,
              note: 'Session stayed busy for 30s; nothing was typed. Retry later, or retry without wait_for_idle to type anyway.',
            }) }] };
          }
        }

        // Each control byte is its own engine write with a gap — Ink only
        // recognizes control keys that arrive as separate stdin reads (same
        // reason submitToShell defers Enter).
        const allKeyBytes = [...(clear_first ? [KEY_MAP.Escape] : []), ...keyBytes];
        for (const b of allKeyBytes) {
          if (!shells.has(targetId)) {
            return { content: [{ type: 'text', text: `Session "${targetId}" closed mid-send.` }] };
          }
          entry.engine.write(targetId, b);
          await sleep(TIMINGS.keyGapMs);
        }

        const doSubmit = text ? submit !== false : false;
        if (text) {
          if (doSubmit) {
            await submitToShell(targetId, text); // writes text, then \r after 1s (Ink-safe)
          } else {
            entry.engine.write(targetId, text);  // stage text without Enter
          }
        }
        // Let the echo/redraw reach the scrollback before reading it back.
        await sleep(TIMINGS.settleMs);

        // Readback heuristic: did the typed text show up on the screen? The
        // composer echoes what it received, so a miss usually means the input
        // was swallowed (dead PTY, modal menu, etc.).
        let landed = null;
        if (text) {
          const norm = (s) => s.replace(/\s+/g, ' ').trim();
          const needle = norm(text).slice(0, 200);
          if (needle.length > 0) {
            const tail = (await screenLines(entry, 200)).join('\n');
            landed = norm(tail).includes(needle);
          }
        }

        log(`[MCP] meta_type: target=${targetId}, len=${text ? text.length : 0}, keys=${allKeyBytes.length}, submit=${doSubmit}, state_before=${stateBefore}, landed=${landed}`);
        return { content: [{ type: 'text', text: JSON.stringify({
          session_id: targetId,
          state_before: stateBefore,
          typed: text ? text.length : 0,
          keys_sent: [...(clear_first ? ['Escape'] : []), ...(keys || [])],
          submitted: doSubmit,
          landed,
          screen_tail: await screenLines(entry, 10),
        }, null, 2) }] };
      },
    },
    read_session_screen: {
      description: 'Read the recent terminal screen of a deepsteve session: the last N lines of interpreted terminal state, plus its input state ("idle" = the agent is at its input prompt, "busy" = mid-task, "unknown" = unclassifiable — plain terminals and non-BEL agents) and seconds since it last produced output. With no session_id, reads the calling session. Use it to check what a session is doing, or to verify input landed after meta_type. Cursor movement, redraws, reflow, and ANSI control sequences are resolved before the lines are returned.',
      schema: {
        session_id: z.string().optional().describe('Target session ID. If omitted, reads the calling session.'),
        lines: z.number().optional().describe('How many lines from the end to return (default 40, max 200).'),
      },
      handler: async ({ session_id, lines }, extra) => {
        const targetId = session_id || extra?.requestInfo?.url?.searchParams?.get('shellId');
        const entry = targetId ? shells.get(targetId) : null;
        if (!entry) {
          return { content: [{ type: 'text', text: `Session "${targetId || 'unknown'}" not found.` }] };
        }
        const n = Math.max(1, Math.min(200, Math.round(Number(lines) || 40)));
        return { content: [{ type: 'text', text: JSON.stringify({
          session_id: targetId,
          state: sessionInputState(entry),
          seconds_since_output: entry.lastActivity ? Math.round((Date.now() - entry.lastActivity) / 1000) : null,
          lines: await screenLines(entry, n),
        }, null, 2) }] };
      },
    },
    start_issue: {
      description: 'Open a new deepsteve session for a GitHub issue. Fetches the issue body from GitHub, creates a worktree, and starts an agent with the issue prompt. The new tab opens in the same browser window as the caller.',
      schema: {
        number: z.number().describe('GitHub issue number'),
        title: z.string().describe('Issue title'),
        session_id: z.string().optional().describe('Caller session ID (auto-detected if omitted)'),
        body: z.string().optional().describe('Issue body (if omitted, fetched from GitHub via gh CLI)'),
        labels: z.string().optional().describe('Comma-separated labels'),
        url: z.string().optional().describe('Issue URL'),
        cwd: z.string().optional().describe('Working directory (defaults to caller\'s cwd)'),
        agent_type: z.string().optional().describe('Agent type (defaults to caller\'s). Supported: "claude", "codex". Experimental: "opencode", "pi", "hermes" — these run, but get no deepsteve MCP tools and no skills, so the new session cannot call back into deepsteve. See docs/agents.md.'),
        autopilot: z.boolean().optional().describe('Whether the new session runs with Autopilot: when it calls issue_complete at the end of the work, it is told to merge itself instead of leaving the tab for review. OMIT this to use the user\'s remembered preference (the Autopilot checkbox in the issue picker and in Settings) — pass a boolean only to deliberately override that choice for this one session.'),
      },
      handler: async ({ session_id, number, title, body, labels, url, cwd, agent_type, autopilot }, extra) => {
        const callerId = session_id || extra?.requestInfo?.url?.searchParams?.get('shellId');
        const caller = callerId ? shells.get(callerId) : null;
        if (!caller) {
          return { content: [{ type: 'text', text: `Session "${callerId || 'unknown'}" not found.` }] };
        }
        // Everything past the caller lookup — inheritance, worktree, spawn, /rc
        // inheritance, prompt delivery — is startIssueSession's job (#642). This
        // tool used to carry its own copy of all of it, and the copy had drifted.
        const result = startIssueSession({
          number, title, body, labels, url,
          cwd: cwd || null,
          agentType: agent_type || null,
          callerId,
          // Raw, not `!!autopilot` (#651): an omitted argument must reach
          // startIssueSession as undefined so it can seed from settings.issueAutopilot
          // rather than being silently forced off.
          autopilot,
        });
        if (result.error) return refuseCwdProblem(result.error);
        return { content: [{ type: 'text', text: JSON.stringify({ id: result.id, name: result.name, cwd: result.cwd, worktree: result.worktree, autopilot: result.autopilot }) }] };
      },
    },
    issue_complete: {
      description: 'Report that the work you were given is finished, and find out what to do next. '
        + 'Call this when you believe the task is complete, BEFORE writing your final summary — the answer '
        + 'may tell you to merge, which has to happen while you are still working. '
        + 'The answer depends on Autopilot, a per-session setting the USER controls (from the issue picker '
        + 'and the tab context menu); it is not yours to decide. With Autopilot off you are told to stop and '
        + 'leave the tab for review; with it on you are told how to merge this session yourself. '
        + 'Every issue session is asked to call this, in both states.',
      schema: {
        session_id: z.string().optional().describe('Caller session ID (auto-detected if omitted).'),
      },
      handler: async ({ session_id }, extra) => {
        const callerId = session_id || extra?.requestInfo?.url?.searchParams?.get('shellId');
        const caller = callerId ? shells.get(callerId) : null;
        if (!caller) {
          return { content: [{ type: 'text', text: `Session "${callerId || 'unknown'}" not found.` }], isError: true };
        }

        // Read at COMPLETION time, not at toggle time (#643). That is what makes
        // turning autopilot off a real cancel: nothing was ever queued, so there is
        // nothing to unwind, and the flag's value right now is the whole answer.
        const on = !!caller.autopilot;
        let payload;
        if (!on) {
          payload = {
            autopilot: false,
            next: 'stop',
            instruction: 'Autopilot is off for this session. Stop here: write your report of what you did '
              + 'and leave this tab open. Do NOT merge and do NOT close the session — a human will review '
              + 'the worktree and merge it.',
          };
        } else if ((settings.enabledSkills || []).includes('merge')) {
          // Codex reaches the same skill under a different name — server.js rewrites
          // /deepsteve:<id> to $deepsteve-<id> when it generates the Codex copy, so
          // handing a Codex session the Claude form would name a command it does not have.
          const invocation = caller.agentType === 'codex' ? '$deepsteve-merge' : '/deepsteve:merge';
          payload = {
            autopilot: true,
            next: 'merge',
            instruction: `Autopilot is on for this session: when you complete, run ${invocation}. `
              + 'That skill commits this worktree, merges it, closes the GitHub issue and closes this tab.',
          };
        } else {
          // The merge skill is disabled on this install, so naming it would send the
          // agent after a command that does not exist — and a stuck agent improvises
          // `git push origin <branch>:main`, which moves the remote and leaves the
          // local checkout behind (docs/sessions.md).
          payload = {
            autopilot: true,
            next: 'merge',
            instruction: 'Autopilot is on for this session, but the deepsteve "merge" skill is not enabled here, '
              + 'so there is no merge command to run. Do it directly instead: commit everything in this worktree '
              + '(`git add -A` then `git commit`, as separate Bash calls), then call mcp__deepsteve__merge_worktree, '
              + 'and once it reports status "merged", call mcp__deepsteve__close_session. Never push the branch over '
              + 'the target with `git push origin <branch>:<target>` — that moves the remote and leaves the local '
              + 'checkout behind.',
          };
        }
        // Logged on every call (#643). The feature rests on the agent actually calling
        // this, and this line is the only evidence of the call rate — which is what a
        // daemon-side backstop would have to be justified by.
        log(`[MCP] issue_complete: ${callerId} autopilot=${on ? 'on' : 'off'} -> ${payload.next}`);
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      },
    },
    merge_worktree: {
      description: 'Merge the calling session\'s worktree branch into a target branch, running the merge server-side in the checkout that has the target checked out. Use this instead of `git -C <main checkout> merge` from Bash: Claude Code 2.1.222+ isolates worktree sessions and refuses any Bash command that points git at the shared checkout, so the Bash form cannot work from a worktree. With no `target`, merges into whatever branch the main checkout currently has checked out. Refuses (without changing anything) when the target checkout is dirty, and aborts the merge on conflict so the target is left untouched. Commit your own worktree changes first — this merges committed work only. On success from a worktree session the daemon arms an auto-close of that session and the result says exactly when (`autoCloseAt` / `autoCloseMessage`); calling `close_session` after your report closes it immediately instead, and typing in the tab cancels the auto-close.',
      schema: {
        target: z.string().optional().describe('Branch to merge into. Defaults to the branch currently checked out in the main worktree.'),
        session_id: z.string().optional().describe('Caller session ID (auto-detected if omitted).'),
      },
      handler: async ({ target, session_id }, extra) => {
        const callerId = session_id || extra?.requestInfo?.url?.searchParams?.get('shellId');
        const caller = callerId ? shells.get(callerId) : null;
        if (!caller) {
          return { content: [{ type: 'text', text: `Session "${callerId || 'unknown'}" not found.` }], isError: true };
        }
        const { cwd, repoRoot } = sessionPaths(caller);
        if (!cwd || !repoRoot) {
          return { content: [{ type: 'text', text: 'Could not resolve this session\'s working directory.' }], isError: true };
        }
        const result = mergeWorktree({ git: runGit, worktreeCwd: cwd, repoRoot, target });
        log(`[MCP] merge_worktree: ${result.branch || '?'} -> ${result.target || '?'} = ${result.status}`);
        // #627: a successful merge FINISHES this worktree session, so the daemon arms
        // the close here rather than trusting the agent to remember step 9 — it doesn't
        // (30/30 in #609, and again on Opus 5 after the prose had been strengthened as
        // far as it goes). An explicit close_session still closes immediately; any
        // input to the tab cancels.
        //
        // Worktree callers ONLY. merge_worktree is a general tool, not a private skill
        // callback: called from a main-checkout session with an explicit target it does
        // an ordinary, legitimate merge in a long-lived tab nobody asked to end, and
        // auto-closing that would be the worst failure this feature could have.
        // `caller.worktree` is also exactly what get_session_info reports as
        // in_worktree, which is what skills/merge.md branches on at step 4.
        const payload = { ...result };
        if (result.status === 'merged' && caller.worktree && armSessionAutoClose) {
          const armed = armSessionAutoClose(callerId, { reason: 'merged' });
          if (armed) {
            const seconds = Math.max(0, Math.round((armed.closeAt - Date.now()) / 1000));
            payload.autoCloseAt = armed.closeAt;
            payload.autoCloseInSeconds = seconds;
            payload.autoCloseMessage = `This session is finished and will close automatically in ${describeDelay(seconds)}. `
              + 'Call close_session once your report is written to close it now instead; typing in this tab cancels the auto-close.';
          }
        }
        // Only `merged` is a success; every other status left the target unchanged
        // and needs the agent to stop and report rather than continue the skill.
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
          ...(result.status === 'merged' ? {} : { isError: true }),
        };
      },
    },
    open_browser_tab: {
      description: 'Open a URL in a new browser tab in the same window as the caller. Use this to open documentation, previews, or external links alongside the session.',
      schema: {
        url: z.string().describe('The URL to open'),
        session_id: z.string().optional().describe('Caller session ID (auto-detected if omitted)'),
      },
      handler: async ({ session_id, url }, extra) => {
        const callerId = session_id || extra?.requestInfo?.url?.searchParams?.get('shellId');
        const caller = callerId ? shells.get(callerId) : null;
        if (!caller) {
          return { content: [{ type: 'text', text: `Session "${callerId || 'unknown'}" not found.` }] };
        }
        const windowId = caller.windowId || null;
        log(`[MCP] open_browser_tab: url=${url}, caller=${session_id}, windowId=${windowId}`);
        deliverToWindow({ type: 'open-browser-tab', url, windowId }, windowId);
        return { content: [{ type: 'text', text: JSON.stringify({ url, windowId }) }] };
      },
    },
    open_terminal: {
      description: 'Open a new LONG-LIVED tab in the caller\'s browser window — something that keeps running and that someone then has to close. '
        + 'For a one-shot command whose output you want, use `run_in_terminal` instead: it returns the output and closes its own tab. '
        + 'IMPORTANT: by default (no `agent_type`) this opens a PLAIN TERMINAL (zsh) — NOT an agent session — and `prompt` is IGNORED. To open Claude Code, Codex, or another agent — and actually deliver `prompt` — you MUST pass `agent_type` (for example, "claude" or "codex"); or pass `fork: true` to inherit the caller\'s agent type. It does NOT auto-inherit the caller\'s agent type otherwise. Inherits cwd/worktree from the caller. '
        + 'A tab you open is yours to close: call `close_session` with the id this returns when you are done with it.',
      schema: {
        prompt: z.string().optional().describe('Initial prompt to send to the new session. Delivered ONLY to agent sessions (requires `agent_type` or `fork`); IGNORED for a plain terminal — use `command` for those.'),
        command: z.string().optional().describe('Shell command to auto-run on startup (plain terminal tabs only). Runs as if typed at the prompt, and the tab stays open afterward until someone closes it — YOU are the one who opened it, so close it with `close_session` when you are done. For a command that just runs once and finishes, use `run_in_terminal` instead. Ignored for agent sessions.'),
        name: z.string().optional().describe('Tab name for the new session'),
        session_id: z.string().optional().describe('Caller session ID (auto-detected if omitted)'),
        cwd: z.string().optional().describe('Working directory (defaults to caller\'s cwd)'),
        worktree: z.string().optional().describe('Worktree name'),
        agent_type: z.string().optional().describe('Agent type for an AGENT session. Supported: "claude", "codex". Experimental: "opencode", "pi", "hermes" — they run, but get no deepsteve MCP tools and no skills (docs/agents.md). OMIT this → a plain terminal (zsh), NOT the caller\'s agent. To inherit the caller\'s agent type instead, pass `fork: true`.'),
        plan_mode: z.boolean().optional().describe('Start in plan mode'),
        fork: z.boolean().optional().describe('Inherit the caller\'s agent type. For Claude Code callers with a resumable session, also fork the conversation; other agents start a fresh session.'),
      },
      handler: async ({ session_id, prompt, command, name, cwd, worktree, agent_type, plan_mode, fork }, extra) => {
        const callerId = session_id || extra?.requestInfo?.url?.searchParams?.get('shellId');
        const caller = callerId ? shells.get(callerId) : null;
        if (!caller) {
          return { content: [{ type: 'text', text: `Session "${callerId || 'unknown'}" not found.` }] };
        }

        const effectiveCwd = cwd || caller.cwd;
        // Covers both branches below — the plain shell and the agent session, whose
        // ensureWorktree() would otherwise fail confusingly on a missing parent.
        const refusal = refuseMissingCwd(effectiveCwd);
        if (refusal) return refusal;
        // agent_type provided → agent session; fork → inherit caller's agent; otherwise → plain shell
        const effectiveAgentType = agent_type || (fork ? (caller.agentType || 'claude') : null);
        // Inherit custom configs only for Claude agent sessions (#537). Plain terminals
        // keep it too, so manually typing `claude` uses the caller's profile.
        const effectiveConfigDir = !effectiveAgentType || effectiveAgentType === 'claude'
          ? (caller.configDir || null)
          : null;
        const windowId = caller.windowId || null;
        const id = randomUUID().slice(0, 8);

        if (!effectiveAgentType) {
          // Plain shell — no agent, no flags, no session tracking
          const rawCommand = typeof command === 'string' ? command.trim() : '';
          const hasCommand = rawCommand.length > 0;
          // Auto-name the tab from the command when no explicit name was given.
          const tabName = name || (hasCommand ? deriveTabName(rawCommand) : undefined);
          const shellEngine = getDefaultEngine();
          const shellEngineType = shellEngine.constructor.name === 'TmuxEngine' ? 'tmux' : 'node-pty';
          log(`[MCP] open_terminal (shell): id=${id}, engine=${shellEngineType}, cwd=${effectiveCwd}, caller=${session_id}${hasCommand ? `, command=${JSON.stringify(rawCommand)}` : ''}`);
          spawnSession(shellEngine, id, 'terminal', [], effectiveCwd, { cols: 120, rows: 40, env: sessionEnv(id, { name: tabName, windowId, cwd: effectiveCwd, agentType: 'terminal', configDir: effectiveConfigDir }) });
          shells.set(id, {
            clients: new Set(), cwd: effectiveCwd,
            claudeSessionId: null, agentType: 'terminal',
            configDir: effectiveConfigDir,
            engine: shellEngine, engineType: shellEngineType,
            worktree: null, windowId,
            name: tabName, initialPrompt: null,
            waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(),
          });
          wireShellOutput(id);
          emitSessionOpen(id);
          if (hasCommand) {
            // A login shell (`zsh -l`) needs a moment to source profile files and
            // initialize ZLE before typed input renders cleanly at the prompt. tty
            // line discipline buffers input either way, so the command still runs;
            // the delay just gives clean echo. No Ink workaround (submitToShell's
            // text/\r split) is needed for a plain shell — a single write with a
            // trailing newline submits the line atomically.
            setTimeout(() => {
              if (!shells.has(id)) return; // tab may have closed during the delay
              shellEngine.write(id, rawCommand + '\n');
            }, 600);
          }
          shellEngine.onExit(id, () => {
            handleShellGone(id);
          });
          saveState();
          deliverToWindow({ type: 'open-session', id, cwd: effectiveCwd, name: tabName, windowId }, windowId);
          return { content: [{ type: 'text', text: JSON.stringify({
            id, name: tabName || id, cwd: effectiveCwd, worktree: null,
            command: hasCommand ? rawCommand : null,
            // #631: 0 of the first 102 terminal tabs an agent opened were ever closed by
            // an agent. Nothing asked them to — so ask here, at the point of use, the way
            // merge_worktree returns autoCloseMessage. A doc line three files away does
            // not reach the model holding the id.
            cleanupReminder: `This tab stays open until someone closes it. Call close_session with session_id "${id}" when you are done with it. `
              + 'If you only needed one command\'s output, run_in_terminal would have closed itself.',
          }) }] };
        }

        // Agent session
        const agentConfig = getAgentConfig(effectiveAgentType);
        const effectiveWorktree = worktree !== undefined ? (worktree || null) : (caller.worktree || null);
        const validatedWorktree = effectiveWorktree ? validateWorktree(effectiveWorktree) : null;
        let spawnCwd = effectiveCwd;
        if (validatedWorktree && !agentConfig.supportsWorktree) {
          spawnCwd = ensureWorktree(effectiveCwd, validatedWorktree);
        }

        const claudeSessionId = effectiveAgentType === 'codex' ? null : randomUUID();
        const codexHomeId = effectiveAgentType === 'codex' ? id : null;

        let spawnArgs;
        let resolvedForkParent = null;
        if (fork && caller.claudeSessionId && effectiveAgentType === 'claude') {
          // Resolve the caller's LIVE transcript tip (#455) — the in-memory claudeSessionId
          // can lag behind a mid-conversation rotation, which would fork an earlier checkpoint.
          resolvedForkParent = resolveForkParentSession(callerId);
          spawnArgs = ['--resume', resolvedForkParent, '--fork-session', '--session-id', claudeSessionId];
          if (validatedWorktree) spawnArgs.push('--worktree', validatedWorktree);
          spawnArgs.push(...mcpConfigArgs(effectiveAgentType, id));
        } else {
          spawnArgs = getSpawnArgs(effectiveAgentType, {
            sessionId: claudeSessionId,
            planMode: plan_mode || false,
            worktree: validatedWorktree,
            shellId: id,
          });
        }

        const tabName = name || (validatedWorktree ? validatedWorktree : undefined);

        const sessionEngine2 = getDefaultEngine();
        const engineType2 = sessionEngine2.constructor.name === 'TmuxEngine' ? 'tmux' : 'node-pty';
        log(`[MCP] open_terminal: id=${id}, agent=${effectiveAgentType}, engine=${engineType2}, worktree=${validatedWorktree || 'none'}, cwd=${spawnCwd}, caller=${session_id}`);
        // Forked sessions don't pass --permission-mode plan in spawnArgs, so record
        // planMode=false for them regardless of the caller-supplied plan_mode arg.
        const recordedPlanMode = (fork && caller.claudeSessionId && effectiveAgentType === 'claude') ? false : !!plan_mode;
        spawnSession(sessionEngine2, id, effectiveAgentType, spawnArgs, spawnCwd, { cols: 120, rows: 40, env: sessionEnv(id, { name: tabName, worktree: validatedWorktree, windowId, cwd: spawnCwd, agentType: effectiveAgentType, configDir: effectiveConfigDir, codexHomeId }) });
        shells.set(id, {
          clients: new Set(), cwd: spawnCwd,
          claudeSessionId, agentType: effectiveAgentType,
          codexHomeId,
          configDir: effectiveConfigDir,
          engine: sessionEngine2, engineType: engineType2,
          worktree: validatedWorktree, windowId,
          name: tabName, initialPrompt: prompt || null,
          planMode: recordedPlanMode,
          // Explicit fork lineage (#503): a fork embeds the parent's session id in its
          // .jsonl, so recording the parent here lets the parent's watcher authoritatively
          // refuse to adopt this child's id (rather than re-inferring it). Persisted via
          // serializeShellEntry after the saveState() below.
          forkParent: (fork && caller.claudeSessionId && effectiveAgentType === 'claude') ? resolvedForkParent : null,
          waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(),
        });
        wireShellOutput(id);
        emitSessionOpen(id);

        // Inherit Remote Control from the caller (#519) — queued before any `prompt`
        // below so `/rc` submits first. isFork reflects what actually happened (a
        // requested fork without a resumable caller session spawns fresh). No-op for
        // non-claude agents.
        maybeInheritRemoteControl({ newId: id, agentType: effectiveAgentType, isFork: !!(fork && caller.claudeSessionId), parentId: callerId });

        // Deliver the prompt through the shared readiness pipeline (same as start_issue
        // above and the server's other spawn paths). deliverPromptWhenReady handles BOTH
        // delay-based agents (initialPromptDelay > 0) AND BEL agents like claude whose
        // initialPromptDelay is 0 — for the latter it waits for the completion BEL /
        // idle transition before submitting. The previous `initialPromptDelay > 0` guard
        // here silently dropped the prompt for claude (delay 0), so open_terminal agent
        // tabs came up empty.
        if (prompt) {
          shells.get(id).initialPrompt = null;
          deliverPromptWhenReady(id, prompt);
        }

        if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
        sessionEngine2.onExit(id, () => {
          if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
          handleShellGone(id);
        });
        saveState();

        deliverToWindow({ type: 'open-session', id, cwd: spawnCwd, name: tabName, windowId }, windowId);

        return { content: [{ type: 'text', text: JSON.stringify({ id, name: tabName || id, cwd: spawnCwd, worktree: validatedWorktree }) }] };
      },
    },
    run_in_terminal: {
      description: 'Run ONE shell command in a disposable terminal tab and return what it printed. '
        + 'The tab is visible while it runs, then closes itself — you never have to clean it up. '
        + 'Use this instead of `open_terminal` for anything one-shot: a `git` command in the main checkout, '
        + '`gh`, a build, a test run. It is also the way OUT of Claude Code\'s worktree isolation guard, '
        + 'which refuses Bash commands that reach the shared checkout — this runs in the daemon\'s shell, not yours. '
        + 'The default working directory is the caller\'s `cwd`, which for a worktree session is the MAIN CHECKOUT. '
        + 'Runs in a login shell, so it has the same PATH a terminal tab does. '
        + 'Blocks until the command exits or `timeout_seconds` elapses; on timeout you get the output so far and '
        + 'the tab still tears itself down on its own. The result\'s `auto_close` says which way that went — '
        + '`armed` (closing in `auto_close_in_seconds`), `closed_immediately`, `user_typed` (someone claimed the tab, so it stays), '
        + 'or `shell_gone`. Every run is recorded to ~/.deepsteve/terminal-runs.jsonl.',
      schema: {
        command: z.string().describe('The shell command to run. One command (it may be a pipeline or a `&&` chain); it is not typed at a prompt, it IS the tab\'s process.'),
        cwd: z.string().optional().describe('Working directory. Defaults to the caller\'s cwd — the main checkout for a worktree session.'),
        name: z.string().optional().describe('Tab name (defaults to the command, shortened).'),
        timeout_seconds: z.number().optional().describe('How long to wait for the command before returning what it has printed so far (default 120, max 900). The run keeps going and still cleans itself up.'),
        session_id: z.string().optional().describe('Caller session ID (auto-detected if omitted)'),
      },
      handler: async ({ session_id, command, cwd, name, timeout_seconds }, extra) => {
        const callerId = session_id || extra?.requestInfo?.url?.searchParams?.get('shellId');
        const caller = callerId ? shells.get(callerId) : null;
        if (!caller) {
          return { content: [{ type: 'text', text: `Session "${callerId || 'unknown'}" not found.` }], isError: true };
        }
        const rawCommand = typeof command === 'string' ? command.trim() : '';
        if (!rawCommand) {
          return { content: [{ type: 'text', text: 'command is required.' }], isError: true };
        }

        const effectiveCwd = cwd || caller.cwd;
        // Worst case of the three: a run whose cwd silently relocated to $HOME returns
        // the command's real output, so the caller believes `git status` ran in a repo.
        const refusal = refuseMissingCwd(effectiveCwd);
        if (refusal) return refusal;
        const effectiveConfigDir = caller.configDir || null;
        const windowId = caller.windowId || null;
        const id = randomUUID().slice(0, 8);
        // 8 lowercase hex — terminal-run.js validates the shape before interpolating it
        // into a shell string and a RegExp, so it may not be a caller-supplied value.
        const nonce = randomUUID().replace(/-/g, '').slice(0, 8);
        const tabName = name || deriveTabName(rawCommand);
        const startedAt = Date.now();

        const shellEngine = getDefaultEngine();
        const shellEngineType = shellEngine.constructor.name === 'TmuxEngine' ? 'tmux' : 'node-pty';
        log(`[MCP] run_in_terminal: id=${id}, engine=${shellEngineType}, cwd=${effectiveCwd}, caller=${callerId}, command=${JSON.stringify(rawCommand)}`);

        spawnSession(shellEngine, id, 'terminal', [], effectiveCwd, {
          cols: 120, rows: 40,
          env: sessionEnv(id, { name: tabName, windowId, cwd: effectiveCwd, agentType: 'terminal', configDir: effectiveConfigDir }),
          runCommand: rawCommand, runNonce: nonce,
        });
        shells.set(id, {
          clients: new Set(), cwd: effectiveCwd,
          claudeSessionId: null, agentType: 'terminal',
          configDir: effectiveConfigDir,
          engine: shellEngine, engineType: shellEngineType,
          worktree: null, windowId,
          name: tabName, initialPrompt: null,
          waitingForInput: false, lastActivity: Date.now(), createdAt: startedAt,
        });
        wireShellOutput(id);
        emitSessionOpen(id);
        saveState();
        // Background (#600): a 200ms `git status` must not yank the user's focus out of
        // whatever they were doing. The tab still appears in the strip with the
        // unseen-activity badge, so a run that matters is still discoverable.
        deliverToWindow({ type: 'open-session', id, cwd: effectiveCwd, name: tabName, windowId, background: true }, windowId);

        // Record the launch BEFORE waiting for it. The audit question this log exists to
        // answer is "what did an agent execute", and that has to survive the daemon dying
        // mid-command — which is exactly when the answer matters most.
        getRunLog().append({
          ts: startedAt, status: 'started', session_id: id, caller: callerId || null,
          cwd: effectiveCwd, command: rawCommand, exit_code: null, duration_ms: null, output: '',
        });

        const state = { finalized: false, exitSnapshot: null, record: null };

        // Snapshot the raw transcript SYNCHRONOUSLY before handleShellGone runs: it
        // calls disposeTerminalScreen, so anything read after this point is gone. This
        // is the path for a shell that died without reaching the marker — killed, or a
        // tab the user closed mid-run. (A command calling `exit` is NOT this case: the
        // wrapper's subshell keeps the run's own shell alive to report it.)
        shellEngine.onExit(id, () => {
          const entry = shells.get(id);
          if (entry && !state.exitSnapshot) state.exitSnapshot = (entry.scrollback || []).join('');
          handleShellGone(id, 'terminal-run-ended');
        });

        async function capture() {
          const entry = shells.get(id);
          if (entry) {
            try { return await screenLines(entry, RUN_TIMINGS.captureLines); } catch { /* fall through */ }
          }
          const raw = state.exitSnapshot || '';
          return stripEscapeSequences(raw).split(/\r\n|\n|\r/).map((l) => l.replace(/\s+$/g, ''));
        }

        // Idempotent: the watcher owns finalization, but the timeout path may have
        // already returned to the caller by the time it runs.
        async function finalize() {
          if (state.finalized) return state.record;
          state.finalized = true;
          const { output, exitCode, found } = splitAtMarker(await capture(), nonce);
          const status = found ? 'finished' : 'gone';

          // What happened to the TAB, named (#635). These five outcomes used to collapse
          // into a bare `auto_close_in_seconds: null`, which is how the leak stayed
          // invisible for so long: a tab left open on purpose, a tab closed on the spot,
          // and a tab nothing closed at all were the same answer to the caller and the
          // same line in terminal-runs.jsonl.
          let autoClose;
          let autoCloseInSeconds = null;
          const live = shells.get(id);
          if (!live) {
            // The pane died before the marker was seen, so handleShellGone has already
            // tombstoned it and sent the tab its close-tab. The close call is belt and
            // braces — it no-ops and returns false when there is no entry — so this
            // branch can no longer fall through having neither armed nor closed.
            autoClose = 'shell_gone';
            if (closeSession) closeSession(id, 'terminal-run-finished');
          } else if (live.lastInputTime) {
            // Someone typed in this tab, so it is theirs now — the same rule the merge
            // auto-close follows (#627). This is only true input: since #635 the
            // terminal's own replies to the capability probes tmux fires at an attaching
            // client no longer reach lastInputTime, and it was those replies — not a
            // person — that took this branch on every single run.
            autoClose = 'user_typed';
            log(`[MCP] run_in_terminal: leaving ${id} open — the user typed in it`);
          } else {
            const armed = armSessionAutoClose
              ? armSessionAutoClose(id, { reason: 'terminal-run-finished', policy: 'terminal-run' })
              : null;
            if (armed) {
              autoClose = 'armed';
              autoCloseInSeconds = Math.max(0, Math.round((armed.closeAt - Date.now()) / 1000));
            } else {
              // arm() returns null on a session we just read as live only when the
              // configured linger is 0 — i.e. "close it now". A ctx wired without the
              // hook at all lands here too and wants the same outcome, but is worth
              // saying out loud rather than reporting as a deliberate zero linger.
              if (!armSessionAutoClose) log(`[MCP] run_in_terminal: ${id} has no auto-close hook — closing outright`);
              autoClose = closeSession && closeSession(id, 'terminal-run-finished') ? 'closed_immediately' : 'leaked';
            }
          }

          state.record = getRunLog().append({
            ts: Date.now(), status, session_id: id, caller: callerId || null,
            cwd: effectiveCwd, command: rawCommand, exit_code: exitCode,
            duration_ms: Date.now() - startedAt, output, auto_close: autoClose,
          });
          log(`[MCP] run_in_terminal: ${id} ${status} exit=${exitCode ?? '?'} in ${state.record.duration_ms}ms (tab: ${autoClose})`);
          return { ...state.record, auto_close_in_seconds: autoCloseInSeconds };
        }

        // Poll the interpreted screen rather than hooking the data stream: it resolves
        // tmux's repaints (raw scrollback does not) and needs no second onData listener.
        // A backward scan of `scanLines` is cheap enough to run four times a second.
        async function watch() {
          const deadline = startedAt + RUN_TIMINGS.maxWatchMs;
          for (;;) {
            const entry = shells.get(id);
            if (!entry) return finalize();                       // exited, or closed
            if (isShuttingDown && isShuttingDown()) return null;  // the final snapshot owns it
            if (Date.now() > deadline) {
              log(`[MCP] run_in_terminal: ${id} gave up watching after ${Math.round(RUN_TIMINGS.maxWatchMs / 3600000)}h`);
              return finalize();
            }
            try {
              const tail = await screenLines(entry, RUN_TIMINGS.scanLines);
              if (splitAtMarker(tail, nonce).found) return finalize();
            } catch { /* transient read failure — try again next tick */ }
            await sleep(RUN_TIMINGS.pollMs);
          }
        }

        const watcher = watch().catch((e) => {
          log(`[MCP] run_in_terminal: watcher for ${id} failed: ${e.message}`);
          return null;
        });

        const timeoutSec = Math.max(1, Math.min(RUN_TIMINGS.maxTimeoutSec,
          Math.round(Number(timeout_seconds) || RUN_TIMINGS.defaultTimeoutSec)));
        const TIMED_OUT = Symbol('timeout');
        // Cleared, not leaked: a bare `sleep(timeoutSec * 1000)` in the race leaves a
        // live timer behind for every fast run, which pins the event loop open for the
        // full timeout after the answer is already known.
        let timeoutTimer = null;
        const timedOut = new Promise((resolve) => { timeoutTimer = setTimeout(() => resolve(TIMED_OUT), timeoutSec * 1000); });
        const done = await Promise.race([watcher, timedOut]);
        clearTimeout(timeoutTimer);

        if (done !== TIMED_OUT && done) {
          return { content: [{ type: 'text', text: JSON.stringify({
            run_id: done.id, session_id: id, status: done.status,
            exit_code: done.exit_code, output: done.output, truncated: done.truncated,
            cwd: effectiveCwd, command: rawCommand, duration_ms: done.duration_ms,
            auto_close: done.auto_close ?? null,
            auto_close_in_seconds: done.auto_close_in_seconds ?? null,
            log_path: getRunLog().file,
          }, null, 2) }] };
        }

        // Still running (or the watcher bailed for shutdown). The watcher keeps going,
        // so the run is still recorded and the tab still closes itself — there is
        // nothing for the caller to clean up either way. Capped like a stored record:
        // this is the one path whose output never passes through the run log, and a
        // chatty build would otherwise hand the caller an unbounded transcript.
        const partial = capOutput(splitAtMarker(await capture(), nonce).output);
        return { content: [{ type: 'text', text: JSON.stringify({
          session_id: id, status: 'running', exit_code: null,
          output: partial.output, truncated: partial.truncated,
          cwd: effectiveCwd, command: rawCommand,
          duration_ms: Date.now() - startedAt,
          // Not "no auto-close" — "not decided yet". The watcher outlives this call and
          // arms or closes when the marker lands; the log record gets the real answer.
          auto_close: 'pending',
          log_path: getRunLog().file,
          note: `Still running after ${timeoutSec}s — this is the output so far. The tab closes itself when the command finishes and the full run is written to the log; do not close it yourself. Use read_session_screen with session_id "${id}" to check on it.`,
        }, null, 2) }] };
      },
    },
  };
}

// Read the durable record of one-shot runs (#631). Same shape as the mod's other REST
// surfaces: a display tab or the user can render it without going through MCP.
function registerRoutes(app) {
  app.get('/api/terminal-runs', (req, res) => {
    // getRunLog() rather than the bare `runLog`: the log loads from disk when it is
    // constructed, so reading it must not depend on a run having happened this boot.
    res.json({ runs: getRunLog().list({ limit: req.query.limit, session: req.query.session }) });
  });
}

module.exports = { init, registerRoutes, deriveTabName, TIMINGS, RUN_TIMINGS };
