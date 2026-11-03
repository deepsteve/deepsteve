// claude-logins.js — several Claude accounts, one per project (#748).
//
// The store is pointed at a scratch dir, so nothing here touches ~/.deepsteve. The one
// subprocess is /bin/sh running the exact prefix spawnSession builds, because the claim
// that matters most — the token reaches CLAUDE_CODE_OAUTH_TOKEN byte-for-byte and is
// never parsed as shell — is a claim about a shell, and only a shell can check it.
//
// Run: node --test test/unit/claude-logins.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  createClaudeLogins, loginForSpawn, projectForCwd, withTokenFromFile,
  tokenHint, cleanToken, cleanName, isLoginId, TOKEN_ENV, TOKEN_FILE_ENV,
} = require('../../claude-logins');

const TOKEN_A = 'sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwxyz';
const TOKEN_B = 'sk-ant-oat01-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB1234';

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ds-claude-logins-'));
}

function store(dir, ids = ['aaaa0001', 'bbbb0002', 'cccc0003']) {
  const queue = [...ids];
  return createClaudeLogins({ dir: path.join(dir, 'claude-logins'), genId: () => queue.shift(), now: () => 1000 });
}

const mode = (p) => fs.statSync(p).mode & 0o777;

test('adding a login writes the token to its own 0600 file, in a 0700 dir, and nowhere else', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const s = store(root);

  const r = s.add({ name: 'Work', token: `  ${TOKEN_A}\n` });
  assert.ok(r.login, r.error);
  assert.deepStrictEqual(r.login, { id: 'aaaa0001', name: 'Work', hint: '…wxyz', plan: 'pro', addedAt: 1000, missing: false });

  const tokenFile = path.join(s.dir, 'aaaa0001.token');
  assert.strictEqual(fs.readFileSync(tokenFile, 'utf8'), TOKEN_A, 'trimmed, and nothing but the token');
  assert.strictEqual(mode(tokenFile), 0o600);
  assert.strictEqual(mode(path.join(s.dir, 'index.json')), 0o600);
  assert.strictEqual(mode(s.dir), 0o700);

  // The token appears in exactly one file, and in nothing the API can return.
  for (const f of fs.readdirSync(s.dir)) {
    if (f === 'aaaa0001.token') continue;
    assert.ok(!fs.readFileSync(path.join(s.dir, f), 'utf8').includes(TOKEN_A), `${f} must not hold the token`);
  }
  assert.ok(!JSON.stringify(s.list()).includes(TOKEN_A), 'list() never carries a token');
  assert.ok(!JSON.stringify(r).includes(TOKEN_A), 'add() never echoes the token');
  assert.strictEqual(s.tokenFile('aaaa0001'), tokenFile);
});

test('an existing, wider dir is tightened to 0700', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'claude-logins'), { mode: 0o755 });
  fs.chmodSync(path.join(root, 'claude-logins'), 0o755);
  const s = store(root);
  assert.ok(s.add({ name: 'Work', token: TOKEN_A }).login);
  assert.strictEqual(mode(s.dir), 0o700);
});

test('logins survive a reload, and a hand-edited index cannot name a file outside the dir', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const s = store(root);
  s.add({ name: 'Work', token: TOKEN_A });
  s.add({ name: 'Personal', token: TOKEN_B });

  const again = store(root, []);
  assert.deepStrictEqual(again.list().map(l => [l.id, l.name, l.hint]), [['aaaa0001', 'Work', '…wxyz'], ['bbbb0002', 'Personal', '…1234']]);

  const idx = JSON.parse(fs.readFileSync(path.join(s.dir, 'index.json'), 'utf8'));
  idx.logins.push({ id: '../../etc/passwd', name: 'Evil' }, { id: 'aaaa0001', name: 'Duplicate' }, null);
  fs.writeFileSync(path.join(s.dir, 'index.json'), JSON.stringify(idx));
  const tampered = store(root, []);
  assert.deepStrictEqual(tampered.list().map(l => l.name), ['Work', 'Personal']);
  assert.strictEqual(tampered.tokenFile('../../etc/passwd'), null);
});

