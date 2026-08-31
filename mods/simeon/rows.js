/**
 * The Simeon row language — parser only. No DOM, no state, no imports, so it runs
 * unchanged in the browser and under `await import()` in a bare Node unit test.
 *
 * One row per line. One line is one complete instruction. That is the whole design:
 * a model streaming this can be cut off anywhere and everything before the cut is a
 * valid, already-mountable tree.
 *
 *   n <id> <type> [@parent] [key=value ...]   create, or patch if <id> exists
 *   d <path> <value>                          set a data value
 *   x <id>                                    remove a node and its subtree
 *   c                                         clear
 *   # ...                                     comment
 *
 * A row this parser does not understand returns null rather than throwing. Rows arrive
 * from a language model; the failure mode that matters is one stray line of prose, and
 * an interface that stops rendering because of it is worse than one that ignores it.
 */

/**
 * Split a row into tokens, honouring double-quoted strings and balanced JSON brackets so
 * `title="Mission Control"` and `series=[3, 9, 4]` each stay one token.
 *
 * A `#` that STARTS a token begins a comment; a `#` inside one does not, which is what
 * keeps `color=#0ff` from silently truncating the row.
 */
export function tokenize(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    if (line[i] === '#') break; // rest of the line is a comment

    const start = i;
    let depth = 0;
    let inStr = false;
    while (i < line.length) {
      const c = line[i];
      if (inStr) {
        if (c === '\\') { i += 2; continue; }
        if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') { inStr = true; i++; continue; }
      if (c === '[' || c === '{') { depth++; i++; continue; }
      if (c === ']' || c === '}') { depth--; i++; continue; }
      if (depth <= 0 && /\s/.test(c)) break;
      i++;
    }
    out.push(line.slice(start, i));
  }
  return out;
}

/**
 * Turn a raw value token into what it means.
 *
 * `$path` is the one that carries the design/data split: it is not a value at all but a
 * reference, and the store re-renders whatever holds it whenever that path changes.
 */
export function coerce(raw) {
  if (raw === '') return '';
  if (raw[0] === '$') return { $bind: raw.slice(1) };
  if (raw[0] === '"') {
    try { return JSON.parse(raw); } catch { return raw.slice(1).replace(/"$/, ''); }
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw[0] === '[' || raw[0] === '{') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

/** Whether a resolved prop value is a binding rather than a literal. */
export function isBinding(v) {
  return !!v && typeof v === 'object' && typeof v.$bind === 'string';
}

function splitPair(token) {
  const eq = token.indexOf('=');
  if (eq <= 0) return null;
  return [token.slice(0, eq), token.slice(eq + 1)];
}

/**
 * Parse one line. Returns an op, or null for a blank line, a comment, or anything
 * unrecognised.
 *
 * Ops: {op:'node', id, type|null, parent|null, props}
 *      {op:'data', path, value}
 *      {op:'remove', id}
 *      {op:'clear'}
 */
export function parseRow(line) {
  const t = tokenize(String(line ?? ''));
  if (!t.length) return null;

  const kind = t[0];

  if (kind === 'c') return { op: 'clear' };

  if (kind === 'x') {
    return t[1] ? { op: 'remove', id: t[1] } : null;
  }

  if (kind === 'd') {
    if (!t[1]) return null;
    // Everything after the path is the value. Rejoining is what lets an unquoted
    // sentence work — `d note hello there` means the string "hello there".
    const rest = t.slice(2);
    if (!rest.length) return { op: 'data', path: t[1], value: null };
    const value = rest.length === 1 ? coerce(rest[0]) : rest.join(' ');
    return { op: 'data', path: t[1], value };
  }

  if (kind === 'n') {
    if (!t[1]) return null;
    const id = t[1];
    let type = null;
    let parent = null;
    const props = {};

    let i = 2;
    // A bare token in the type slot is the type. `n cpu tone=alert` and `n cpu @kpis`
    // are patches, which is how you edit one prop without restating the component.
    if (t[i] && t[i][0] !== '@' && !splitPair(t[i])) { type = t[i]; i++; }

    for (; i < t.length; i++) {
      const tok = t[i];
      if (tok[0] === '@') { parent = tok.slice(1) || null; continue; }
      const pair = splitPair(tok);
      if (!pair) continue; // a stray bare word late in the row is not an error, just noise
      props[pair[0]] = coerce(pair[1]);
    }

    return { op: 'node', id, type, parent, props };
  }

  return null;
}

/** Parse a block of text into ops, dropping the lines that carry none. */
export function parseRows(text) {
  return String(text ?? '')
    .split('\n')
    .map(parseRow)
    .filter(Boolean);
}
