/**
 * Shared pieces for the right-click menus built from .context-menu / .context-menu-item (#723):
 * a submenu row that opens a flyout beside it, and keyboard navigation for a whole menu.
 *
 * Nothing here touches the DOM at module scope: tab-manager.js imports it, and several unit
 * tests import tab-manager.js against a handful of stubbed globals.
 */

// A pointer sweeping down the menu shouldn't flash every flyout it crosses.
export const SUBMENU_OPEN_DELAY_MS = 120;
// The grace that lets the pointer cross to the flyout — over the gap, or diagonally over the rows
// beneath its trigger — without the flyout snapping shut on the way.
export const SUBMENU_CLOSE_DELAY_MS = 300;

const GAP = 2;     // between a trigger and its flyout
const MARGIN = 8;  // kept clear of the viewport's edges

// trigger → its submenu, so the keyboard can open a flyout it didn't build.
const submenus = new WeakMap();
// menu → the submenu whose flyout is open in it. One at a time, as in a native menu.
const openIn = new WeakMap();

const rowsOf = (level) => [...level.children].filter(c =>
  c.classList.contains('context-menu-item') && !c.classList.contains('disabled'));

/**
 * Make `trigger`, a .context-menu-item of `menu`, a submenu row: a ▶ on the right, and a flyout
 * beside it on hover, click or → that `build(flyout)` fills with .context-menu-item rows. It is
 * rebuilt on every open, so what it lists is current.
 *
 * The flyout is a child of the trigger. Removing the menu takes it along, and the pointer moving
 * into it never leaves the trigger as far as mouseenter/mouseleave are concerned. Clicks inside
 * it stop there: a row's own onclick has run by then, and the trigger must not act on it too.
 *
 * `onClick` is what clicking the trigger itself does. Without one, the click opens the flyout.
 * Returns { open(), close(), isOpen(), flyout, opensOnClick }.
 */
export function attachSubmenu(menu, trigger, build, { onClick } = {}) {
  let flyout = null;
  let openTimer = null;
  let closeTimer = null;

  trigger.classList.add('context-menu-has-submenu');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  const arrow = document.createElement('span');
  arrow.className = 'context-menu-arrow';
  trigger.appendChild(arrow);

  function clearTimers() {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    openTimer = closeTimer = null;
  }

  // Beside the trigger, flipped to its left when the right edge has no room, and kept inside the
  // viewport vertically — .context-flyout caps its height and scrolls. Measured from the viewport's
  // corner first, so the width is the flyout's own and not what was left beside the trigger.
  function place() {
    flyout.style.left = '0px';
    flyout.style.top = '0px';
    const t = trigger.getBoundingClientRect();
    const f = flyout.getBoundingClientRect();
    let left = t.right + GAP;
    if (left + f.width > window.innerWidth - MARGIN) left = t.left - f.width - GAP;
    const top = Math.min(t.top, window.innerHeight - f.height - MARGIN);
    flyout.style.left = Math.max(MARGIN, left) + 'px';
    flyout.style.top = Math.max(MARGIN, top) + 'px';
  }

  function open() {
    clearTimers();
    if (flyout || !trigger.isConnected) return; // a timer outliving its menu does nothing
    const other = openIn.get(menu);
    if (other && other !== handle) other.close();
    flyout = document.createElement('div');
    flyout.className = 'context-menu context-submenu context-flyout';
    flyout.setAttribute('role', 'menu');
    flyout.addEventListener('click', (e) => e.stopPropagation());
    build(flyout);
    trigger.appendChild(flyout);
    place();
    trigger.setAttribute('aria-expanded', 'true');
    openIn.set(menu, handle);
  }

  function close() {
    clearTimers();
    if (!flyout) return;
    flyout.remove();
    flyout = null;
    trigger.setAttribute('aria-expanded', 'false');
    if (openIn.get(menu) === handle) openIn.delete(menu);
  }

  trigger.addEventListener('mouseenter', () => {
    clearTimeout(closeTimer);
    closeTimer = null;
    if (flyout || openTimer) return;
    openTimer = setTimeout(open, SUBMENU_OPEN_DELAY_MS);
  });
  trigger.addEventListener('mouseleave', () => {
    clearTimeout(openTimer);
    openTimer = null;
    if (!flyout || closeTimer) return;
    closeTimer = setTimeout(close, SUBMENU_CLOSE_DELAY_MS);
  });

  trigger.onclick = (e) => {
    if (onClick) { onClick(); return; }
    e?.stopPropagation(); // the document's click listener would close the whole menu
    open();
  };

  const handle = {
    open,
    close,
    isOpen: () => !!flyout,
    get flyout() { return flyout; },
    opensOnClick: !onClick,
  };
  submenus.set(trigger, handle);
  return handle;
}

