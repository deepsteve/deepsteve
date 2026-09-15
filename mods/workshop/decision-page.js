/**
 * The decision page (#705): what `/v1/decision/<id>` shows.
 *
 * Opened from an email in an ordinary browser tab: not a mod iframe, no window.deepsteve
 * bridge, and nothing here needs one. The server (the Workshop link provider in tools.js)
 * renders a shell carrying the item as JSON; this module draws it and POSTs the human's click
 * back to the same versioned address, which runs behind the auth cookie and a mandatory
 * Origin check. Opening the page never changes anything — only a button does.
 *
 * Agent-written text — the question, its context, the options — reaches the DOM only as
 * textContent or as elements built from markdown.js's AST, never as markup. The same rule as
 * workshop.jsx, pinned by the same test (workshop-mod-shape.test.js).
 */

import { tokenize } from './markdown.js';

const root = document.getElementById('decision');
const initial = JSON.parse(document.getElementById('decision-data').textContent);
const postUrl = initial.postUrl;

// The fields the page reads. A POST answers with the Workshop panel's serialized item, which
// carries more; picking keeps the two shapes from drifting into each other.
const FIELDS = [
  'id', 'seq', 'kind', 'status', 'headline', 'context', 'recommendation', 'options', 'urgency',
  'answer', 'answeredAt', 'dismissedReason', 'deliveredVia', 'sessionName', 'projectName',
  'sessionAlive', 'durableUntil', 'createdAt', 'followUpSessionId', 'supersededBy',
];

let item = pick(initial);
let busy = false;
let flash = null;   // { tone: 'ok' | 'warn' | 'error', text }
let draft = '';

// A page that loaded ends the sign-in bounce security.js may have started for this path, so
// the next click on the same link reloads again instead of reporting "not signed in".
try { sessionStorage.removeItem('ds-link-reauth:' + location.pathname); } catch { /* storage off */ }

const DELIVERED = {
  inline: 'The agent was waiting for this and has it now.',
  prompt: 'Delivered to the asking session as a new message.',
  then: 'The asking session had closed, so its follow-up started in a new session.',
  undelivered: 'Recorded. The asking session had closed, so nothing was typed anywhere; a later run can read this answer.',
};

const CLOSED = {
  'session-gone': 'This was archived without an answer: the session that asked it closed before anyone replied.',
  expired: 'This question expired without an answer.',
  archived: 'This was archived in Workshop without an answer.',
  superseded: 'Something replaced this question before anyone answered it, so it can no longer be answered here.',
};

// #710. The server computes `supersededBy` on every render, since only it can see the facts
// behind it: whether you replied in the asking session, and how a scheduled task's later
// runs ended.
function supersededText(sup) {
  return sup.rule === 'later-run'
    ? `Replaced by the scheduled task's run that finished ${when(sup.at)}. It can no longer be answered here.`
    : `You replied in the session that asked this on ${when(sup.at)}, so this copy was out of date. It can no longer be answered here.`;
}

function pick(source) {
  const out = {};
  for (const k of FIELDS) out[k] = source && source[k] !== undefined ? source[k] : null;
  out.options = Array.isArray(out.options) ? out.options : [];
  return out;
}

function isExpired(it) {
  return it.status === 'open' && !!it.durableUntil && Date.now() >= it.durableUntil;
}

function when(ms) {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
}

