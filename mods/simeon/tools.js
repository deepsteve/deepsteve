/**
 * Simeon (prototype) — a live UI REPL.
 *
 * The human types in a chat box at the bottom of the app; a `claude -p` subprocess draws
 * the interface on the canvas above by emitting ROWS. One row per line, one node per row,
 * so a line break is a component boundary — and because the runner reads the model's token
 * stream, each component mounts the instant its newline arrives, while the model is still
 * writing the rest. See mods/simeon/runner.js for why that replaced an MCP tool call.
 *
 * Four deliberate shapes here:
 *
 * 1. THE SERVER NEVER PARSES A ROW. It appends the text to an ordered log and fans it
 *    out. The browser is the only interpreter, so the language can change without a
 *    daemon restart, and a row the server does not understand is not an error class it
 *    has to have. `simeon_read` returns the log verbatim for the same reason.
 *
 * 2. ONE MONOTONIC EVENT LOG carries rows, chat and agent state together. A reconnecting
 *    or reloading iframe replays from `?since=<seq>` and needs no separate catch-up call
 *    per stream. `c` (clear) truncates the row events behind it, which is the only
 *    compaction this needs.
 *
 * 3. THE TRANSPORT IS SSE ON THIS MOD'S OWN ROUTE, not a WebSocket broadcast. A new push
 *    feed through the host would need a notifyX/onXChanged pair in mod-manager.js plus a
 *    dispatch line in app.js; an EventSource to a route registered right here is
 *    same-origin, carries the auth cookie, and ships with no host edit at all.
 *
 * 4. THE ROW LOG IS THE ONLY STATE. There is no conversation to resume: each request
 *    carries the current canvas, which the log already holds verbatim. That is what makes
 *    a run disposable and every request equally fast.
 *
 * The three MCP tools remain, so any OTHER deepsteve session can draw on the same canvas.
 * They are not how the chat box works any more — notes/first-session.md is the autopsy of
 * the build that worked that way, and is where every constraint in runner.js comes from.
 */

const { z } = require('zod');
const runner = require('./runner');

// Ring cap on the replay log. A canvas rebuild is `c` + the rows, so the practical
// ceiling is "one screen plus its data churn", not a session's whole history.
const MAX_EVENTS = 4000;

// How much of the canvas to hand back to the model as context. A screen is tens of rows;
// this only bites on a pathological one, and truncating the OLDEST rows keeps the part
// the human is most likely talking about.
const MAX_CANVAS_REPLAY = 400;

let ctx = null;

// The single canvas. seq is monotonic across ALL event kinds so one `?since=` cursor
// catches a client up on rows, chat and agent state at once.
const feed = { seq: 0, events: [] };

// Live SSE responses.
const subscribers = new Set();

// The run in flight, if any. One at a time: a second request cancels the first rather than
// racing it onto the same canvas.
let current = null;

// ── event log ───────────────────────────────────────────────────────────────────────

function emit(ev) {
  ev.seq = ++feed.seq;
  ev.at = Date.now();
  feed.events.push(ev);
  if (feed.events.length > MAX_EVENTS) {
    feed.events.splice(0, feed.events.length - MAX_EVENTS);
  }
  const frame = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of subscribers) {
    try { res.write(frame); } catch { subscribers.delete(res); }
  }
  return ev;
}

/** Append one row to the log and push it to every open canvas. */
function pushRow(line) {
  // A clear row makes every row before it unreachable. Dropping them keeps a long REPL
  // session's replay proportional to what is ON SCREEN, not to what has ever been drawn.
  if (line.trim() === 'c') feed.events = feed.events.filter(e => e.kind !== 'row');
  emit({ kind: 'row', row: line });
}

/**
 * Append a batch of rows. Blank lines are dropped here rather than in the parser so the
 * replay log stays dense; everything else — comments included — reaches the browser
 * verbatim, because the row feed in the UI is meant to show what the agent actually wrote.
 */
function appendRows(text) {
  const lines = String(text || '').split('\n').map(l => l.replace(/\s+$/, ''));
  let count = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    pushRow(line);
    count++;
  }
  return count;
}

