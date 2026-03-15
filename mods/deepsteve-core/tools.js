const { z } = require('zod');
const { randomUUID } = require('crypto');
const { execSync } = require('child_process');
const path = require('path');

function init(context) {
  const {
    shells, closeSession, spawnAgent, getSpawnArgs, getAgentConfig, wireShellOutput,
    watchClaudeSessionDir, unwatchClaudeSessionDir, saveState,
    validateWorktree, ensureWorktree, submitToShell,
    reloadClients, pendingOpens, settings, log, isShuttingDown,
  } = context;

  // Notify browser to open a new session tab, targeting the caller's window
  function notifyOpenSession(id, cwd, name, windowId) {
    const readyClients = [...reloadClients].filter(c => c.readyState === 1);
    const openMsg = JSON.stringify({ type: 'open-session', id, cwd, name, windowId });
    let delivered = false;

    if (windowId) {
      for (const client of readyClients) {
        if (client.windowId === windowId && client.readyState === 1) {
          client.send(openMsg);
          delivered = true;
          break;
        }
      }
      if (!delivered && readyClients.length > 0) {
        const broadcastMsg = JSON.stringify({ type: 'open-session', id, cwd, name });
        for (const client of readyClients) {
          if (client.readyState === 1) client.send(broadcastMsg);
        }
        delivered = true;
      }
      if (!delivered) {
        pendingOpens.push(openMsg);
        delivered = true;
      }
    }
    if (!delivered && readyClients.length > 0) {
      readyClients[0].send(JSON.stringify({ type: 'open-session', id, cwd, name }));
      delivered = true;
    }
    if (!delivered) {
      pendingOpens.push(JSON.stringify({ type: 'open-session', id, cwd, name }));
    }
  }

  return {
    get_session_info: {
      description: 'Get session metadata (tab name, cwd, worktree) for a deepsteve session. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get the session ID.',
      schema: {
        session_id: z.string().describe('The deepsteve session ID. Run `echo $DEEPSTEVE_SESSION_ID` in your terminal to get this value.'),
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

        // Fetch issue details from GitHub if body not provided
        let issueBody = body || null;
        let issueLabels = labels || null;
        let issueUrl = url || null;
        if (!issueBody) {
          try {
            const gh = JSON.parse(execSync(
              `zsh -l -c 'gh issue view ${Number(number)} --json body,labels,url'`,
              { cwd: effectiveCwd, encoding: 'utf8', timeout: 15000 }
            ));
            issueBody = gh.body;
            issueLabels = issueLabels || (Array.isArray(gh.labels) ? gh.labels.map(l => typeof l === 'string' ? l : l.name).join(', ') : null);
            issueUrl = issueUrl || gh.url;
          } catch (e) {
            log(`[MCP] start_issue: failed to fetch issue #${number} from GitHub: ${e.message}`);
          }
        }

        // Build prompt from wand template
        const vars = {
          number,
          title,
          labels: issueLabels || 'none',
          url: issueUrl || '',
          body: issueBody ? String(issueBody).slice(0, 2000) : '(no description)',
        };
        const prompt = settings.wandPromptTemplate.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');

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

        log(`[MCP] start_issue #${number}: id=${id}, agent=${effectiveAgentType}, worktree=${worktree || 'none'}, cwd=${spawnCwd}`);
        const shell = spawnAgent(effectiveAgentType, spawnArgs, spawnCwd, { cols: 120, rows: 40, env: { DEEPSTEVE_SESSION_ID: id } });
        shells.set(id, {
          shell, clients: new Set(), cwd: spawnCwd,
          claudeSessionId, agentType: effectiveAgentType,
          worktree: worktree || null, windowId,
          name, initialPrompt: prompt,
          waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(),
        });
        wireShellOutput(id);

        // For non-BEL agents, deliver initialPrompt after delay
        if (prompt && agentConfig.initialPromptDelay > 0) {
          shells.get(id).initialPrompt = null;
          setTimeout(() => submitToShell(shell, prompt), agentConfig.initialPromptDelay);
        }

        if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
        shell.onExit(() => {
          if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
          if (!isShuttingDown()) { shells.delete(id); saveState(); }
        });
        saveState();

        notifyOpenSession(id, spawnCwd, name, windowId);

        return { content: [{ type: 'text', text: JSON.stringify({ id, name, cwd: spawnCwd, worktree: worktree || null }) }] };
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

        // Inherit from caller, allow overrides
        const effectiveCwd = cwd || caller.cwd;
        const effectiveAgentType = agent_type || caller.agentType || 'claude';
        const effectiveWorktree = worktree !== undefined ? (worktree || null) : (caller.worktree || null);
        const windowId = caller.windowId || null;
        const agentConfig = getAgentConfig(effectiveAgentType);

        // Validate and prepare worktree
        const validatedWorktree = effectiveWorktree ? validateWorktree(effectiveWorktree) : null;
        let spawnCwd = effectiveCwd;
        if (validatedWorktree && !agentConfig.supportsWorktree) {
          spawnCwd = ensureWorktree(effectiveCwd, validatedWorktree);
        }

        const id = randomUUID().slice(0, 8);
        const claudeSessionId = randomUUID();

        let spawnArgs;
        if (fork && caller.claudeSessionId) {
          // Fork: resume caller's conversation into a new forked session
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

        log(`[MCP] open_terminal: id=${id}, agent=${effectiveAgentType}, worktree=${validatedWorktree || 'none'}, cwd=${spawnCwd}, caller=${session_id}`);
        const shell = spawnAgent(effectiveAgentType, spawnArgs, spawnCwd, { cols: 120, rows: 40, env: { DEEPSTEVE_SESSION_ID: id } });
        shells.set(id, {
          shell, clients: new Set(), cwd: spawnCwd,
          claudeSessionId, agentType: effectiveAgentType,
          worktree: validatedWorktree, windowId,
          name: tabName, initialPrompt: prompt || null,
          waitingForInput: false, lastActivity: Date.now(), createdAt: Date.now(),
        });
        wireShellOutput(id);

        // For non-BEL agents, deliver initialPrompt after delay
        if (prompt && agentConfig.initialPromptDelay > 0) {
          shells.get(id).initialPrompt = null;
          setTimeout(() => submitToShell(shell, prompt), agentConfig.initialPromptDelay);
        }

        if (agentConfig.supportsSessionWatch) watchClaudeSessionDir(id);
        shell.onExit(() => {
          if (agentConfig.supportsSessionWatch) unwatchClaudeSessionDir(id);
          if (!isShuttingDown()) { shells.delete(id); saveState(); }
        });
        saveState();

        notifyOpenSession(id, spawnCwd, tabName, windowId);

        return { content: [{ type: 'text', text: JSON.stringify({ id, name: tabName || id, cwd: spawnCwd, worktree: validatedWorktree }) }] };
      },
    },
  };
}

module.exports = { init };
