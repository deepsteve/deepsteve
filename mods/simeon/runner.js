/**
 * Simeon's agent runner — one `claude -p` per request, streamed.
 *
 * WHY THIS IS NOT AN MCP TOOL CALL. It was, and it could not stream by construction: a
 * tool call is atomic, so the model composes the whole `rows` argument and only then does
 * anything reach the canvas. Measured on one request, the first component appeared at
 * 19.3s. Reading the model's own token stream instead and emitting each row the instant
 * its newline lands puts the first component on screen at 2.0s, with the rest arriving
 * about every half second while the model is still writing. The row language was designed
 * for exactly this and had never once been fed that way.
 *
 * WHY --restricted AND A NEUTRAL CWD. The first build spawned the agent in the deepsteve
 * checkout with the full toolset. Over nine turns it made 74 tool calls, 9 of which drew
 * anything: 37 `Bash`, 14 browser probes, 40k characters of thinking. Asked to make a number
 * red, it patched render.js, simeon.css and tools.js and deployed them. Given a repo and a
 * shell, a coding agent investigates and edits; that is what it is for. So it gets neither:
 * `--restricted` drops the command-running tools and ignores user/project/local settings
 * files, and the cwd is a scratch directory with no CLAUDE.md and nothing to grep.
 *
 * The full autopsy, with the per-turn numbers, is in notes/first-session.md. Read it before
 * loosening any of this — every flag here is one of its findings.
 *
 * WHY --system-prompt RATHER THAN --append-system-prompt. Appending leaves the whole Claude
 * Code coding-agent persona in front of it. Replacing it is what makes the model a renderer
 * rather than an engineer holding a renderer's instructions.
 *
 * STATELESS BY DESIGN. There is no conversation. Each request carries the current canvas —
 * which the row log already holds verbatim — as context. Nothing to resume, nothing to
 * compact, and no second copy of the state to drift from the first.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveBinary } = require('../../bin-path');
const { stateDir } = require('../../paths');

// Thinking has no `off` in --effort, whose floor is `low`. MAX_THINKING_TOKENS=0 is the
// actual switch, and Claude Code says so itself: its own message for this state reads
// "turn thinking back on (unset MAX_THINKING_TOKENS=0)".
const NO_THINKING_ENV = { MAX_THINKING_TOKENS: '0' };

const RUN_TIMEOUT_MS = 120_000;

/**
 * Route one complete line to the canvas or to the chat.
 *
 * Deliberately dumber than mods/simeon/rows.js, which stays the authoritative parser: this
 * only decides WHERE a line goes. A line it wrongly calls a row is parsed by the browser,
 * returns null there, and is ignored — so the failure mode of guessing wrong is a dropped
 * line, never a broken canvas.
 */
function looksLikeRow(line) {
  return /^[ndxc](\s|$)/.test(line.trim());
}

