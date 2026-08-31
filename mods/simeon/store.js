/**
 * The Simeon runtime — the tree, the data, and the index between them. Pure: it holds no
 * DOM and calls out through handlers, so it runs under `await import()` in a bare Node test.
 *
 * Two stores, never one:
 *
 *   nodes  id  -> { id, type, parent, props, children }     the DESIGN
 *   data   path -> value                                    the DATA
 *
 * and one index that joins them: `binds`, path -> the set of node ids reading that path.
 * A `d` row therefore costs a map lookup and a re-render of exactly the nodes holding that
 * binding, whatever the size of the interface. That is what "immediately indexable" buys —
 * the agent updates a number by sending one row, not by redrawing a tree.
 *
 * ORPHANS. A node whose parent has not arrived is kept, not dropped, and mounts the moment
 * the parent shows up. This is what makes rows order-independent: a stream can be cut
 * anywhere, or arrive out of order, and the tree is never in a broken state — only an
 * incomplete one.
 */

import { isBinding } from './rows.js';

export const ROOT = '#root';

// What a model writes when it means "the top". The language says to omit @parent for that,
// and a real run wrote `n app col @root` anyway — which parked the entire dashboard as an
// orphan waiting for a node named `root` that was never coming. A predictable improvisation
// deserves an alias, not a silently empty canvas.
const ROOT_ALIASES = new Set([ROOT, 'root', 'Root', 'ROOT', 'app-root', 'canvas']);

/** Normalize a parent id: the root's many spellings all become null (= attach to root). */
export function normalizeParent(parent) {
  if (parent == null) return null;
  return ROOT_ALIASES.has(parent) ? null : parent;
}

/**
 * Read a data path. Exact key first — the flat case, and the fast one — then fall back to
 * walking dots into a value stored at a shorter key, so `d sys {"cpu":42}` and
 * `d sys.cpu 42` are both readable as `$sys.cpu`.
 */
export function readPath(data, path) {
  if (data.has(path)) return data.get(path);
  const parts = path.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const head = parts.slice(0, i).join('.');
    if (!data.has(head)) continue;
    let v = data.get(head);
    for (const k of parts.slice(i)) {
      if (v == null) return undefined;
      v = v[k];
    }
    return v;
  }
  return undefined;
}

/** Whether a write to `changed` can be seen through a binding on `bound`. */
export function pathAffects(changed, bound) {
  return bound === changed
    || bound.startsWith(changed + '.')
    || changed.startsWith(bound + '.');
}

/**
 * @param handlers {{
 *   onMount?: (node) => void,      // node is attached and its parent is on screen
 *   onUpdate?: (node, info) => void, // props changed; info.retyped means rebuild the element
 *   onReparent?: (node) => void,
 *   onRemove?: (node) => void,
 *   onClear?: () => void,
 * }}
 */
