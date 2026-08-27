// The audit trail for `/rc`: every time this daemon puts the command on a pty, it
// says so, and says which path asked for it.
//
// Why this exists: for a whole session the only rc-shaped evidence in the log was
// [rc-check], which covers the INHERITANCE DECISION and nothing else. A `/rc` sent by
// meta_type, or delivered from the browser, reached the agent logged as an anonymous
// `len=3` — indistinguishable from any other three-character prompt. So "deepsteve did
// not send it" was an inference from the ABSENCE of a line, which is not knowing. Two
// taps now: logRcWrite names the caller, and tapPtyWrite sits inside the engine and
// reports the bytes that actually went out.
//
// Run: node --test test/unit/rc-write-log.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const serverSource = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');

function sourceBetween(start, end) {
  const from = serverSource.indexOf(start);
  const to = serverSource.indexOf(end, from);
  assert.ok(from >= 0, `missing source marker: ${start}`);
  assert.ok(to > from, `missing source marker: ${end}`);
  return serverSource.slice(from, to);
}

function harness() {
  const logs = [];
  const context = { log: (m) => logs.push(m) };
  vm.runInNewContext(
    `${sourceBetween('const RC_COMMAND_RE', 'function submitToShell')}
result = { RC_COMMAND_RE, tapPtyWrite, logRcWrite }`,
    context,
  );
  return { ...context.result, logs };
}

test('a typed /rc is not reported, a written one is', () => {
  const h = harness();
  // A person typing arrives one character at a time; none of those is the command.
  for (const ch of ['/', 'r', 'c', '\r']) h.tapPtyWrite('s1', ch);
  assert.deepStrictEqual(h.logs, [], 'a keystroke stream must not be logged — that is a keylogger');

  h.tapPtyWrite('s1', '/rc');
  assert.strictEqual(h.logs.length, 1);
  assert.match(h.logs[0], /\[rc-pty\] id=s1 bytes="\/rc"/);
});

test('the bytes are reported as bytes, not as prose', () => {
  const h = harness();
  h.tapPtyWrite('s1', '/rc\r');
  assert.match(h.logs[0], /bytes="\/rc\\r"/,
    'the escape has to survive into the log or a submitted /rc reads like a staged one');
});

test('the command is matched as a token', () => {
  const h = harness();
  assert.strictEqual(h.RC_COMMAND_RE.test('/rc'), true);
  assert.strictEqual(h.RC_COMMAND_RE.test('/rc\r'), true);
  assert.strictEqual(h.RC_COMMAND_RE.test('/rcx'), false, 'a longer command is not this one');
  assert.strictEqual(h.RC_COMMAND_RE.test('/recent'), false);
  // Deliberately over-reports: a prompt that merely discusses the command is logged
  // too. For an audit trail a false positive costs a line and a false negative costs
  // the whole point of the trail.
  assert.strictEqual(h.RC_COMMAND_RE.test('explain the /rc command'), true);
});

test('a write is attributed to the path that asked for it', () => {
  const h = harness();
  h.logRcWrite('s1', '/rc', 'rc-inherit');
  h.logRcWrite('s2', '/rc', 'meta_type');
  assert.match(h.logs[0], /\[rc-write\] id=s1 source=rc-inherit/);
  assert.match(h.logs[1], /\[rc-write\] id=s2 source=meta_type/);
});

test('a non-rc write is silent on both taps', () => {
  const h = harness();
  h.tapPtyWrite('s1', 'do the issue');
  h.logRcWrite('s1', 'do the issue', 'issue-prompt');
  assert.deepStrictEqual(h.logs, []);
});