test('removing a login deletes its token file; an unknown id is a no-op', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const s = store(root);
  s.add({ name: 'Work', token: TOKEN_A });
  s.add({ name: 'Personal', token: TOKEN_B });

  assert.strictEqual(s.remove('aaaa0001'), true);
  assert.ok(!fs.existsSync(path.join(s.dir, 'aaaa0001.token')));
  assert.deepStrictEqual(s.list().map(l => l.id), ['bbbb0002']);
  assert.deepStrictEqual(store(root, []).list().map(l => l.id), ['bbbb0002'], 'the removal is on disk');
  assert.strictEqual(s.remove('aaaa0001'), false);
  assert.strictEqual(s.remove('nope'), false);
});

test('a login has a plan: chosen at add, changed in place, Pro for a row saved before plans', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const s = store(root);
  assert.strictEqual(s.add({ name: 'Work', token: TOKEN_A, plan: 'max' }).login.plan, 'max');
  assert.strictEqual(s.add({ name: 'Personal', token: TOKEN_B }).login.plan, 'pro', 'no plan sent → Pro');
  assert.match(s.add({ name: 'Team', token: TOKEN_B, plan: 'team' }).error, /plan must be one of: pro, max/);
  assert.strictEqual(s.list().length, 2, 'a refused plan adds nothing');

  assert.strictEqual(s.setPlan('bbbb0002', 'max').login.plan, 'max');
  assert.match(s.setPlan('bbbb0002', 'enterprise').error, /plan must be one of/);
  assert.strictEqual(s.get('bbbb0002').plan, 'max', 'a refused change keeps the old plan');
  assert.strictEqual(s.setPlan('nope0000', 'pro').notFound, true);
  assert.deepStrictEqual(store(root, []).list().map(l => [l.name, l.plan]), [['Work', 'max'], ['Personal', 'max']], 'plans are on disk');

  // A row written before plans existed, or hand-edited to something else, reads as Pro.
  const idx = JSON.parse(fs.readFileSync(path.join(s.dir, 'index.json'), 'utf8'));
  delete idx.logins[0].plan;
  idx.logins[1].plan = 'team';
  fs.writeFileSync(path.join(s.dir, 'index.json'), JSON.stringify(idx));
  assert.deepStrictEqual(store(root, []).list().map(l => l.plan), ['pro', 'pro']);
});

test('a token file that went missing is reported, and resolves to no file', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const s = store(root);
  s.add({ name: 'Work', token: TOKEN_A });
  fs.unlinkSync(path.join(s.dir, 'aaaa0001.token'));
  assert.strictEqual(s.list()[0].missing, true);
  assert.strictEqual(s.tokenFile('aaaa0001'), null);
});

test('names: required, bounded, unique ignoring case, and never "System"', () => {
  assert.ok(cleanName('').error);
  assert.ok(cleanName('   ').error);
  assert.ok(cleanName('x'.repeat(41)).error);
  assert.ok(cleanName('system').error);
  assert.ok(cleanName('SYSTEM').error);
  assert.ok(cleanName('work', ['Work']).error);
  assert.deepStrictEqual(cleanName('  Side   project '), { name: 'Side project' });
});

test('tokens: one line of printable ASCII, trimmed', () => {
  assert.ok(cleanToken('').error);
  assert.ok(cleanToken(undefined).error);
  assert.ok(cleanToken('abc def').error, 'an inner space is a copy mistake');
  assert.ok(cleanToken('abc\ndef').error, 'so is a line break');
  assert.ok(cleanToken('x'.repeat(4097)).error);
  assert.deepStrictEqual(cleanToken(`\n ${TOKEN_A} \n`), { token: TOKEN_A });
  assert.strictEqual(tokenHint(TOKEN_A), '…wxyz');
  assert.strictEqual(tokenHint('short'), '…', 'a short token shows no characters at all');
});

test('login ids are the minted shape only', () => {
  assert.ok(isLoginId('aaaa0001'));
  for (const bad of ['', 'AAAA0001', 'aaaa000', 'aaaa00011', '../aaaa0', null, 7]) assert.ok(!isLoginId(bad), String(bad));
});

