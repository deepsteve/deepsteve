/**
 * Storage namespace isolation for recursive DeepSteve windows.
 *
 * When DeepSteve is opened inside its own Baby Browser proxy, the inner
 * instance shares the same origin and therefore the same sessionStorage,
 * localStorage, and BroadcastChannel namespace. We detect iframe nesting
 * depth and prefix all keys so each level gets its own isolated state.
 *
 * Depth 0 (top-level) uses no prefix — fully backward compatible.
 */

let recursionDepth = 0;
try {
  let w = window;
  while (w !== w.parent) {
    w = w.parent;
    recursionDepth++;
  }
} catch {
  // cross-origin parent — treat current depth as final
}

const prefix = recursionDepth > 0 ? `ds${recursionDepth}-` : '';

export function nsKey(key) {
  return prefix + key;
}

export function nsChannel(name) {
  return prefix + name;
}

export { recursionDepth };