/** createElement with text-only children. Strings become text nodes; nothing is ever parsed. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'onclick') node.addEventListener('click', value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

// ── markdown AST → elements ─────────────────────────────────────────────────

function spans(list) {
  return (list || []).map((s) => {
    if (s.type === 'code') return el('code', { text: s.text });
    if (s.type === 'link') {
      return el('a', { href: s.href, target: '_blank', rel: 'noopener noreferrer' }, spans(s.children));
    }
    if (s.type === 'image') {
      // The page's CSP loads no remote images — a decision must not double as a tracking
      // pixel — so a remote one is shown as the link it is rather than as a broken box.
      return /^(?:data:|\/)/.test(s.src)
        ? el('img', { src: s.src, alt: s.alt || '' })
        : el('a', { href: s.src, target: '_blank', rel: 'noopener noreferrer' }, s.alt || s.src);
    }
    if (s.type === 'strong') return el('strong', {}, spans(s.children));
    if (s.type === 'em') return el('em', {}, spans(s.children));
    return document.createTextNode(s.text || '');
  });
}

function markdown(text) {
  const box = el('div', { className: 'md' });
  for (const b of tokenize(text)) {
    if (b.type === 'code') box.append(el('pre', {}, el('code', { text: b.text })));
    else if (b.type === 'heading') box.append(el('p', { className: `heading h${b.level}` }, spans(b.spans)));
    else if (b.type === 'hr') box.append(el('hr'));
    else if (b.type === 'quote') box.append(el('blockquote', {}, spans(b.spans)));
    else if (b.type === 'list') {
      box.append(el(b.ordered ? 'ol' : 'ul', {}, b.items.map((entry) => el('li', {}, spans(entry)))));
    } else box.append(el('p', {}, spans(b.spans)));
  }
  return box;
}

// ── talking to Deep Steve ───────────────────────────────────────────────────

async function post(payload) {
  try {
    const r = await fetch(postUrl, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let json = null;
    try { json = await r.json(); } catch { /* a non-JSON refusal */ }
    return { ok: r.ok, status: r.status, json };
  } catch {
    return { ok: false, status: 0, json: null };
  }
}

function failure(r) {
  if (r.status === 0) return "Couldn't reach Deep Steve. Is it running?";
  if (r.status === 401 || r.status === 429) return "Deep Steve didn't accept this browser. Reload the page and try again.";
  if (r.status === 403) return 'Deep Steve refused a request from this page. Reload it and try again.';
  const why = r.json && (r.json.message || r.json.hint || r.json.error);
  return why ? `Couldn't do that: ${why}` : `Couldn't do that (HTTP ${r.status}).`;
}

async function answer(payload) {
  if (busy) return;
  busy = true;
  flash = null;
  render();
  const r = await post({ action: 'answer', ...payload });
  busy = false;
  if (r.json && r.json.item) item = { ...pick(r.json.item), sessionAlive: r.json.item.sessionAlive };
  if (r.ok) {
    flash = r.json && r.json.note ? { tone: 'ok', text: r.json.note } : null;
  } else if (r.status === 409 && r.json && r.json.error === 'not-open') {
    flash = { tone: 'warn', text: 'This was already answered. Here is what was recorded.' };
  } else if (r.status === 409 && r.json && r.json.error === 'expired') {
    flash = { tone: 'warn', text: 'This question expired before your answer arrived.' };
  } else if (r.status === 409 && r.json && r.json.error === 'superseded') {
    flash = { tone: 'warn', text: 'Something replaced this question before your answer arrived. Nothing was sent.' };
  } else {
    flash = { tone: 'error', text: failure(r) };
  }
  render();
}

async function discuss() {
  if (busy) return;
  busy = true;
  flash = null;
  render();
  const r = await post({ action: 'discuss' });
  busy = false;
  if (r.ok && r.json) {
    const name = r.json.name || 'the session';
    const said = {
      focused: `Brought ${name} to the front of your Deep Steve window.`,
      restored: `Reopening ${name} in Deep Steve.`,
      fresh: `Started a new session, ${name}, to talk this through.`,
    }[r.json.opened] || 'Opened in Deep Steve.';
    flash = {
      tone: 'ok',
      text: r.json.tabDelivery === 'queued' ? `${said} It will appear when a Deep Steve window connects.` : said,
    };
  } else {
    flash = { tone: 'error', text: failure(r) };
  }
  render();
}

// ── drawing ─────────────────────────────────────────────────────────────────