test('a cwd belongs to the project with the longest folder containing it', () => {
  const outer = { id: 'o', name: 'Outer', dirs: ['/src/mono'] };
  const inner = { id: 'i', name: 'Inner', dirs: ['/src/mono/packages/app/'] };
  const sibling = { id: 's', name: 'Sibling', dirs: ['/src/mono-tools'] };
  const ctxs = [outer, inner, sibling];
  assert.strictEqual(projectForCwd(ctxs, '/src/mono'), outer);
  assert.strictEqual(projectForCwd(ctxs, '/src/mono/lib'), outer);
  assert.strictEqual(projectForCwd(ctxs, '/src/mono/packages/app'), inner, 'trailing slash ignored');
  assert.strictEqual(projectForCwd(ctxs, '/src/mono/packages/app/.claude/worktrees/x'), inner);
  assert.strictEqual(projectForCwd(ctxs, '/src/mono-tools/bin'), sibling, 'a shared prefix is not containment');
  assert.strictEqual(projectForCwd(ctxs, '/elsewhere'), null);
  assert.strictEqual(projectForCwd(ctxs, ''), null);
  assert.strictEqual(projectForCwd([{ dirs: [''] }, { dirs: ['/'] }], '/x'), null, 'an empty or root folder claims nothing');
});

test('loginForSpawn: a Claude session in an assigned project gets that login, nothing else does', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const s = store(root);
  s.add({ name: 'Work', token: TOKEN_A });
  const work = { id: 'w', name: 'Work repo', dirs: ['/src/work'], claudeLoginId: 'aaaa0001' };
  const home = { id: 'h', name: 'Home repo', dirs: ['/src/home'], claudeLoginId: null };
  const contexts = [work, home];
  const base = { agentType: 'claude', cwd: '/src/work/sub', configDir: null, contexts, logins: s };

  const got = loginForSpawn(base);
  assert.strictEqual(got.project, work);
  assert.strictEqual(got.login.name, 'Work');
  assert.strictEqual(got.tokenFile, path.join(s.dir, 'aaaa0001.token'));

  assert.strictEqual(loginForSpawn({ ...base, cwd: '/src/home' }), null, 'unassigned project → System');
  assert.strictEqual(loginForSpawn({ ...base, cwd: '/tmp' }), null, 'no project → System');
  assert.strictEqual(loginForSpawn({ ...base, agentType: 'codex' }), null, 'Claude only');
  assert.strictEqual(loginForSpawn({ ...base, agentType: 'terminal' }), null, 'not a plain terminal');
  assert.strictEqual(loginForSpawn({ ...base, configDir: '/p/.claude-alt' }), null, 'a config profile keeps its own credentials');
  assert.strictEqual(loginForSpawn({ ...base, contexts: [{ ...work, claudeLoginId: 'ffff9999' }] }), null, 'a login that is gone → System');

  fs.unlinkSync(got.tokenFile);
  const missing = loginForSpawn(base);
  assert.strictEqual(missing.missing, true);
  assert.strictEqual(missing.tokenFile, null);
});

test('the launch prefix hands the token to the command byte-for-byte, and never as shell', (t) => {
  const root = scratch();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // Everything a shell would act on if the token were ever parsed: substitution,
  // backticks, quotes, a glob, a semicolon. cleanToken accepts all of it (printable
  // ASCII), so the file read must be what makes it inert.
  const hostile = `x$(touch ${path.join(root, 'pwned')})\`touch ${path.join(root, 'pwned2')}\`'"*;y`;
  const file = path.join(root, 'tok');
  fs.writeFileSync(file, hostile, { mode: 0o600 });

  const cmd = withTokenFromFile(`printenv ${TOKEN_ENV}`);
  assert.ok(!cmd.includes(hostile), 'the token is not in the command string');
  assert.ok(cmd.endsWith(` printenv ${TOKEN_ENV}`), 'the original command is untouched');

  const out = execFileSync('/bin/sh', ['-c', cmd], { env: { PATH: process.env.PATH, [TOKEN_FILE_ENV]: file }, encoding: 'utf8' });
  assert.strictEqual(out, hostile + '\n');
  assert.ok(!fs.existsSync(path.join(root, 'pwned')), 'no $( ) ran');
  assert.ok(!fs.existsSync(path.join(root, 'pwned2')), 'no backticks ran');
});
