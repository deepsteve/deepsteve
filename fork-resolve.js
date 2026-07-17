// Pure decision logic for resolving a fork parent's LIVE transcript tip (#455).
//
// When deepsteve forks a Claude conversation it runs
//   claude --resume <parentSessionId> --fork-session --session-id <new>
// using the in-memory claudeSessionId of the source tab. That value is only advanced
// mid-conversation by a best-effort fs.watch detector, which silently misses session-id
// rotations (dropped/coalesced macOS fs.watch events, an A→B→C chain break, a parent ref
// past the head window, or an event not yet processed at the fork instant). A stale value
// makes `--resume` fork an EARLIER checkpoint. `resolveForkTip` walks forward from the
// tracked id to the true tip so the fork always starts from the current branch tip.
//
// This module is dependency-free and side-effect-free ON PURPOSE: all filesystem I/O and
// the adopt/persist side effects live in server.js (resolveForkParentSession), which injects
// the head/mtime/ownership accessors here. That keeps the tricky chaining + reference logic
// deterministically unit-testable (test/unit/fork-resolve.test.js) without a live watcher.

// A transcript head STRUCTURALLY references `id` when the id appears in a line that is NOT
// message content (type !== 'user'/'assistant') — a `mode`, `summary`, or
// `file-history-snapshot` line, i.e. the places a real fork/rotation embeds its parent
// session id. This deliberately EXCLUDES an assistant/user message that merely quotes another
// session's UUID in its text (common in the deepsteve project, whose conversations discuss
// session ids), so the resolver never mistakes a content mention for a lineage edge.
// Truncated/partial lines that don't parse as JSON are skipped. `head` is the first N bytes
// of the transcript (see FORK_HEAD_READ_BYTES in server.js).
function headStructurallyReferences(head, id) {
  if (!head || !head.includes(id)) return false; // cheap reject before per-line parse
  for (const line of head.split('\n')) {
    if (!line.includes(id)) continue;
    let type;
    try { type = JSON.parse(line).type; } catch { continue; } // truncated tail / partial write
    if (type !== 'user' && type !== 'assistant') return true;
  }
  return false;
}

// Forward-chain from `startId` to the live transcript tip. Injected accessors:
//   ids:            iterable of candidate session ids present in the project dir
//   mtimeOf:        Map<id, mtimeMs> (a missing entry means the file is absent)
//   readHead:       (id) => string   — first FORK_HEAD_READ_BYTES of that transcript
//                   (caller should memoize so each file is read at most once)
//   ownedElsewhere: (id) => boolean  — true if a sibling tab / persisted fork child owns id
//                   (the #497 guard — never walk onto another tab's session)
// A descendant references its parent structurally and is not older (mtime >= parent's). Among
// matches at each hop we take the newest. Bounded to `maxHops` so a pathological cycle can't
// spin. Returns `startId` unchanged when nothing chains forward (i.e. it is already the tip).
function resolveForkTip({ startId, ids, mtimeOf, readHead, ownedElsewhere, maxHops = 10 }) {
  let candidate = startId;
  const visited = new Set([candidate]);
  for (let hop = 0; hop < maxHops; hop++) {
    const curMtime = mtimeOf.get(candidate);
    if (curMtime === undefined) break; // candidate transcript missing → stop, keep what we have
    let next = null;
    let nextMtime = -1;
    for (const id of ids) {
      if (visited.has(id)) continue;
      const m = mtimeOf.get(id);
      if (m === undefined) continue;
      if (m < curMtime) continue;                                  // a descendant isn't older
      if (ownedElsewhere(id)) continue;                            // sibling tab / fork child (#497)
      if (!headStructurallyReferences(readHead(id), candidate)) continue;
      if (m > nextMtime) { next = id; nextMtime = m; }
    }
    if (!next) break;
    candidate = next;
    visited.add(next);
  }
  return candidate;
}

module.exports = { headStructurallyReferences, resolveForkTip };
