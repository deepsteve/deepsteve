const { z } = require('zod');
const { randomUUID } = require('crypto');

function init(context) {
  const {
    shells, spawnAgent, getSpawnArgs, getAgentConfig, wireShellOutput,
    watchClaudeSessionDir, unwatchClaudeSessionDir, saveState,
    validateWorktree, ensureWorktree, submitToShell,
    reloadClients, pendingOpens, settings, log, isShuttingDown,
  } = context;

  return {
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

        // Notify browser to open the new session tab
        const readyClients = [...reloadClients].filter(c => c.readyState === 1);
        const openMsg = JSON.stringify({ type: 'open-session', id, cwd: spawnCwd, name: tabName, windowId });
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
            const broadcastMsg = JSON.stringify({ type: 'open-session', id, cwd: spawnCwd, name: tabName });
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
          readyClients[0].send(JSON.stringify({ type: 'open-session', id, cwd: spawnCwd, name: tabName }));
          delivered = true;
        }
        if (!delivered) {
          pendingOpens.push(JSON.stringify({ type: 'open-session', id, cwd: spawnCwd, name: tabName }));
        }

        return { content: [{ type: 'text', text: JSON.stringify({ id, name: tabName || id, cwd: spawnCwd, worktree: validatedWorktree }) }] };
      },
    },
  };
}

module.exports = { init };