function answerSection() {
  const note = el('textarea', {
    rows: 3,
    'aria-label': item.options.length ? 'Optional note' : 'Your reply',
    placeholder: item.options.length ? 'Optional note — type it before you choose' : 'Your reply',
    disabled: busy,
  });
  note.value = draft;
  note.addEventListener('input', () => { draft = note.value; });

  const parts = [];
  if (item.options.length) {
    parts.push(el('div', { className: 'options' }, item.options.map((opt, i) => el('button', {
      type: 'button', className: 'option', disabled: busy,
      onclick: () => answer({ optionIndex: i, text: draft }),
    }, [
      el('span', { className: 'option-label', text: opt.label }),
      opt.detail ? el('span', { className: 'option-detail', text: opt.detail }) : null,
      opt.then ? el('span', { className: 'option-then', text: `If the asking session has closed: ${opt.then}` }) : null,
    ]))));
    parts.push(note);
  } else {
    parts.push(note);
    parts.push(el('button', {
      type: 'button', className: 'primary', disabled: busy,
      onclick: () => answer({ text: draft }),
    }, 'Send reply'));
  }
  if (!item.sessionAlive) {
    const anyThen = item.options.some((o) => o.then);
    parts.push(el('p', {
      className: 'hint',
      text: 'The session that asked this has closed. '
        + (anyThen
          ? 'An option with a follow-up starts a new session; any other answer is kept for the next run.'
          : 'Your answer is kept for the next run.'),
    }));
  }
  return el('section', { className: 'answer' }, parts);
}

function outcomeSection() {
  if (item.status === 'answered' && item.answer) {
    return el('section', { className: 'outcome' }, [
      el('p', { className: 'label', text: `Answered ${when(item.answeredAt)}`.trim() }),
      item.answer.optionLabel ? el('p', { className: 'answer-label', text: item.answer.optionLabel }) : null,
      item.answer.text ? el('p', { className: 'answer-text', text: item.answer.text }) : null,
      DELIVERED[item.deliveredVia] ? el('p', { className: 'hint', text: DELIVERED[item.deliveredVia] }) : null,
    ]);
  }
  if (item.supersededBy) {
    return el('section', { className: 'outcome' }, [el('p', { text: supersededText(item.supersededBy) })]);
  }
  if (isExpired(item)) {
    return el('section', { className: 'outcome' }, [
      el('p', { text: `This question expired ${when(item.durableUntil)} without an answer.` }),
    ]);
  }
  return el('section', { className: 'outcome' }, [
    el('p', { text: CLOSED[item.dismissedReason] || 'This was closed without an answer.' }),
  ]);
}

function render() {
  const open = item.status === 'open' && !isExpired(item) && !item.supersededBy;
  const eyebrow = ['Decision', item.projectName, item.sessionName].filter(Boolean).join(' · ');
  const children = [
    el('p', { className: 'eyebrow' }, [
      eyebrow,
      item.urgency === 'blocking' && open ? el('span', { className: 'chip', text: 'blocking' }) : null,
    ]),
    el('h1', { text: item.headline || '(no question)' }),
  ];
  if (item.context) children.push(markdown(item.context));
  if (item.recommendation) {
    children.push(el('div', { className: 'recommend' }, [
      el('p', { className: 'label', text: 'Recommends' }),
      el('p', { text: item.recommendation }),
    ]));
  }
  children.push(open ? answerSection() : outcomeSection());
  if (flash) children.push(el('p', { className: `flash ${flash.tone}`, role: 'status', text: flash.text }));
  children.push(el('div', { className: 'discuss' }, [
    el('button', { type: 'button', className: 'secondary', disabled: busy, onclick: discuss }, 'Discuss'),
    el('span', {
      className: 'hint',
      text: item.sessionAlive
        ? 'Opens the asking session in Deep Steve.'
        : 'Reopens the asking session in Deep Steve, or starts a new one about this question.',
    }),
  ]));
  root.replaceChildren(el('article', { className: 'card', 'aria-busy': busy ? 'true' : null }, children));
}

render();
