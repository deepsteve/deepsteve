// The timecard card (#666).
//
// Vanilla — no React, no Babel, no import map. The render is small and fully
// deterministic, and skipping the CDN is what makes the app paint instantly.
//
// Every dataset for every view arrives in ONE response, so switching Day / Week / Month
// is a re-render off data already in memory and never a network round trip.

// The tokens the card paints with. Mod iframes get no theme variables at all, so these
// are mirrored from the host document — that is what makes the card follow a light
// theme instead of sitting on index.html's dark fallbacks. Keep this list in step with
// the var() names in index.html; test/unit/timecard-mod-shape.test.js checks that it is.
const THEME_TOKENS = [
  '--ds-bg-primary',
  '--ds-text-primary',
  '--ds-text-secondary',
  '--ds-border',
];

const VIEWS = ['day', 'week', 'month'];
const REFRESH_MS = 60 * 1000;

const el = {
  total: document.getElementById('tc-total'),
  range: document.getElementById('tc-range'),
  views: document.getElementById('tc-views'),
  chart: document.getElementById('tc-chart'),
  tip: document.getElementById('tc-tip'),
  axis: document.getElementById('tc-axis'),
  stats: document.getElementById('tc-stats'),
  error: document.getElementById('tc-error'),
};

let data = null;
// Week is the default view.
let view = 'week';
// The bar the hover readout is currently describing, so a mousemove within one bar is
// free and a re-render under a stationary pointer still re-anchors.
let tipBar = null;

/**
 * Copy the host's computed --ds-* values onto our own :root.
 *
 * The iframe is same-origin (mod-manager.js's MOD_SANDBOX carries allow-same-origin) and
 * several other mods already reach parent.document. If it ever throws, index.html's
 * var() fallbacks still render a legible dark card.
 */
function syncTheme() {
  try {
    const cs = parent.getComputedStyle(parent.document.documentElement);
    for (const name of THEME_TOKENS) {
      const value = cs.getPropertyValue(name).trim();
      if (value) document.documentElement.style.setProperty(name, value);
    }
  } catch { /* no reachable parent — the fallbacks carry the page */ }
}

/**
 * Re-mirror when the theme changes. app.js's applyTheme() swaps the text of a
 * <style id="ds-theme"> in the host's head, so characterData + childList over that
 * subtree is what a theme change looks like from in here.
 */
function watchTheme() {
  try {
    new MutationObserver(syncTheme).observe(parent.document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } catch { /* best-effort */ }
}

async function load() {
  // Mod routes register after core's, so this path 404s with an HTML body for a moment
  // after boot — check ok before parsing. client-log.js beacons every >=400 response
  // into the daemon log, so a page that parsed blindly would also be noisy about it.
  const res = await fetch('/api/timecard', { cache: 'no-store' });
  if (!res.ok) throw new Error(`timecard unavailable (${res.status})`);
  return res.json();
}

/** Hours to one decimal, counts as integers. */
function formatStat(stat) {
  return stat.kind === 'count' ? String(Math.round(stat.value)) : Number(stat.value).toFixed(1);
}

/**
 * Park the readout over the hovered bar.
 *
 * It sits just above the bar's top edge, and drops just inside the bar when a tall one
 * leaves no room above it — the chart box is 120px and nothing may grow it, or the axis
 * and the stat row below would shift every time the pointer crossed the chart.
 */
function showTip(bar) {
  el.tip.textContent = bar.dataset.tip || '';
  el.tip.hidden = false; // measured below, so it has to be laid out first

  const chartBox = el.chart.getBoundingClientRect();
  const barBox = bar.getBoundingClientRect();
  const tipBox = el.tip.getBoundingClientRect();

  const barTop = barBox.top - chartBox.top;
  let top = barTop - 8 - tipBox.height;
  if (top < 0) top = Math.min(barTop + 8, chartBox.height - tipBox.height);

  const centered = (barBox.left - chartBox.left) + (barBox.width - tipBox.width) / 2;
  const left = Math.max(0, Math.min(centered, chartBox.width - tipBox.width));

  el.tip.style.top = `${top}px`;
  el.tip.style.left = `${left}px`;
}

function hideTip() {
  el.tip.hidden = true;
  tipBar = null;
}

function renderChart(dataset) {
  // The readout lives inside the chart so it can be positioned against it; it is
  // absolutely positioned, so it takes no part in the flex row and must survive the
  // wipe that replaces the bars.
  hideTip();
  el.chart.replaceChildren(el.tip);
  el.axis.replaceChildren();
  dataset.values.forEach((value, i) => {
    const bar = document.createElement('div');
    const zero = !(value > 0);
    bar.className = zero ? 'tc-bar zero' : 'tc-bar';
    // Heights scale to the dataset's max, which is a per-view constant rather than the
    // data max, so bars mean the same thing from one week to the next.
    if (!zero) bar.style.height = `${Math.min(100, (value / dataset.max) * 100)}%`;
    // Not `title`: the native tooltip appears below and to the right of the cursor after
    // a delay, which is neither over the bar nor immediate.
    bar.dataset.tip = `${dataset.labels[i]} · ${value.toFixed(1)}h`;
    el.chart.appendChild(bar);

    const label = document.createElement('span');
    label.textContent = dataset.labels[i];
    el.axis.appendChild(label);
  });
}

function renderStats(dataset) {
  el.stats.replaceChildren();
  // Both the values AND the labels come from the dataset: "Longest day" over a per-block
  // number is the failure this row is most likely to have.
  for (const stat of dataset.stats) {
    const wrap = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'tc-stat-label';
    label.textContent = stat.label;
    const value = document.createElement('div');
    value.className = 'tc-stat-value';
    value.textContent = formatStat(stat);
    wrap.append(label, value);
    el.stats.appendChild(wrap);
  }
}

function render() {
  if (!data) return;
  const dataset = data.views[view];
  if (!dataset) return;

  el.total.textContent = Number(dataset.total).toFixed(1);

  // Two honest suffixes, both of which disappear on their own: the seed says so for as
  // long as the store is empty, and a paused sampler says so rather than letting a
  // frozen chart look like a quiet week.
  const notes = [];
  if (data.seeded) notes.push('example data');
  if (data.enabled === false) notes.push('sampling off');
  el.range.textContent = notes.length ? `${dataset.range} · ${notes.join(' · ')}` : dataset.range;

  for (const button of el.views.querySelectorAll('button')) {
    button.classList.toggle('active', button.dataset.view === view);
  }

  renderChart(dataset);
  renderStats(dataset);
}

async function refresh() {
  try {
    data = await load();
    el.error.hidden = true;
    render();
  } catch (e) {
    // Only shout when there is nothing on screen yet; a failed refresh over a card that
    // is already painted should leave the numbers alone.
    if (!data) {
      el.error.textContent = e.message;
      el.error.hidden = false;
    }
  }
}

// mousemove rather than mouseover, so the readout re-anchors after the 60s refresh
// swaps the bars out from under a pointer that never moved.
el.chart.addEventListener('mousemove', (e) => {
  const bar = e.target.closest('.tc-bar');
  if (!bar) { hideTip(); return; }
  if (bar === tipBar) return;
  tipBar = bar;
  showTip(bar);
});
el.chart.addEventListener('mouseleave', hideTip);

el.views.addEventListener('click', (e) => {
  const button = e.target.closest('button[data-view]');
  if (!button || !VIEWS.includes(button.dataset.view)) return;
  view = button.dataset.view;
  render(); // no fetch — every view is already here
});

syncTheme();
watchTheme();
refresh();
setInterval(refresh, REFRESH_MS);