function say(role, text) {
  return emit({ kind: 'chat', role, text: String(text ?? '') });
}

function agentState(state, detail) {
  return emit({ kind: 'agent', state, detail: detail || null });
}

/** The rows currently making up the canvas, in order. */
function canvasRows() {
  return feed.events.filter(e => e.kind === 'row').map(e => e.row);
}

const LANGUAGE = `Draw on the Simeon canvas. The human watches this render live.

THE ROW LANGUAGE
One row per line. One line is one complete instruction, so a half-arrived batch is still
a valid tree. Four row kinds, keyed by the first token:

  n <id> <type> [@parent] [key=value ...]   create a node, or PATCH one that already exists
  d <path> <value>                          set a data value
  x <id>                                    remove a node and its subtree
  c                                         clear the canvas
  # anything                                comment (ignored, but shown in the row feed)

RULES THAT MATTER
- Every node has a stable id you choose. Re-sending "n <id>" with the same id patches it:
  the props you send are merged, the ones you omit are left alone. That is how you edit.
- @parent may name a node that has NOT ARRIVED YET. The row is held and attached when the
  parent shows up, so rows are order-independent and you can never emit a broken tree.
- Omit @parent to attach to the root.
- Omit <type> on a patch: "n cpu tone=alert" changes one prop of an existing node.

DESIGN AND DATA ARE SEPARATE — THIS IS THE POINT
A prop written as $some.path is a BINDING, not a value. It reads from the data store and
re-renders by itself whenever that path changes.

  n cpu stat @kpis label=CPU value=$sys.cpu unit=%
  d sys.cpu 42

To change that number later you send ONE row — "d sys.cpu 87" — and nothing else. Never
redraw a tree to update a value. Data paths are indexed, so a d row costs one lookup no
matter how large the interface is. "d sys {\\"cpu\\":42,\\"mem\\":71}" also works: $sys.cpu
resolves through the object.

VALUES
  bare        gap=lg          value=42          ok=true
  quoted      title="Mission Control"
  binding     value=$sys.cpu
  json        items=["boot ok","link up"]       series=[3,9,4,12,8]

COMPONENTS
  screen  title=            the page frame. Make one, id it, hang everything off it.
  col     gap= align= pad=  vertical stack        (gap/pad: xs sm md lg xl)
  row     gap= align= wrap= horizontal stack
  grid    cols= gap=        equal-width columns
  card    title= tone=      a bordered panel with a header
  title   value= size=      a heading            (size: sm md lg xl)
  text    value= tone= mono= a paragraph
  stat    label= value= unit= trend= tone=       the big-number readout
  bar     label= value= max= tone=               horizontal meter, value/max
  spark   series= tone=     sparkline from an array of numbers
  heart   bpm= tone= unit=   an SVG heart that beats at the bpm you give it
  list    items= tone=      array of strings, or of {label,value,tone}
  badge   label= tone=      a small pill
  button  label= send=      when pressed, "send" is delivered to you as a message

  tone on any of them: default | accent | ok | warn | alert

EXAMPLE
  c
  n app  screen          title="Mission Control"
  n kpis row    @app     gap=lg
  n cpu  stat   @kpis    label=CPU    value=$sys.cpu unit=% tone=accent
  n mem  stat   @kpis    label=Memory value=$sys.mem unit=%
  n load card   @app     title="Load"
  n hist spark  @load    series=$sys.hist tone=accent
  n feed card   @app     title="Activity"
  n log  list   @feed    items=$events
  n go   button @app     label="Refresh" send="refresh the mission control numbers"
  d sys.cpu 42
  d sys.mem 71
  d sys.hist [3,9,4,12,8,6,14]
  d events ["boot ok","link established"]

Emit rows top-down. Each row mounts the instant its newline lands, while you are still
writing the rest, so the order you write is the order the human watches the interface
assemble in. Frame first, then structure, then leaves, then the d rows.`;

// ── the run layer ───────────────────────────────────────────────────────────────────

