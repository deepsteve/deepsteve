const { z } = require('zod');
const { randomUUID } = require('crypto');
const path = require('path');

// Derive a short, single-line tab name from a shell command (used when a
// terminal tab is opened with a `command` but no explicit `name`).
function deriveTabName(cmd) {
  const oneLine = cmd.replace(/\s+/g, ' ').trim();
  const MAX = 24;
  return oneLine.length > MAX ? oneLine.slice(0, MAX - 1) + '…' : oneLine;
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

function init(context) {
  const {
    shells, closeSession, handleShellGone, spawnSession, sessionEnv, getSpawnArgs, mcpConfigArgs, getAgentConfig, wireShellOutput, getDefaultEngine, getForegroundCommand,
    watchClaudeSessionDir, unwatchClaudeSessionDir, resolveForkParentSession, saveState,
    validateWorktree, ensureWorktree, sessionPaths, submitToShell,
    fetchIssueFromGitHub, deliverPromptWhenReady,
    reloadClients, deliverToWindow, settings, log, isShuttingDown,
    emitSessionOpen,
    stripEscapeSequences, readTerminalScreen, sessionInputState, maybeInheritRemoteControl, requestMetaControlsConsent,
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
        agent_type: z.string().optional().describe('Agent type (defaults to caller\'s): "claude", "codex" (beta), or an experimental agent such as "opencode", "pi", or "hermes".'),
      },
      handler: async ({ session_id, number, title, body, labels, url, cwd, agent_type }, extra) => {
        const callerId = session_id || extra?.requestInfo?.url?.searchParams?.get('shellId');
        const caller = callerId ? shells.get(callerId) : null;
        if (!caller) {
          return { content: [{ type: 'text', text: `Session "${callerId || 'unknown'}" not found.` }] };
        }

        // Inherit from caller, allow overrides
        const effectiveCwd = cwd || caller.cwd;
        const effectiveAgentType = agent_type || caller.agentType || 'claude';
        // Custom config profiles are a Claude-only surface (#537). An explicit
        // override to Codex/another agent must not leak CLAUDE_CONFIG_DIR.
        const effectiveConfigDir = effectiveAgentType === 'claude' ? (caller.configDir || null) : null;
        const windowId = caller.windowId || null;

        // Build prompt helper
        function buildPrompt(issueBody, issueLabels, issueUrl) {
          const vars = {
            number,
            title,
            labels: issueLabels || 'none',
            url: issueUrl || '',
            body: issueBody ? String(issueBody).slice(0, 2000) : '(no description)',
          };
          return settings.wandPromptTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
        }

        // When body is provided inline, build prompt synchronously
        const prompt = body ? buildPrompt(body, labels, url) : null;

        const worktree = validateWorktree('github-issue-' + number);
        const id = randomUUID().slice(0, 8);
        const claudeSessionId = effectiveAgentType === 'codex' ? null : randomUUID();
        const codexHomeId = effectiveAgentType === 'codex' ? id : null;
        const agentConfig = getAgentConfig(effectiveAgentType);

        // For agents that don't support --worktree natively: manually create worktree
        let spawnCwd = effectiveCwd;
        if (worktree && !agentConfig.supportsWorktree) {
          spawnCwd = ensureWorktree(effectiveCwd, worktree);
        }

        const spawnArgs = getSpawnArgs(effectiveAgentType, {
          sessionId: claudeSessionId,
          planMode: settings.wandPlanMode,
          worktree,
          shellId: id,
        });

        const maxLen = settings.maxIssueTitleLength || 25;
        const tabTitle = `#${number} ${title}`;
        const name = tabTitle.length <= maxLen ? tabTitle : tabTitle.slice(0, maxLen) + '\u2026';

        const sessionEngine = getDefaultEngine();
        const engineType = sessionEngine.constructor.name === 'TmuxEngine' ? 'tmux' : 'node-pty';
        log(`[MCP] start_issue #${number}: id=${id}, agent=${effectiveAgentType}, engine=${engineType}, worktree=${worktree || 'none'}, cwd=${spawnCwd}`);
        spawnSession(sessionEngine, id, effectiveAgentType, spawnArgs, spawnCwd, { cols: 120, rows: 40, env: sessionEnv(id, { name, worktree, windowId, cwd: spawnCwd, agentType: effectiveAgentType, configDir: effectiveConfigDir, codexHomeId }) });
        shells.set(id, {
          clients: new Set(), cwd: spawnCwd,
          claudeSessionId, agentType: effectiveAgentType,
          codexHomeId,
          configDir: effectiveConfigDir,
          engine: sessionEngine, engineType,
          worktree: worktree || null, windowId,
          name, initialPrompt: null,
          planMode: !!settings.wandPlanMode,
          waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(),
          loading: true,
        });
        wireShellOutput(id);
        emitSessionOpen(id);

        if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
        sessionEngine.onExit(id, () => {
          if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
          handleShellGone(id);
        });
        saveState();

        // Inherit Remote Control from the caller (#519) — queued BEFORE the issue
        // prompt so `/rc` submits first; deliverPromptWhenReady sequences the two.
        maybeInheritRemoteControl({ newId: id, agentType: effectiveAgentType, isFork: false, parentId: callerId });

        // Deliver prompt: sync if body provided, async fetch from GitHub otherwise
        if (prompt) {
          deliverPromptWhenReady(id, prompt);
        } else {
          fetchIssueFromGitHub(number, effectiveCwd).then(gh => {
            const issueBody = gh ? gh.body : null;
            const issueLabels = gh ? (labels || (Array.isArray(gh.labels) ? gh.labels.map(l => typeof l === 'string' ? l : l.name).join(', ') : null)) : labels;
            const issueUrl = gh ? (url || gh.url) : url;
            const asyncPrompt = buildPrompt(issueBody, issueLabels, issueUrl);
            deliverPromptWhenReady(id, asyncPrompt);
          });
        }

        deliverToWindow({ type: 'open-session', id, cwd: spawnCwd, name, windowId, loading: true }, windowId);

        return { content: [{ type: 'text', text: JSON.stringify({ id, name, cwd: spawnCwd, worktree: worktree || null }) }] };
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
      description: 'Open a new tab in the caller\'s browser window. IMPORTANT: by default (no `agent_type`) this opens a PLAIN TERMINAL (zsh) — NOT an agent session — and `prompt` is IGNORED. To open Claude Code, Codex beta, or another agent — and actually deliver `prompt` — you MUST pass `agent_type` (for example, "claude" or "codex"); or pass `fork: true` to inherit the caller\'s agent type. It does NOT auto-inherit the caller\'s agent type otherwise. Inherits cwd/worktree from the caller.',
      schema: {
        prompt: z.string().optional().describe('Initial prompt to send to the new session. Delivered ONLY to agent sessions (requires `agent_type` or `fork`); IGNORED for a plain terminal — use `command` for those.'),
        command: z.string().optional().describe('Shell command to auto-run on startup (plain terminal tabs only). Runs as if typed at the prompt; the tab stays open afterward. Ignored for agent sessions.'),
        name: z.string().optional().describe('Tab name for the new session'),
        session_id: z.string().optional().describe('Caller session ID (auto-detected if omitted)'),
        cwd: z.string().optional().describe('Working directory (defaults to caller\'s cwd)'),
        worktree: z.string().optional().describe('Worktree name'),
        agent_type: z.string().optional().describe('Agent type for an AGENT session, e.g. "claude", "codex" (beta), or "pi" (experimental). OMIT this → a plain terminal (zsh), NOT the caller\'s agent. To inherit the caller\'s agent type instead, pass `fork: true`.'),
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
          return { content: [{ type: 'text', text: JSON.stringify({ id, name: tabName || id, cwd: effectiveCwd, worktree: null, command: hasCommand ? rawCommand : null }) }] };
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
  };
}

module.exports = { init, deriveTabName, TIMINGS };