/** A fence the model wrapped its rows in. Not content, and not prose either. */
function isFence(line) {
  return /^\s*```/.test(line);
}

/** The scratch directory the agent runs in: no repo, no CLAUDE.md, nothing to read. */
function agentCwd() {
  const dir = path.join(stateDir(), 'simeon');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

/**
 * Pull the assistant's text out of one stream-json frame.
 *
 * Two shapes, both handled: a partial-message delta (what --include-partial-messages emits,
 * and the only one that streams) and a whole assistant message. The second is the fallback
 * for a CLI without partial messages — it still works, it just arrives in one piece, which
 * is the pre-streaming behaviour rather than a failure.
 */
function textFromFrame(ev, seenComplete) {
  const delta = ev?.event?.delta?.text ?? ev?.delta?.text;
  if (typeof delta === 'string') return { text: delta, streamed: true };

  if (ev?.type === 'assistant' && Array.isArray(ev.message?.content)) {
    const joined = ev.message.content
      .filter(b => b?.type === 'text' && typeof b.text === 'string')
      .map(b => b.text).join('');
    // Only fall back if nothing has streamed, or this double-emits the whole reply.
    if (joined && !seenComplete.streamed) return { text: joined, streamed: false };
  }
  return null;
}

/**
 * Run one request.
 *
 * @param opts.systemPrompt  replaces Claude Code's own system prompt entirely
 * @param opts.prompt        the user's request, with the current canvas prepended
 * @param opts.model         a --model alias/id, or null to inherit the default
 * @param opts.onRow         called with each complete row line, as it lands
 * @param opts.onProse       called with each complete non-row line (goes to the chat)
 * @param opts.log
 * @returns {{ cancel: () => void, done: Promise<{ok:boolean, rows:number, error?:string}> }}
 */
function run({ systemPrompt, prompt, model, onRow, onProse, log = () => {} }) {
  const bin = resolveBinary('claude');
  if (!bin) {
    return { cancel: () => {}, done: Promise.resolve({ ok: false, rows: 0, error: 'claude binary not found' }) };
  }

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    '--verbose',                  // stream-json requires it for the frames we read
    '--system-prompt', systemPrompt,
    '--restricted',               // no Bash/REPL/WebFetch, and user/project settings ignored
    '--disable-slash-commands',
    prompt,
  ];
  if (model) args.splice(1, 0, '--model', model);

  const child = spawn(bin, args, {
    cwd: agentCwd(),
    env: { ...process.env, ...NO_THINKING_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let frameBuf = '';   // NDJSON frames from stdout
  let lineBuf = '';    // assistant text, split on newline into rows
  let rows = 0;
  let stderr = '';
  const seenComplete = { streamed: false };
  let settled = false;

  /** Emit every COMPLETE line in the buffer. A partial last line waits for more tokens —
   *  that wait is the whole contract: a row is not a row until its newline arrives. */
  function drain(final) {
    let nl;
    while ((nl = lineBuf.indexOf('\n')) >= 0) {
      emitLine(lineBuf.slice(0, nl));
      lineBuf = lineBuf.slice(nl + 1);
    }
    if (final && lineBuf.trim()) { emitLine(lineBuf); lineBuf = ''; }
  }

  function emitLine(raw) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || isFence(line)) return;
    if (looksLikeRow(line)) { rows++; onRow(line); }
    else onProse(line);
  }

  child.stdout.on('data', (chunk) => {
    frameBuf += chunk.toString();
    let nl;
    while ((nl = frameBuf.indexOf('\n')) >= 0) {
      const frame = frameBuf.slice(0, nl);
      frameBuf = frameBuf.slice(nl + 1);
      if (!frame.trim()) continue;
      let ev;
      try { ev = JSON.parse(frame); } catch { continue; }
      const got = textFromFrame(ev, seenComplete);
      if (!got) continue;
      if (got.streamed) seenComplete.streamed = true;
      lineBuf += got.text;
      drain(false);
    }
  });

  child.stderr.on('data', (d) => { stderr += d.toString().slice(0, 2000); });

  const done = new Promise((resolve) => {
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      drain(true);
      resolve(result);
    };
    const timer = setTimeout(() => {
      log(`[simeon] run timed out after ${RUN_TIMEOUT_MS}ms, killing`);
      try { child.kill('SIGTERM'); } catch {}
      finish({ ok: false, rows, error: 'timed out' });
    }, RUN_TIMEOUT_MS);

    child.on('error', (e) => finish({ ok: false, rows, error: e.message }));
    child.on('close', (code) => {
      if (code === 0) return finish({ ok: true, rows });
      finish({ ok: false, rows, error: stderr.trim() || `claude exited ${code}` });
    });
  });

  return {
    cancel() { try { child.kill('SIGTERM'); } catch {} },
    done,
  };
}

module.exports = { run, looksLikeRow, isFence, textFromFrame, agentCwd, NO_THINKING_ENV };