/**
 * The system prompt, which REPLACES Claude Code's own rather than appending to it.
 *
 * The grammar is the same LANGUAGE text the MCP tool description carries, so there is one
 * copy of the language in this file and it cannot drift against itself. What is added here
 * is only behaviour, and every line of it is a lesson from the first build's transcript:
 * asked one question about the UI, that agent made thirteen tool calls and read its own
 * source instead of drawing anything.
 */
const RENDERER_PROMPT = `${LANGUAGE}

-- HOW YOU WORK --
You draw interfaces. You are not a software engineer. You have no files to read, no code to
inspect, no repository, and no commands to run. Never investigate, plan, explain your
approach, or narrate what you are about to do.

Emit rows IMMEDIATELY, starting with your very first token. The human is watching them mount
one at a time as you write them.

Write rows as plain lines. Do not wrap them in code fences and do not call any tool.

Any line that is NOT a row is shown to the human as chat. Keep that to one short sentence,
after the rows, and only when there is something they genuinely need to know -- that the
numbers are invented, say. Usually there is nothing, and you should say nothing.

If you are asked for data you cannot have, invent plausible values, draw the interface, and
say so in one line. Never refuse and never ask a clarifying question -- draw your best guess,
because they can correct it in the next message faster than they can answer one.`;

/**
 * Build a request: the canvas as it stands, then what the human asked for.
 *
 * This is the whole of Simeon's memory. The log already holds the canvas verbatim, so
 * replaying it is free and exact -- there is no second representation to fall out of sync,
 * and no conversation to grow, compact, or resume.
 */
function buildPrompt(request) {
  const rows = canvasRows();
  if (!rows.length) return `The canvas is empty.\n\nREQUEST: ${request}`;
  const shown = rows.slice(-MAX_CANVAS_REPLAY);
  const elided = rows.length - shown.length;
  return [
    'CURRENT CANVAS -- these rows are on screen right now:',
    elided ? `(${elided} earlier rows elided)` : null,
    shown.join('\n'),
    '',
    'Patch it with n/d/x rows where you can; send `c` first only if they want something',
    'genuinely different. Re-emitting an existing id edits it in place.',
    '',
    `REQUEST: ${request}`,
  ].filter(l => l !== null).join('\n');
}

/**
 * Start a run. Cancels whatever was in flight -- a second request means the human changed
 * their mind, and two models writing onto one canvas is not a race worth having.
 */
function startRun(request, { model } = {}) {
  if (current) { current.cancel(); current = null; }

  agentState('thinking');
  const startedAt = Date.now();
  let firstRowAt = null;

  const handle = runner.run({
    systemPrompt: RENDERER_PROMPT,
    prompt: buildPrompt(request),
    model: model ? ctx.validateModel(model) : null,
    log: ctx.log,
    onRow: (line) => {
      if (firstRowAt === null) firstRowAt = Date.now() - startedAt;
      pushRow(line);
    },
    // A non-row line is the model talking to the human, so it goes to the chat. One stream,
    // split by grammar -- which is why there is no longer anything for simeon_say to do here.
    onProse: (line) => say('agent', line),
  });

  current = handle;
  handle.done.then((result) => {
    if (current === handle) current = null;
    const total = Date.now() - startedAt;
    ctx.log(`[simeon] run ok=${result.ok} rows=${result.rows} firstRow=${firstRowAt === null ? '-' : firstRowAt}ms total=${total}ms${result.error ? ` error=${result.error}` : ''}`);
    if (!result.ok && result.rows === 0) say('system', `The renderer failed: ${result.error}`);
    agentState('ready');
  });

  return handle;
}


