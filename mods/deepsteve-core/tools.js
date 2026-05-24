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

function init(context) {
  const {
    shells, closeSession, spawnSession, sessionEnv, getSpawnArgs, mcpConfigArgs, getAgentConfig, wireShellOutput, getDefaultEngine,
    watchClaudeSessionDir, unwatchClaudeSessionDir, saveState,
    validateWorktree, ensureWorktree, sessionPaths, submitToShell,
    fetchIssueFromGitHub, deliverPromptWhenReady,
    reloadClients, deliverToWindow, settings, log, isShuttingDown,
  } = context;

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
      description: 'Get live session metadata for a deepsteve session: tab name, cwd (your actual working directory — the worktree path for worktree sessions), repoRoot (the main repo checkout), and worktree (the worktree name, or null). Use `get_my_session_id` to get your session ID.',
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
            createdAt: entry.createdAt || null,
            elapsedMs: entry.createdAt ? Date.now() - entry.createdAt : null,
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
        agent_type: z.string().optional().describe('Agent type (defaults to caller\'s)'),
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
        const claudeSessionId = randomUUID();
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
        spawnSession(sessionEngine, id, effectiveAgentType, spawnArgs, spawnCwd, { cols: 120, rows: 40, env: sessionEnv(id, { name, worktree, windowId, cwd: spawnCwd, agentType: effectiveAgentType }) });
        shells.set(id, {
          clients: new Set(), cwd: spawnCwd,
          claudeSessionId, agentType: effectiveAgentType,
          engine: sessionEngine, engineType,
          worktree: worktree || null, windowId,
          name, initialPrompt: null,
          planMode: !!settings.wandPlanMode,
          waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(),
          loading: true,
        });
        wireShellOutput(id);

        if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
        sessionEngine.onExit(id, () => {
          if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
          if (!isShuttingDown()) { shells.delete(id); saveState(); }
        });
        saveState();

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
      description: 'Open a new deepsteve terminal session (new tab). Inherits context (cwd, worktree, agent type) from the calling session. The new tab opens in the same browser window as the caller.',
      schema: {
        prompt: z.string().optional().describe('Initial prompt to send to the new session'),
        command: z.string().optional().describe('Shell command to auto-run on startup (plain terminal tabs only). Runs as if typed at the prompt; the tab stays open afterward. Ignored for agent sessions.'),
        name: z.string().optional().describe('Tab name for the new session'),
        session_id: z.string().optional().describe('Caller session ID (auto-detected if omitted)'),
        cwd: z.string().optional().describe('Working directory (defaults to caller\'s cwd)'),
        worktree: z.string().optional().describe('Worktree name'),
        agent_type: z.string().optional().describe('Agent type (defaults to caller\'s)'),
        plan_mode: z.boolean().optional().describe('Start in plan mode'),
        fork: z.boolean().optional().describe('Fork the calling session\'s Claude conversation into the new tab'),
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
          spawnSession(shellEngine, id, 'terminal', [], effectiveCwd, { cols: 120, rows: 40, env: sessionEnv(id, { name: tabName, windowId, cwd: effectiveCwd, agentType: 'terminal' }) });
          shells.set(id, {
            clients: new Set(), cwd: effectiveCwd,
            claudeSessionId: null, agentType: 'terminal',
            engine: shellEngine, engineType: shellEngineType,
            worktree: null, windowId,
            name: tabName, initialPrompt: null,
            waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(),
          });
          wireShellOutput(id);
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
            if (!isShuttingDown()) { shells.delete(id); saveState(); }
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

        const claudeSessionId = randomUUID();

        let spawnArgs;
        if (fork && caller.claudeSessionId) {
          spawnArgs = ['--resume', caller.claudeSessionId, '--fork-session', '--session-id', claudeSessionId];
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
        const recordedPlanMode = (fork && caller.claudeSessionId) ? false : !!plan_mode;
        spawnSession(sessionEngine2, id, effectiveAgentType, spawnArgs, spawnCwd, { cols: 120, rows: 40, env: sessionEnv(id, { name: tabName, worktree: validatedWorktree, windowId, cwd: spawnCwd, agentType: effectiveAgentType }) });
        shells.set(id, {
          clients: new Set(), cwd: spawnCwd,
          claudeSessionId, agentType: effectiveAgentType,
          engine: sessionEngine2, engineType: engineType2,
          worktree: validatedWorktree, windowId,
          name: tabName, initialPrompt: prompt || null,
          planMode: recordedPlanMode,
          waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(),
        });
        wireShellOutput(id);

        if (prompt && agentConfig.initialPromptDelay > 0) {
          shells.get(id).initialPrompt = null;
          setTimeout(() => submitToShell(id, prompt), agentConfig.initialPromptDelay);
        }

        if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
        sessionEngine2.onExit(id, () => {
          if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
          if (!isShuttingDown()) { shells.delete(id); saveState(); }
        });
        saveState();

        deliverToWindow({ type: 'open-session', id, cwd: spawnCwd, name: tabName, windowId }, windowId);

        return { content: [{ type: 'text', text: JSON.stringify({ id, name: tabName || id, cwd: spawnCwd, worktree: validatedWorktree }) }] };
      },
    },
  };
}

module.exports = { init, deriveTabName };
