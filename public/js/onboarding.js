/**
 * First-run onboarding (#695).
 *
 * The trigger is deliberately narrow: the ONE branch of landWithNoTabs() that was
 * already treating the directory picker as onboarding — no tabs, no server-side
 * recents, nothing to restore. That is the only moment where interrupting somebody
 * costs nothing, and it is why this module never has to fight the picker: it either
 * replaces it for one click or hands straight back to it.
 *
 * The "seen" bit is localStorage, not sessionStorage, per the split in
 * docs/frontend.md: sessionStorage is for a *place* (which project you are in, where
 * you wandered from), localStorage is for a *preference* that is true of the whole
 * browser. Having been shown around is a preference — a second window must not ask
 * again — and it has to outlive the window, because the daemon opens a brand-new
 * browser tab at login and that tab has no sessionStorage at all.
 *
 * Every storage access is wrapped: a private window throws on the first read, and the
 * right answer there is "not onboarded, show the card", never an exception that takes
 * the landing path down with it.
 */

import { nsKey } from './storage-namespace.js';
import { fetchJSON } from './api.js';

const SEEN_KEY = nsKey('deepsteve-onboarded');

/** Has this browser been offered the tour already? Any storage failure reads as no. */
export function hasOnboarded() {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Remember that we offered it. Called by BOTH card buttons — taking the tour and
 * skipping it are equally "you have been asked", and a skip that did not stick would
 * ask again on the next reload, which is the behaviour the flag exists to prevent.
 */
export function markOnboarded() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Private window. The card shows once per page load instead of once per browser,
    // which is the best available answer and strictly better than throwing.
  }
}

/** Test/support seam: forget the flag so the card comes back on the next bare load. */
export function resetOnboarded() {
  try {
    localStorage.removeItem(SEEN_KEY);
  } catch { /* nothing to forget */ }
}

/**
 * Ask the server to spawn the guide session.
 *
 * The prompt, the pre-permitted tools and the tour page's path all live server-side
 * (onboarding-prompt.js + startOnboardingSession) — the browser only says "now, in
 * this window". The tab arrives the same way an issue tab does, over the live-reload
 * channel as an `open-session` message, so there is nothing to render here.
 */
export function startTour({ windowId } = {}) {
  return fetchJSON('/api/start-onboarding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId: windowId || null }),
  });
}

/**
 * Show the welcome card over the empty state.
 *
 * It reuses #empty-state rather than opening a modal, for exactly the reason #597 took
 * the picker modal off this path: the empty state IS the landing surface, and stacking
 * something on top of it made cancelling put you where you already wanted to be. The
 * `.onboarding` class is the single switch — the card is display:none without it —
 * following the .context-empty precedent in styles.css.
 *
 * `onSkip` is landWithNoTabs's own picker, so skipping lands you exactly where a
 * bare first run landed before this existed.
 */
export function showWelcomeCard({ windowId, onSkip } = {}) {
  const empty = document.getElementById('empty-state');
  const card = document.getElementById('onboard-card');
  const startBtn = document.getElementById('onboard-start');
  const skipBtn = document.getElementById('onboard-skip');
  const errEl = document.getElementById('onboard-error');
  // No card in the DOM (an old cached index.html) must not swallow the first run:
  // fall through to the picker, which is what would have happened anyway.
  if (!empty || !card || !startBtn || !skipBtn) {
    onSkip?.();
    return;
  }

  empty.classList.add('onboarding');
  empty.classList.remove('hidden');
  if (errEl) errEl.textContent = '';
  startBtn.disabled = false;
  skipBtn.disabled = false;
  startBtn.textContent = 'Show me around';
  startBtn.focus();

  const dismiss = () => {
    empty.classList.remove('onboarding');
  };

  startBtn.onclick = async () => {
    startBtn.disabled = true;
    skipBtn.disabled = true;
    startBtn.textContent = 'Opening…';
    if (errEl) errEl.textContent = '';
    try {
      await startTour({ windowId });
      // Only after the server accepted it. A failed start is not an onboarding the
      // user has had, so the card is still owed to them on the next load.
      markOnboarded();
      dismiss();
    } catch (e) {
      if (errEl) errEl.textContent = e?.message || 'Could not start the tour.';
      startBtn.disabled = false;
      skipBtn.disabled = false;
      startBtn.textContent = 'Show me around';
    }
  };

  skipBtn.onclick = () => {
    markOnboarded();
    dismiss();
    onSkip?.();
  };
}