function init(context) {
  ctx = context;

  return {
    simeon_render: {
      description: LANGUAGE,
      schema: {
        rows: z.string().describe('The rows to apply, newline-separated. One row per line.'),
      },
      handler: async ({ rows }) => {
        const n = appendRows(rows);
        return { content: [{ type: 'text', text: `Applied ${n} row${n === 1 ? '' : 's'} to the Simeon canvas.` }] };
      },
    },

    simeon_say: {
      description: 'Send a line to the human in the Simeon chat. This is the ONLY thing they read — '
        + 'your terminal output is not on their screen. Keep it to a sentence or two; the canvas '
        + 'is where the detail goes.',
      schema: { text: z.string().describe('What to say. Plain text.') },
      handler: async ({ text }) => {
        say('agent', text);
        return { content: [{ type: 'text', text: 'Sent.' }] };
      },
    },

    simeon_read: {
      description: 'Read back the rows currently making up the Simeon canvas, in order. Use this when '
        + 'you need to know what is on screen — after a compaction, or before patching a node you did '
        + 'not draw in this turn.',
      schema: {},
      handler: async () => {
        const rows = feed.events.filter(e => e.kind === 'row').map(e => e.row);
        return {
          content: [{
            type: 'text',
            text: rows.length ? rows.join('\n') : 'The canvas is empty.',
          }],
        };
      },
    },
  };
}

// ── REST ────────────────────────────────────────────────────────────────────────────

function registerRoutes(app, context) {
  ctx = ctx || context;

  // The live feed. `since` replays everything the client has not seen; `since=0` (or a
  // cursor older than the ring) rebuilds from scratch, which is exactly what a reloaded
  // iframe wants.
  app.get('/api/simeon/stream', (req, res) => {
    const since = Number(req.query.since) || 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const oldest = feed.events.length ? feed.events[0].seq : feed.seq + 1;
    // The client asked to continue from a point the ring has already dropped. Say so
    // rather than replaying a hole — the canvas it holds is not reconstructable.
    if (since > 0 && since < oldest - 1) {
      res.write(`data: ${JSON.stringify({ kind: 'reset' })}\n\n`);
    }
    for (const ev of feed.events) {
      if (ev.seq > since) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    // No `seq` on a control frame: the client dedupes on it, and the cursor has already
    // advanced past feed.seq by the last replayed row — a seq here is swallowed as stale.
    res.write(`data: ${JSON.stringify({ kind: 'ready', running: !!current })}\n\n`);

    subscribers.add(res);
    // Comment frames, not events: they keep the connection warm without moving the cursor.
    const beat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(beat); subscribers.delete(res); });
  });

  // A message from the human. Starts a streaming run; rows land on the canvas as the
  // model writes them, so this returns immediately rather than waiting for the reply.
  app.post('/api/simeon/chat', (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });

    say('user', text);
    try {
      startRun(text, { model: req.body?.model });
    } catch (e) {
      ctx.log(`[simeon] run failed to start: ${e.message}`);
      say('system', `Could not start the renderer: ${e.message}`);
      agentState('ready');
      return res.status(500).json({ error: e.message });
    }
    res.json({ ok: true });
  });

  // A button on the canvas was pressed. Same path as chat, marked so the human can see in
  // the transcript that the UI spoke rather than they did.
  app.post('/api/simeon/act', (req, res) => {
    const send = String(req.body?.send || '').trim();
    const label = String(req.body?.label || '').trim();
    if (!send) return res.status(400).json({ error: 'send required' });

    say('press', label || send);
    startRun(send, { model: req.body?.model });
    res.json({ ok: true });
  });

  // Stop a run in flight. The rows it already emitted stay: they are on screen, and a
  // half-drawn interface the human can see beats silently reverting one they watched arrive.
  app.post('/api/simeon/stop', (req, res) => {
    if (!current) return res.json({ ok: true, stopped: false });
    current.cancel();
    say('system', 'Stopped.');
    res.json({ ok: true, stopped: true });
  });

  app.get('/api/simeon/status', (req, res) => {
    res.json({ seq: feed.seq, running: !!current, rows: canvasRows().length });
  });

  // Wipe the canvas from the UI side. The agent's `c` row does the same thing; this is
  // the human's copy of that button.
  app.post('/api/simeon/reset', (req, res) => {
    feed.events = feed.events.filter(e => e.kind !== 'row');
    emit({ kind: 'row', row: 'c' });
    res.json({ ok: true, seq: feed.seq });
  });
}

module.exports = { init, registerRoutes };
