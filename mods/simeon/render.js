/**
 * Simeon's renderer and its component library.
 *
 * Every component is two functions — `build` makes the element once, `paint` writes props
 * into it and is idempotent. That split is what lets a patch row (`n cpu tone=alert`) touch
 * one node without rebuilding anything around it, and it is why a `d` row that fires a
 * hundred bound nodes costs a hundred `paint` calls and zero allocations.
 *
 * `build` may return a `slot`: the element children mount into. A card's children go inside
 * its body, not next to its header, and the store never has to know that.
 *
 * An unknown component type renders as a visible placeholder rather than nothing. The agent
 * on the other end is improvising a language; a component it invented must FAIL ON SCREEN,
 * or it will keep inventing it.
 */

const SCALE = { none: '0', xs: '4px', sm: '8px', md: '14px', lg: '22px', xl: '34px' };
const size = (v, dflt) => SCALE[v] || (typeof v === 'number' ? `${v}px` : SCALE[dflt]);

function h(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

const str = (v) => (v == null ? '' : String(v));

// One heart, drawn once and reused for the fill and its glow.
const HEART_D = 'M16 27.5 C16 27.5 2.5 19.4 2.5 10.8 C2.5 6.2 6.2 2.5 10.8 2.5 C13.4 2.5 15.2 3.9 16 5.1 C16.8 3.9 18.6 2.5 21.2 2.5 C25.8 2.5 29.5 6.2 29.5 10.8 C29.5 19.4 16 27.5 16 27.5 Z';


function setTone(el, props) {
  el.dataset.tone = str(props.tone) || 'default';
}

/** Containers differ only in their layout class and which style props they read. */
function stack(kind) {
  return {
    build: () => {
      const el = h('div', `sim-stack sim-${kind}`);
      return { el, slot: el };
    },
    paint(el, p) {
      el.style.gap = size(p.gap, 'md');
      el.style.padding = p.pad ? size(p.pad, 'md') : '';
      el.style.alignItems = str(p.align) || (kind === 'row' ? 'stretch' : '');
      el.style.justifyContent = str(p.justify) || '';
      if (kind === 'row') el.style.flexWrap = p.wrap === false ? 'nowrap' : 'wrap';
      if (kind === 'grid') el.style.gridTemplateColumns = `repeat(${Number(p.cols) || 2}, minmax(0, 1fr))`;
      if (p.grow != null) el.style.flex = p.grow ? '1 1 0' : '';
      setTone(el, p);
    },
  };
}

function numbers(v) {
  if (Array.isArray(v)) return v.map(Number).filter(n => Number.isFinite(n));
  if (typeof v === 'string') return v.split(/[,\s]+/).map(Number).filter(n => Number.isFinite(n));
  return [];
}

export const COMPONENTS = {
  screen: {
    build: () => {
      const el = h('section', 'sim-screen');
      const hd = h('header', 'sim-screen-hd');
      hd.appendChild(h('span', 'sim-screen-mark'));
      hd.appendChild(h('h1', 'sim-screen-title'));
      hd.appendChild(h('span', 'sim-screen-sub'));
      const slot = h('div', 'sim-stack sim-col sim-screen-body');
      el.append(hd, slot);
      return { el, slot };
    },
    paint(el, p) {
      el.querySelector('.sim-screen-title').textContent = str(p.title) || 'Untitled';
      const sub = el.querySelector('.sim-screen-sub');
      sub.textContent = str(p.sub);
      sub.hidden = !p.sub;
      el.querySelector('.sim-screen-body').style.gap = size(p.gap, 'lg');
      setTone(el, p);
    },
  },

  col: stack('col'),
  row: stack('row'),
  grid: stack('grid'),

  card: {
    build: () => {
      const el = h('div', 'sim-card');
      const hd = h('div', 'sim-card-hd');
      hd.append(h('span', 'sim-card-title'), h('span', 'sim-card-note'));
      const slot = h('div', 'sim-stack sim-col sim-card-body');
      el.append(hd, slot);
      return { el, slot };
    },
    paint(el, p) {
      const hd = el.querySelector('.sim-card-hd');
      hd.querySelector('.sim-card-title').textContent = str(p.title);
      const note = hd.querySelector('.sim-card-note');
      note.textContent = str(p.note);
      note.hidden = !p.note;
      hd.hidden = !p.title && !p.note;
      el.querySelector('.sim-card-body').style.gap = size(p.gap, 'md');
      setTone(el, p);
    },
  },

  title: {
    build: () => ({ el: h('div', 'sim-title') }),
    paint(el, p) {
      el.textContent = str(p.value ?? p.label);
      el.dataset.size = str(p.size) || 'md';
      setTone(el, p);
    },
  },

  text: {
    build: () => ({ el: h('p', 'sim-text') }),
    paint(el, p) {
      el.textContent = str(p.value ?? p.label);
      el.dataset.mono = p.mono ? 'on' : 'off';
      setTone(el, p);
    },
  },

  stat: {
    build: () => {
      const el = h('div', 'sim-stat');
      const line = h('div', 'sim-stat-line');
      line.append(h('span', 'sim-stat-value'), h('span', 'sim-stat-unit'), h('span', 'sim-stat-trend'));
      el.append(h('div', 'sim-stat-label'), line);
      return { el };
    },
    paint(el, p) {
      el.querySelector('.sim-stat-label').textContent = str(p.label);
      el.querySelector('.sim-stat-value').textContent = p.value == null ? '—' : str(p.value);
      const unit = el.querySelector('.sim-stat-unit');
      unit.textContent = str(p.unit);
      unit.hidden = !p.unit;
      const trend = el.querySelector('.sim-stat-trend');
      trend.textContent = str(p.trend);
      trend.hidden = !p.trend;
      setTone(el, p);
    },
  },

  bar: {
    build: () => {
      const el = h('div', 'sim-bar');
      const hd = h('div', 'sim-bar-hd');
      hd.append(h('span', 'sim-bar-label'), h('span', 'sim-bar-value'));
      const track = h('div', 'sim-bar-track');
      track.appendChild(h('div', 'sim-bar-fill'));
      el.append(hd, track);
      return { el };
    },
    paint(el, p) {
      const max = Number(p.max) || 100;
      const value = Number(p.value) || 0;
      const pct = Math.max(0, Math.min(100, (value / max) * 100));
      el.querySelector('.sim-bar-label').textContent = str(p.label);
      el.querySelector('.sim-bar-value').textContent = `${str(p.value ?? 0)}${str(p.unit)}`;
      el.querySelector('.sim-bar-fill').style.width = `${pct}%`;
      setTone(el, p);
    },
  },

  spark: {
    build: () => {
      const el = h('div', 'sim-spark');
      el.innerHTML = '<svg viewBox="0 0 100 32" preserveAspectRatio="none">'
        + '<path class="sim-spark-area"/><polyline class="sim-spark-line"/></svg>';
      return { el };
    },
    paint(el, p) {
      const s = numbers(p.series ?? p.value);
      const line = el.querySelector('.sim-spark-line');
      const area = el.querySelector('.sim-spark-area');
      if (s.length < 2) { line.setAttribute('points', ''); area.setAttribute('d', ''); setTone(el, p); return; }
      const lo = Math.min(...s), hi = Math.max(...s), span = hi - lo || 1;
      const pts = s.map((v, i) => [(i / (s.length - 1)) * 100, 30 - ((v - lo) / span) * 28]);
      line.setAttribute('points', pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '));
      area.setAttribute('d', `M0,32 L${pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' L')} L100,32 Z`);
      setTone(el, p);
    },
  },

  /**
   * Written by the Simeon agent itself, in the first session, when it was asked for "a
   * beating svg heart" and still had a shell to edit this file with (notes/first-session.md,
   * turn 7). Kept on merit: it honours the build/paint contract, clamps its own period, and
   * carries its LANGUAGE entry. It is the only part of this mod its own agent authored.
   *
   * A heart that beats at the rate it is displaying. The period is derived from `bpm`, so
   * the animation IS the datum — a resting 47 and a strained 58 read as different rhythms
   * without anyone having to compare two numbers.
   */
  heart: {
    build: () => {
      const el = h('div', 'sim-heart');
      el.innerHTML = '<svg class="sim-heart-svg" viewBox="0 0 32 30" aria-hidden="true">'
        + `<path class="sim-heart-glow" d="${HEART_D}"/>`
        + `<path class="sim-heart-path" d="${HEART_D}"/></svg>`;
      el.appendChild(h('span', 'sim-heart-bpm'));
      return { el };
    },
    paint(el, p) {
      const bpm = Number(p.bpm ?? p.value);
      // Clamp the period. A zero, a NaN or an absurd rate must not freeze the heart or
      // strobe it; both ends of that range are reachable from one bad `d` row.
      const beating = Number.isFinite(bpm) && bpm > 0 && p.beat !== false;
      const period = beating ? Math.min(3, Math.max(0.3, 60 / bpm)) : 0;
      el.style.setProperty('--sim-beat', period ? `${period.toFixed(3)}s` : '0s');
      el.dataset.beating = beating ? 'yes' : 'no';
      const label = el.querySelector('.sim-heart-bpm');
      label.textContent = Number.isFinite(bpm) && bpm > 0 ? `${bpm} ${str(p.unit) || 'bpm'}` : '';
      label.hidden = !label.textContent;
      setTone(el, p);
    },
  },

  list: {
    build: () => ({ el: h('ul', 'sim-list') }),
    paint(el, p) {
      const items = Array.isArray(p.items) ? p.items : (p.items == null ? [] : [p.items]);
      el.textContent = '';
      for (const raw of items) {
        const item = raw && typeof raw === 'object' ? raw : { label: raw };
        const li = h('li', 'sim-list-item');
        li.dataset.tone = str(item.tone) || str(p.tone) || 'default';
        li.append(h('span', 'sim-list-label', str(item.label ?? item.text ?? '')));
        if (item.value != null) li.append(h('span', 'sim-list-value', str(item.value)));
        el.appendChild(li);
      }
      el.dataset.empty = items.length ? 'no' : 'yes';
      setTone(el, p);
    },
  },

  badge: {
    build: () => ({ el: h('span', 'sim-badge') }),
    paint(el, p) {
      el.textContent = str(p.label ?? p.value);
      setTone(el, p);
    },
  },

  button: {
    build: (api) => {
      const el = h('button', 'sim-btn');
      el.type = 'button';
      el.addEventListener('click', () => {
        el.classList.add('sim-btn-hit');
        setTimeout(() => el.classList.remove('sim-btn-hit'), 400);
        api.act(el.dataset.send || '', el.textContent);
      });
      return { el };
    },
    paint(el, p) {
      el.textContent = str(p.label ?? p.value) || 'Run';
      el.dataset.send = str(p.send ?? p.label);
      el.disabled = p.disabled === true;
      setTone(el, p);
    },
  },
};

/** The visible failure for a component the agent invented. */
const UNKNOWN = {
  build: () => ({ el: h('div', 'sim-unknown') }),
  paint(el, p, api) {
    el.textContent = `?  ${api.node.type}`;
    el.title = `Simeon has no component called "${api.node.type}". Props: ${JSON.stringify(p)}`;
  },
};

/**
 * Wire a store's tree to a host element.
 *
 * Returns `{ handlers, setStore }`. The handlers go to createStore; setStore closes the loop,
 * because the renderer must resolve props through the store it is driven by.
 */
export function createRenderer(host, { onAct } = {}) {
  let store = null;
  const els = new Map();   // nodeId -> { el, slot, comp }

  const api = (node) => ({ node, act: (send, label) => onAct?.(send, label) });

  function slotFor(id) {
    if (!id || id === '#root') return host;
    return els.get(id)?.slot || host;
  }

  function build(node) {
    const comp = COMPONENTS[node.type] || UNKNOWN;
    const made = comp.build(api(node));
    const el = made.el;
    el.classList.add('sim-node');
    el.dataset.simId = node.id;
    el.dataset.simType = node.type;
    return { el, slot: made.slot || el, comp };
  }

  function paint(entry, node, info = {}) {
    entry.comp.paint(entry.el, store.resolve(node), api(node));
    if (info.fromData) {
      entry.el.classList.remove('sim-flash');
      void entry.el.offsetWidth;   // restart the animation on a repeated write
      entry.el.classList.add('sim-flash');
    }
  }

  const handlers = {
    onMount(node) {
      const entry = build(node);
      els.set(node.id, entry);
      paint(entry, node);
      slotFor(node.parent).appendChild(entry.el);
      // The arrival animation. One row, one entrance — which is the whole reason the
      // language is line-oriented.
      entry.el.classList.add('sim-enter');
      entry.el.addEventListener('animationend', function done(e) {
        if (e.target !== entry.el) return;
        entry.el.classList.remove('sim-enter');
        entry.el.removeEventListener('animationend', done);
      });
    },

    onUpdate(node, info) {
      const entry = els.get(node.id);
      if (!entry) return;
      if (info?.retyped) {
        // The type changed under a live id. Rebuild the element and re-home the children
        // rather than dropping the subtree: the agent said "make this a bar instead", not
        // "delete this".
        const next = build(node);
        for (const child of [...entry.slot.childNodes]) next.slot.appendChild(child);
        entry.el.replaceWith(next.el);
        els.set(node.id, next);
        paint(next, node);
        return;
      }
      paint(entry, node, info);
    },

    onReparent(node) {
      const entry = els.get(node.id);
      if (entry) slotFor(node.parent).appendChild(entry.el);
    },

    onRemove(node) {
      const entry = els.get(node.id);
      if (!entry) return;
      els.delete(node.id);
      entry.el.classList.add('sim-exit');
      setTimeout(() => entry.el.remove(), 260);
    },

    onClear() {
      els.clear();
      host.textContent = '';
    },
  };

  return {
    handlers,
    setStore(s) { store = s; },
    elementFor: (id) => els.get(id)?.el || null,
    get size() { return els.size; },
  };
}
