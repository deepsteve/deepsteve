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
  axis: document.getElementById('tc-axis'),
  stats: document.getElementById('tc-stats'),
  error: document.getElementById('tc-error'),
};

let data = null;
// Week is the default view.
let view = 'week';

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

function renderChart(dataset) {
  el.chart.replaceChildren();
  el.axis.replaceChildren();
  dataset.values.forEach((value, i) => {
    const bar = document.createElement('div');
    const zero = !(value > 0);
    bar.className = zero ? 'tc-bar zero' : 'tc-bar';
    // Heights scale to the dataset's max, which is a per-view constant rather than the
    // data max, so bars mean the same thing from one week to the next.
    if (!zero) bar.style.height = `${Math.min(100, (value / dataset.max) * 100)}%`;
    bar.title = `${dataset.labels[i]} · ${value.toFixed(1)}h`;
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
