// The DOM overlay: the door card, the hint, the empty-town notice, the veil.
//
// Everything in here sits at a FIXED screen position. That is not laziness — a DOM
// element anchored by projecting a world point would land in the wrong place,
// because the curvature shader moves vertices on the GPU and a CPU-side projection
// knows nothing about it (curvature.js, trap 3). Anything that has to sit ON
// something in the world — a name board, the POST plate, a pinned notice — is a
// mesh instead, and gets curved along with everything else for free.
//
// The card only ever appears when you are already standing at the door, so having
// it in a fixed place costs nothing.

/** Project icon, following the same fallback chain as the projects rail. */
function paintIcon(el, ctx) {
  el.textContent = '';
  el.classList.remove('mono');

  if (ctx && ctx.iconImage) {
    const img = document.createElement('img');
    // Through an <img>, never inlined — server.js:5382 is explicit about this, and
    // a mod page is same-origin so the rule is ours to keep too.
    img.src = `/api/contexts/${encodeURIComponent(ctx.id)}/icon`;
    img.alt = '';
    img.onerror = () => { el.textContent = monogram(ctx.name); el.classList.add('mono'); };
    el.appendChild(img);
    return;
  }
  if (ctx && ctx.icon) {
    el.textContent = ctx.icon;
    return;
  }
  el.textContent = monogram(ctx && ctx.name);
  el.classList.add('mono');
}

function monogram(name) {
  const s = String(name || '?').trim();
  if (!s) return '?';
  const parts = s.split(/[\s\-_./]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return s.slice(0, 2).toUpperCase();
}

export class Hud {
  constructor({ onPickSession, onNewSession, onOpenAsTab }) {
    this.onPickSession = onPickSession;
    this.onNewSession = onNewSession;
    this.onOpenAsTab = onOpenAsTab;

    this.card = document.getElementById('door-card');
    this.cardIcon = this.card.querySelector('.card-icon');
    this.cardName = this.card.querySelector('.card-name');
    this.cardList = this.card.querySelector('.card-list');
    this.title = document.getElementById('title');
    this.subtitle = this.title.querySelector('.sub');
    this.hint = document.getElementById('hint');
    this.empty = document.getElementById('empty-town');
    this.veil = document.getElementById('veil');
    this.working = document.getElementById('working');
    this.workingWho = this.working.querySelector('.who');

    this.working.querySelector('#working-open').addEventListener('click', (e) => {
      // The one deliberate way out of the village. Everything else about working
      // at a board keeps you in it; this is the "actually, give me the real tab"
      // door, and it is a button rather than a key so it cannot be typed by
      // accident into the session you are talking to.
      e.stopPropagation();
      this.onOpenAsTab?.();
    });

    this.openCtxId = null;
    this._hintTimer = null;
  }

  /** The veil is the click target that takes pointer lock and starts the audio. */
  onVeilClick(fn) {
    this.veil.addEventListener('click', fn);
  }

  setVeil(visible) {
    this.veil.classList.toggle('hidden', !visible);
  }

  setSubtitle(text) {
    this.subtitle.textContent = text;
  }

  setEmpty(isEmpty) {
    this.empty.classList.toggle('open', !!isEmpty);
  }

  /** Name of the session the keyboard is talking to, or null when walking. */
  setWorking(name) {
    this.working.classList.toggle('open', !!name);
    this.workingWho.textContent = name || '';
    // Only ever fades it. Un-fading would undo armHintFade and put the controls
    // hint back on screen every time you stepped away from a board.
    if (name) this.hint.classList.add('faded');
  }

  /** Fade the controls hint out once the player has clearly got the idea. */
  armHintFade() {
    if (this._hintTimer) return;
    this._hintTimer = setTimeout(() => this.hint.classList.add('faded'), 9000);
  }

  get isDoorOpen() {
    return this.openCtxId !== null;
  }

  /**
   * Raise the card for a house.
   *
   * `entry` is the town model's row for that project. Only sessions this window has
   * open get a clickable row: focusSession() resolves to focusTab() in the host
   * (public/js/app.js:4474), which can only reach a tab that exists here. Sessions
   * running elsewhere are reported as a count, because a row that did nothing when
   * clicked would be worse than no row.
   */
  showDoor(plot, entry) {
    const ctx = plot.ctx;
    if (this.openCtxId === ctx.id) return false;
    this.openCtxId = ctx.id;

    paintIcon(this.cardIcon, ctx);
    this.cardName.textContent = ctx.name || ctx.id;
    this.cardName.title = (ctx.dirs || []).join('\n');

    this.cardList.textContent = '';

    const local = entry ? entry.local : [];
    const elsewhere = entry ? entry.elsewhere : 0;

    if (plot.archived) {
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = 'THIS PROJECT IS ARCHIVED';
      this.cardList.appendChild(note);
    }

    for (const session of local) {
      this.cardList.appendChild(this._sessionRow(ctx, session));
    }

    if (!local.length) {
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = elsewhere
        ? `${elsewhere} SESSION${elsewhere > 1 ? 'S' : ''} RUNNING IN ANOTHER WINDOW`
        : 'NOBODY HOME';
      this.cardList.appendChild(note);
    } else if (elsewhere) {
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = `+${elsewhere} IN ANOTHER WINDOW`;
      this.cardList.appendChild(note);
    }

    if ((ctx.dirs || []).length) {
      const row = document.createElement('div');
      row.className = 'row new';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = '+ NEW SESSION HERE';
      row.appendChild(label);
      row.addEventListener('click', () => this.onNewSession(ctx));
      this.cardList.appendChild(row);
    }

    this.card.classList.add('open');
    return true;
  }

  _sessionRow(ctx, session) {
    const row = document.createElement('div');
    row.className = 'row';

    const dot = document.createElement('span');
    dot.className = `dot${session.waitingForInput ? ' waiting' : ''}`;
    row.appendChild(dot);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = session.name;
    label.title = session.cwd || '';
    row.appendChild(label);

    if (session.waitingForInput) {
      const bang = document.createElement('span');
      bang.className = 'bang';
      bang.textContent = '!';
      bang.title = 'Waiting for input';
      row.appendChild(bang);
    }

    row.addEventListener('click', () => this.onPickSession(ctx, session));
    return row;
  }

  hideDoor() {
    if (this.openCtxId === null) return false;
    this.openCtxId = null;
    this.card.classList.remove('open');
    this.cardList.textContent = '';
    return true;
  }

  /** Repaint an open card in place, so a session appearing shows up immediately. */
  refresh(plot, entry) {
    if (!plot || this.openCtxId !== plot.ctx.id) return;
    this.openCtxId = null;
    this.showDoor(plot, entry);
  }

  dispose() {
    if (this._hintTimer) clearTimeout(this._hintTimer);
  }
}
