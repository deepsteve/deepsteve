// Budget guard for CLAUDE.md (#629).
//
// The problem this exists for: CLAUDE.md is injected at the start of every session AND
// re-injected on every compaction, so its size is a fixed tax on every agent turn in this
// repo. Left alone it grew 12.9 KB -> 22.2 KB -> 56.2 KB -> 117 KB in three months —
// roughly doubling every two weeks — because every merged issue appended its own
// post-mortem and nothing was ever removed. 100 issue references, six separate
// explanations of tmux.
//
// Nothing *told* agents to do that; the growth was cultural, which is exactly why a
// written rule alone would not have held. So the rule ("this file is a budget, not a log")
// gets a test, in the shape of the other anti-drift guards here — agents-doc.test.js binds
// docs/agents.md to AGENT_CATALOG, public-suite-pin.test.js binds the workflow to its own
// shape, and this binds CLAUDE.md to its budget and to docs/.
//
// When this fails, the fix is to MOVE something to docs/ and leave a trigger line behind.
// Tightening wording until it fits is how the file got here.
//
// Pure file reads — no server boot, no shell — so it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/claude-md-budget.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const DOCS_DIR = path.join(ROOT, 'docs');
const CLAUDE_MD = path.join(ROOT, 'CLAUDE.md');

const source = fs.readFileSync(CLAUDE_MD, 'utf8');
const bytes = Buffer.byteLength(source, 'utf8');

// 30 KB. It landed at ~17.5 KB after #629, so this is real headroom rather than a
// straitjacket — but it trips long before another doubling could.
const BUDGET_BYTES = 30 * 1024;

// The heading that carries the anti-growth rule. Renaming it is fine; update it here too.
// What must not happen is the rule quietly disappearing while the cap stays.
const RULE_HEADING = '## Keeping this file small';

/** Byte size of each `##`/`###` section, largest first — so a failure names the fix. */
function sectionSizes() {
  const sizes = [];
  let heading = '(preamble)';
  let size = 0;
  for (const line of source.split('\n')) {
    if (/^#{1,3} /.test(line)) {
      sizes.push({ heading, size });
      heading = line;
      size = 0;
    }
    size += Buffer.byteLength(line, 'utf8') + 1;
  }
  sizes.push({ heading, size });
  return sizes.sort((a, b) => b.size - a.size);
}

test('CLAUDE.md stays under budget (#629)', () => {
  const worst = sectionSizes()
    .slice(0, 5)
    .map(s => `    ${String(s.size).padStart(6)} B  ${s.heading}`)
    .join('\n');

  assert.ok(bytes <= BUDGET_BYTES,
    `CLAUDE.md is ${bytes} bytes, over the ${BUDGET_BYTES}-byte budget by ${bytes - BUDGET_BYTES}.\n` +
    '  It is re-injected on every compaction, so this is paid on every turn of every session.\n' +
    '  Move a section to docs/ and leave a one-line trigger in the "Where things are documented"\n' +
    '  table — do NOT just tighten the wording. Largest sections right now:\n' + worst);
});

test('the rule that bounds this file is still in it (#629)', () => {
  // A cap with no stated rule invites "make it fit" edits forever; the rule is what says
  // the fix is relocation. Both halves have to survive together.
  assert.ok(source.includes(RULE_HEADING),
    `CLAUDE.md must keep its "${RULE_HEADING}" section — the budget is only half the guard, ` +
    'the rule explaining that mechanism belongs in docs/ is the other half');
  assert.match(source, /budget, not a log/i,
    'the budget section must still state the rule itself, not merely the number');
  assert.match(source, /\bcompaction\b/i,
    'the budget section must say why size matters: this file is re-injected on every compaction');
});

test('every docs/ page is reachable from CLAUDE.md (#629)', () => {
  // Moving mechanism into docs/ only works if an agent can find it. This is the same
  // trick agents-doc.test.js uses: make the doc a build dependency of the thing it serves.
  const pages = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.md')).sort();
  assert.ok(pages.length > 0, 'no docs/*.md found');

  for (const page of pages) {
    assert.ok(source.includes(`docs/${page}`),
      `docs/${page} is not linked from CLAUDE.md — add a trigger line for it to the ` +
      '"Where things are documented" table, saying when to read it');
  }
});

test('every docs/ link in CLAUDE.md resolves (#629)', () => {
  const linked = new Set([...source.matchAll(/docs\/([\w.-]+\.md)/g)].map(m => m[1]));
  assert.ok(linked.size > 0, 'CLAUDE.md links no docs/ pages at all');

  for (const page of linked) {
    assert.ok(fs.existsSync(path.join(DOCS_DIR, page)),
      `CLAUDE.md points at docs/${page}, which does not exist (renamed or deleted?)`);
  }
});
