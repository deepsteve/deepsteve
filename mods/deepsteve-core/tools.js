const { z } = require('zod');
const { randomUUID } = require('crypto');
const path = require('path');

function init(context) {
  const {
    shells, closeSession, spawnSession, sessionEnv, getSpawnArgs, getAgentConfig, wireShellOutput, getDefaultEngine,
    watchClaudeSessionDir, unwatchClaudeSessionDir, saveState,
    validateWorktree, ensureWorktree, submitToShell,
    fetchIssueFromGitHub, deliverPromptWhenReady,
    reloadClients, deliverToWindow, settings, log, isShuttingDown,
  } = context;

  return {
    get_session_info: {
      description: 'Get live session metadata (tab name, cwd, worktree) for a deepsteve session. Session context is also available via env vars ($DEEPSTEVE_SESSION_ID, $DEEPSTEVE_TAB_NAME, $DEEPSTEVE_WORKTREE, $DEEPSTEVE_WINDOW_ID, $DEEPSTEVE_API_URL) and via GET $DEEPSTEVE_API_URL/api/shells/<id>/info.',
      schema: {
        session_id: z.string().describe('The deepsteve session ID (available as $DEEPSTEVE_SESSION_ID env var).'),
      },
      handler: async ({ session_id }) => {
        const entry = shells.get(session_id);
        if (!entry) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
        }
        const fallbackName = entry.cwd ? path.basename(entry.cwd) : 'shell';
        return {
          content: [{ type: 'text', text: JSON.stringify({
            id: session_id,
            name: entry.name || fallbackName || 'root',
            cwd: entry.cwd,
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
      description: 'Close a deepsteve session and its browser tab. Gracefully terminates the Claude process. Call this when your work is complete and you want to clean up.',
      schema: {
        session_id: z.string().describe('The deepsteve session ID to close. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value.'),
      },
      handler: async ({ session_id }) => {
        if (!closeSession(session_id)) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
        }
        return { content: [{ type: 'text', text: `Session "${session_id}" closed.` }] };
      },
    },
    start_issue: {
      description: 'Open a new deepsteve session for a GitHub issue. Fetches the issue body from GitHub, creates a worktree, and starts an agent with the issue prompt. Pass your DEEPSTEVE_SESSION_ID so the new tab opens in the same browser window.',
      schema: {
        session_id: z.string().describe('Your DEEPSTEVE_SESSION_ID env var — used to inherit context'),
        number: z.number().describe('GitHub issue number'),
        title: z.string().describe('Issue title'),
        body: z.string().optional().describe('Issue body (if omitted, fetched from GitHub via gh CLI)'),
        labels: z.string().optional().describe('Comma-separated labels'),
        url: z.string().optional().describe('Issue URL'),
        cwd: z.string().optional().describe('Working directory (defaults to caller\'s cwd)'),
        agent_type: z.string().optional().describe('Agent type (defaults to caller\'s)'),
      },
      handler: async ({ session_id, number, title, body, labels, url, cwd, agent_type }) => {
        const caller = shells.get(session_id);
        if (!caller) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
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
        });

        const maxLen = settings.maxIssueTitleLength || 25;
        const tabTitle = `#${number} ${title}`;
        const name = tabTitle.length <= maxLen ? tabTitle : tabTitle.slice(0, maxLen) + '\u2026';

        const sessionEngine = getDefaultEngine();
        const engineType = sessionEngine.constructor.name === 'TmuxEngine' ? 'tmux' : 'node-pty';
        log(`[MCP] start_issue #${number}: id=${id}, agent=${effectiveAgentType}, engine=${engineType}, worktree=${worktree || 'none'}, cwd=${spawnCwd}`);
        spawnSession(sessionEngine, id, effectiveAgentType, spawnArgs, spawnCwd, { cols: 120, rows: 40, env: sessionEnv(id, { name, worktree, windowId }) });
        shells.set(id, {
          clients: new Set(), cwd: spawnCwd,
          claudeSessionId, agentType: effectiveAgentType,
          engine: sessionEngine, engineType,
          worktree: worktree || null, windowId,
          name, initialPrompt: null,
          waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(),
        });
        wireShellOutput(id);

        if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
        sessionEngine.onExit(id, () => {
          if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
          if (!isShuttingDown()) { shells.delete(id); saveState(); }
        });
        saveState();

        // When body was NOT provided, fetch async and deliver prompt via WS when ready
        if (!body) {
          fetchIssueFromGitHub(number, effectiveCwd).then(gh => {
            const issueBody = gh ? gh.body : null;
            const issueLabels = gh ? (labels || (Array.isArray(gh.labels) ? gh.labels.map(l => typeof l === 'string' ? l : l.name).join(', ') : null)) : labels;
            const issueUrl = gh ? (url || gh.url) : url;
            const asyncPrompt = buildPrompt(issueBody, issueLabels, issueUrl);
            const deliverMsg = JSON.stringify({ type: 'deliver-prompt', id, initialPrompt: asyncPrompt });
            for (const client of [...reloadClients].filter(c => c.readyState === 1)) {
              client.send(deliverMsg);
            }
          });
        }

        deliverToWindow({ type: 'open-session', id, cwd: spawnCwd, name, windowId, initialPrompt: prompt }, windowId);

        return { content: [{ type: 'text', text: JSON.stringify({ id, name, cwd: spawnCwd, worktree: worktree || null }) }] };
      },
    },
    open_browser_tab: {
      description: 'Open a URL in a new browser tab in the same window as the given session. Use this to open documentation, previews, or external links alongside the session.',
      schema: {
        session_id: z.string().describe('Your DEEPSTEVE_SESSION_ID env var — used to target the correct browser window'),
        url: z.string().describe('The URL to open'),
      },
      handler: async ({ session_id, url }) => {
        const caller = shells.get(session_id);
        if (!caller) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
        }
        const windowId = caller.windowId || null;
        log(`[MCP] open_browser_tab: url=${url}, caller=${session_id}, windowId=${windowId}`);
        deliverToWindow({ type: 'open-browser-tab', url, windowId }, windowId);
        return { content: [{ type: 'text', text: JSON.stringify({ url, windowId }) }] };
      },
    },
    open_terminal: {
      description: 'Open a new deepsteve terminal session (new browser tab). Inherits context (cwd, worktree, windowId, agentType) from the calling session. Pass your DEEPSTEVE_SESSION_ID so the new tab opens in the same browser window.',
      schema: {
        session_id: z.string().describe('Your DEEPSTEVE_SESSION_ID env var — used to inherit context'),
        prompt: z.string().optional().describe('Initial prompt to send to the new session'),
        name: z.string().optional().describe('Tab name for the new session'),
        cwd: z.string().optional().describe('Working directory (defaults to caller\'s cwd)'),
        worktree: z.string().optional().describe('Worktree name'),
        agent_type: z.string().optional().describe('Agent type (defaults to caller\'s)'),
        plan_mode: z.boolean().optional().describe('Start in plan mode'),
        fork: z.boolean().optional().describe('Fork the calling session\'s Claude conversation into the new tab'),
      },
      handler: async ({ session_id, prompt, name, cwd, worktree, agent_type, plan_mode, fork }) => {
        const caller = shells.get(session_id);
        if (!caller) {
          return { content: [{ type: 'text', text: `Session "${session_id}" not found.` }] };
        }

        const effectiveCwd = cwd || caller.cwd;
        // agent_type provided → agent session; fork → inherit caller's agent; otherwise → plain shell
        const effectiveAgentType = agent_type || (fork ? (caller.agentType || 'claude') : null);
        const windowId = caller.windowId || null;
        const id = randomUUID().slice(0, 8);

        if (!effectiveAgentType) {
          // Plain shell — no agent, no flags, no session tracking
          const tabName = name || undefined;
          const shellEngine = getDefaultEngine();
          const shellEngineType = shellEngine.constructor.name === 'TmuxEngine' ? 'tmux' : 'node-pty';
          log(`[MCP] open_terminal (shell): id=${id}, engine=${shellEngineType}, cwd=${effectiveCwd}, caller=${session_id}`);
          spawnSession(shellEngine, id, 'terminal', [], effectiveCwd, { cols: 120, rows: 40, env: sessionEnv(id, { name: tabName, windowId }) });
          shells.set(id, {
            clients: new Set(), cwd: effectiveCwd,
            claudeSessionId: null, agentType: 'terminal',
            engine: shellEngine, engineType: shellEngineType,
            worktree: null, windowId,
            name: tabName, initialPrompt: null,
            waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(),
          });
          wireShellOutput(id);
          shellEngine.onExit(id, () => {
            if (!isShuttingDown()) { shells.delete(id); saveState(); }
          });
          saveState();
          deliverToWindow({ type: 'open-session', id, cwd: effectiveCwd, name: tabName, windowId }, windowId);
          return { content: [{ type: 'text', text: JSON.stringify({ id, name: tabName || id, cwd: effectiveCwd, worktree: null }) }] };
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
        } else {
          spawnArgs = getSpawnArgs(effectiveAgentType, {
            sessionId: claudeSessionId,
            planMode: plan_mode || false,
            worktree: validatedWorktree,
          });
        }

        const tabName = name || (validatedWorktree ? validatedWorktree : undefined);

        const sessionEngine2 = getDefaultEngine();
        const engineType2 = sessionEngine2.constructor.name === 'TmuxEngine' ? 'tmux' : 'node-pty';
        log(`[MCP] open_terminal: id=${id}, agent=${effectiveAgentType}, engine=${engineType2}, worktree=${validatedWorktree || 'none'}, cwd=${spawnCwd}, caller=${session_id}`);
        spawnSession(sessionEngine2, id, effectiveAgentType, spawnArgs, spawnCwd, { cols: 120, rows: 40, env: sessionEnv(id, { name: tabName, worktree: validatedWorktree, windowId }) });
        shells.set(id, {
          clients: new Set(), cwd: spawnCwd,
          claudeSessionId, agentType: effectiveAgentType,
          engine: sessionEngine2, engineType: engineType2,
          worktree: validatedWorktree, windowId,
          name: tabName, initialPrompt: prompt || null,
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

module.exports = { init };