export function createStore(handlers = {}) {
  const nodes = new Map();
  const data = new Map();
  const binds = new Map();          // dataPath -> Set<nodeId>
  const orphans = new Map();        // missing parent id -> [nodeId] in arrival order

  const root = { id: ROOT, type: 'root', parent: null, props: {}, children: [], mounted: true };
  nodes.set(ROOT, root);

  const fire = (name, ...args) => { try { handlers[name]?.(...args); } catch (e) { console.error('[simeon]', name, e); } };

  function indexBindings(node) {
    // Drop the OLD entries first, keys included. Leaving an emptied set behind would make
    // `binds` grow with every prop a node ever bound to and never bind again — and `binds`
    // is walked on every data row, so a leak there is a cost paid per update forever.
    dropBindings(node);
    const next = new Set();
    for (const v of Object.values(node.props)) {
      if (isBinding(v)) next.add(v.$bind);
    }
    for (const path of next) {
      if (!binds.has(path)) binds.set(path, new Set());
      binds.get(path).add(node.id);
    }
    node.bindPaths = next;
  }

  function dropBindings(node) {
    for (const path of node.bindPaths || []) {
      const set = binds.get(path);
      if (!set) continue;
      set.delete(node.id);
      if (!set.size) binds.delete(path);
    }
    node.bindPaths = null;
  }

  /** Attach `node` under its parent and mount it, then any orphans waiting on it. */
  function attach(node) {
    const parent = nodes.get(node.parent || ROOT);
    if (!parent || !parent.mounted) {
      const key = node.parent || ROOT;
      if (!orphans.has(key)) orphans.set(key, []);
      const queue = orphans.get(key);
      if (!queue.includes(node.id)) queue.push(node.id);
      return;
    }
    parent.children.push(node.id);
    node.mounted = true;
    fire('onMount', node);
    drainOrphans(node.id);
  }

  function drainOrphans(parentId) {
    const queue = orphans.get(parentId);
    if (!queue) return;
    orphans.delete(parentId);
    for (const id of queue) {
      const child = nodes.get(id);
      if (child && !child.mounted) attach(child);
    }
  }

  function detach(node) {
    const parent = nodes.get(node.parent || ROOT);
    if (parent) {
      const i = parent.children.indexOf(node.id);
      if (i >= 0) parent.children.splice(i, 1);
    }
  }

  /** Depth-first, children before parent, so a renderer can tear down in a safe order. */
  function removeSubtree(id, out) {
    const node = nodes.get(id);
    if (!node) return;
    for (const childId of [...node.children]) removeSubtree(childId, out);
    dropBindings(node);
    nodes.delete(id);
    orphans.delete(id);
    out.push(node);
  }

  /** The node's props with every binding replaced by what it currently reads. */
  function resolve(node) {
    const out = {};
    for (const [k, v] of Object.entries(node.props)) {
      out[k] = isBinding(v) ? readPath(data, v.$bind) : v;
    }
    return out;
  }

  function applyNode(op) {
    const existing = nodes.get(op.id);

    if (existing) {
      const retyped = !!op.type && op.type !== existing.type;
      if (retyped) existing.type = op.type;
      Object.assign(existing.props, op.props);
      indexBindings(existing);

      const nextParent = normalizeParent(op.parent);
      if (op.parent !== null && nextParent !== existing.parent) {
        detach(existing);
        existing.parent = nextParent;
        const parent = nodes.get(nextParent || ROOT);
        if (parent && parent.mounted) {
          parent.children.push(existing.id);
          fire('onReparent', existing);
        } else {
          existing.mounted = false;
          attach(existing);
        }
      }
      fire('onUpdate', existing, { retyped });
      return existing;
    }

    const node = {
      id: op.id,
      type: op.type || 'text',
      parent: normalizeParent(op.parent),
      props: { ...op.props },
      children: [],
      mounted: false,
      bindPaths: null,
    };
    nodes.set(node.id, node);
    indexBindings(node);
    attach(node);
    return node;
  }

  function applyData(op) {
    data.set(op.path, op.value);
    const dirty = new Set();
    for (const [bound, ids] of binds) {
      if (!pathAffects(op.path, bound)) continue;
      for (const id of ids) dirty.add(id);
    }
    for (const id of dirty) {
      const node = nodes.get(id);
      if (node && node.mounted) fire('onUpdate', node, { retyped: false, fromData: true });
    }
    return dirty.size;
  }

  function clear() {
    nodes.clear();
    data.clear();
    binds.clear();
    orphans.clear();
    root.children = [];
    nodes.set(ROOT, root);
    fire('onClear');
  }

  return {
    nodes, data, binds, orphans, root,
    resolve,
    read: (path) => readPath(data, path),
    apply(op) {
      if (!op) return null;
      switch (op.op) {
        case 'node': return applyNode(op);
        case 'data': return applyData(op);
        case 'remove': {
          const removed = [];
          const node = nodes.get(op.id);
          if (!node) return null;
          detach(node);
          removeSubtree(op.id, removed);
          for (const n of removed) fire('onRemove', n);
          return removed;
        }
        case 'clear': clear(); return null;
        default: return null;
      }
    },
    /** Debug/inspection: the current tree as nested plain objects. */
    snapshot(id = ROOT) {
      const node = nodes.get(id);
      if (!node) return null;
      return {
        id: node.id, type: node.type, props: resolve(node),
        children: node.children.map(c => this.snapshot(c)).filter(Boolean),
      };
    },
  };
}