/**
 * Keyboard navigation for an open menu, until dispose(): ↑/↓ move the highlight through the
 * enabled rows of the current level and wrap, → steps into a submenu, ← and Esc step back out,
 * Enter or Space picks the row, and Esc at the top calls `onClose`.
 *
 * It listens on the document in the capture phase — the pattern context-views and project-mods
 * use for Escape — so nothing is focused and nothing has to be handed back: a right-click has
 * already taken focus off the terminal, and capture runs ahead of xterm's textarea. Every key it
 * handles is stopped there, or an Enter would reach the PTY as a newline.
 *
 * `.active` is the menu's one highlight, for the mouse as well as the keys (`context-menu-kbd`
 * switches :hover off), so the two can never point at different rows. It follows mousemove
 * rather than mouseover, which Chrome fires under a still pointer when the keys scroll a flyout.
 */
export function enableMenuKeyboard(menu, { onClose } = {}) {
  let active = null;
  menu.classList.add('context-menu-kbd');

  function setActive(item, { scroll = false } = {}) {
    if (active === item) return;
    active?.classList.remove('active');
    active = item;
    if (!item) return;
    item.classList.add('active');
    if (scroll) item.scrollIntoView?.({ block: 'nearest' });
  }

  function stepInto(sub) {
    sub.open();
    const first = sub.flyout && rowsOf(sub.flyout)[0];
    if (first) setActive(first, { scroll: true });
  }

  // `level` is an open flyout; its trigger is the row it hangs off.
  function stepOut(level) {
    const trigger = level.parentElement;
    submenus.get(trigger)?.close();
    setActive(trigger);
  }

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const cur = active && active.isConnected ? active : null;
    const level = cur ? cur.parentElement : menu;
    const sub = cur ? submenus.get(cur) : null;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const rows = rowsOf(level);
        if (!rows.length) break;
        const down = e.key === 'ArrowDown';
        const i = rows.indexOf(cur);
        const next = i < 0
          ? rows[down ? 0 : rows.length - 1]
          : rows[(i + (down ? 1 : -1) + rows.length) % rows.length];
        sub?.close(); // moving off a trigger takes its flyout with it
        setActive(next, { scroll: true });
        break;
      }
      case 'ArrowRight':
        if (sub) stepInto(sub);
        break;
      case 'ArrowLeft':
        if (level !== menu) stepOut(level);
        break;
      case 'Escape':
        if (level !== menu) stepOut(level);
        else onClose?.();
        break;
      case 'Enter':
      case ' ':
        if (!cur) break;
        if (sub && sub.opensOnClick) stepInto(sub);
        else cur.click();
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  function onMove(e) {
    const item = e.target.closest?.('.context-menu-item');
    setActive(item && !item.classList.contains('disabled') ? item : null);
  }
  function onLeave() { setActive(null); }

  document.addEventListener('keydown', onKey, true);
  menu.addEventListener('mousemove', onMove);
  menu.addEventListener('mouseleave', onLeave);

  return {
    dispose() {
      document.removeEventListener('keydown', onKey, true);
      menu.removeEventListener('mousemove', onMove);
      menu.removeEventListener('mouseleave', onLeave);
    },
  };
}
