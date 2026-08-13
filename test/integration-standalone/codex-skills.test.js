const { test, before, after } = require('node:test')
const assert = require('node:assert')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { TmuxSandbox } = require('../helpers/tmux-sandbox')

const REPO_ROOT = path.resolve(__dirname, '..', '..')
let tmpRoot
let HOME
let PORT
let BASE
let daemon = null
let daemonLog = ''
// null until before() has validated one. `after()` uses `sandbox?.cleanup()`, so a
// before() that throws leaves a no-op rather than an unaimed tmux command (#625).
let sandbox = null

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function authToken() {
  try {
    return fs.readFileSync(path.join(HOME, '.deepsteve', 'auth-token'), 'utf8').trim()
  } catch {
    return ''
  }
}

function authHeaders() {
  const token = authToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function waitFor(check, what) {
  const deadline = Date.now() + 15000
  for (;;) {
    try {
      if (await check()) return
    } catch {}
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

async function startDaemon() {
  const env = { ...process.env, HOME, PORT: String(PORT) }
  delete env.CLAUDECODE
  for (const key of Object.keys(env)) {
    if (key.startsWith('DEEPSTEVE_')) delete env[key]
  }
  fs.mkdirSync(path.join(HOME, '.deepsteve'), { recursive: true })
  fs.writeFileSync(path.join(HOME, '.deepsteve', '.restarting'), '')
  // The daemon derives its tmux socket from $HOME/.deepsteve/tmux.sock and passes it
  // as `-S` (#625), so a scratch HOME IS a scratch tmux server — there is no
  // TMUX_TMPDIR to set, and setting one would isolate nothing while reading like it
  // did. The sandbox anchors on that same HOME so this suite and the daemon are
  // provably on ONE socket, and so `after()` can reap the tmux server that outlives
  // the daemon (shutdown detaches rather than kills).
  sandbox = TmuxSandbox.forHome(HOME)

  daemon = spawn('node', ['server.js', '--test-mode'], { cwd: REPO_ROOT, env })
  daemon.stdout.on('data', data => { daemonLog += data.toString() })
  daemon.stderr.on('data', data => { daemonLog += data.toString() })
  await waitFor(async () => {
    if (!authToken()) return false
    return (await fetch(`${BASE}/api/version`, { headers: authHeaders() })).ok
  }, 'daemon startup')
}

function stopDaemon() {
  if (!daemon) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const processToStop = daemon
    daemon = null
    const timer = setTimeout(() => reject(new Error('daemon did not exit after SIGTERM')), 30000)
    processToStop.on('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    processToStop.kill('SIGTERM')
  })
}

async function postSkill(action, id) {
  const response = await fetch(`${BASE}/api/skills/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ id }),
  })
  return response.json()
}

const claudeSkillPath = id => path.join(HOME, '.claude', 'commands', 'deepsteve', `${id}.md`)
const codexStorePath = id => path.join(HOME, '.deepsteve', 'codex-skills', `deepsteve-${id}`)
const codexLinkPath = id => path.join(HOME, '.agents', 'skills', `deepsteve-${id}`)
const codexSkillPath = id => path.join(codexLinkPath(id), 'SKILL.md')
const settingsPath = () => path.join(HOME, '.deepsteve', 'settings.json')

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-codex-skills-'))
  HOME = path.join(tmpRoot, 'home')
  fs.mkdirSync(HOME, { recursive: true })
  PORT = await freePort()
  BASE = `http://127.0.0.1:${PORT}`
  await startDaemon()
})

after(async () => {
  await stopDaemon().catch(() => {})
  // A SIGTERMed daemon DETACHES its tmux sessions, so the scratch tmux server
  // outlives it and the rm below would only unlink its socket — leaving a running
  // server nothing can ever reach again. Reap it by name (#625).
  try { sandbox?.cleanup() } catch (e) { console.error(e.message) }
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

test('enable provisions Claude and a Codex-safe symlinked SKILL.md', async () => {
  assert.strictEqual((await postSkill('enable', 'chat')).ok, true)
  const canonical = fs.readFileSync(path.join(REPO_ROOT, 'skills', 'chat.md'), 'utf8')
  assert.strictEqual(fs.readFileSync(claudeSkillPath('chat'), 'utf8'), canonical)
  assert.ok(fs.lstatSync(codexLinkPath('chat')).isSymbolicLink())
  assert.strictEqual(fs.readlinkSync(codexLinkPath('chat')), codexStorePath('chat'))

  const codexContent = fs.readFileSync(codexSkillPath('chat'), 'utf8')
  assert.match(codexContent, /^name: deepsteve-chat$/m)
  assert.ok(!codexContent.includes('argument-hint:'))
  assert.ok(!codexContent.includes('$ARGUMENTS'))
  assert.ok(codexContent.includes('$deepsteve-chat'))
})

test('redundant enable is idempotent', async () => {
  const linkBefore = fs.lstatSync(codexLinkPath('chat'))
  const skillBefore = fs.statSync(codexSkillPath('chat'))
  assert.strictEqual((await postSkill('enable', 'chat')).ok, true)
  assert.strictEqual(fs.lstatSync(codexLinkPath('chat')).ino, linkBefore.ino)
  assert.strictEqual(fs.statSync(codexSkillPath('chat')).mtimeMs, skillBefore.mtimeMs)
})

test('enable repairs a stale DeepSteve skill link', async () => {
  fs.unlinkSync(codexLinkPath('chat'))
  fs.symlinkSync('/tmp/stale-deepsteve-skill', codexLinkPath('chat'))
  assert.strictEqual((await postSkill('enable', 'chat')).ok, true)
  assert.strictEqual(fs.readlinkSync(codexLinkPath('chat')), codexStorePath('chat'))
})

test('startup reconciliation restores enabled skill artifacts', async () => {
  await stopDaemon()
  fs.unlinkSync(claudeSkillPath('chat'))
  fs.unlinkSync(codexLinkPath('chat'))
  fs.writeFileSync(path.join(codexStorePath('chat'), 'SKILL.md'), 'stale\n')
  await startDaemon()

  assert.ok(fs.existsSync(claudeSkillPath('chat')))
  assert.strictEqual(fs.readlinkSync(codexLinkPath('chat')), codexStorePath('chat'))
  assert.match(fs.readFileSync(codexSkillPath('chat'), 'utf8'), /^name: deepsteve-chat$/m)
})

test('startup reconciliation removes disabled DeepSteve artifacts', async () => {
  await stopDaemon()
  const settings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'))
  settings.enabledSkills = []
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
  await startDaemon()

  assert.ok(!fs.existsSync(claudeSkillPath('chat')))
  assert.ok(!fs.existsSync(codexLinkPath('chat')))
  assert.ok(!fs.existsSync(codexStorePath('chat')))
})

test('disable removes both formats and is idempotent', async () => {
  assert.strictEqual((await postSkill('enable', 'terminal')).ok, true)
  assert.strictEqual((await postSkill('disable', 'terminal')).ok, true)
  assert.ok(!fs.existsSync(claudeSkillPath('terminal')))
  assert.ok(!fs.existsSync(codexLinkPath('terminal')))
  assert.ok(!fs.existsSync(codexStorePath('terminal')))
  assert.strictEqual((await postSkill('disable', 'terminal')).ok, true)
})

test('a DEEPSTEVE_HOME second instance leaves the real home\'s skills alone (#641)', async () => {
  // The incident. An agent verifying an unrelated change started a second daemon with
  // DEEPSTEVE_HOME pointed at a scratch dir but the ambient HOME inherited. stateDir()
  // honored the override; the skill destinations hung off os.homedir() and did not. So
  // that instance loaded empty scratch settings, concluded nothing was enabled, and its
  // boot reconcile deleted every managed skill out of ~/.claude/commands/deepsteve and
  // ~/.agents/skills — a home it did not own — while the real settings.json, untouched,
  // still listed all six as enabled.
  //
  // BOTH homes here are scratch dirs under this suite's mkdtemp: HOME plays the
  // developer's real home, isoHome plays the second instance's. Nothing in this test can
  // name an actual ~/.claude, which is the only way it is safe to write at all.
  assert.strictEqual((await postSkill('enable', 'autoresearch')).ok, true)
  assert.ok(fs.existsSync(claudeSkillPath('autoresearch')))
  assert.ok(fs.lstatSync(codexLinkPath('autoresearch')).isSymbolicLink())

  const isoHome = path.join(tmpRoot, 'iso')
  // Named <isoHome>/.deepsteve so the derived agent home is isoHome and the derived tmux
  // socket is the one TmuxSandbox.forHome(isoHome) reaps — the same "socket is a pure
  // function of the state dir" property the main daemon relies on (#625).
  const isoState = path.join(isoHome, '.deepsteve')
  const isoPort = await freePort()
  const env = { ...process.env, HOME, PORT: String(isoPort) }
  delete env.CLAUDECODE
  for (const key of Object.keys(env)) {
    if (key.startsWith('DEEPSTEVE_')) delete env[key]
  }
  env.DEEPSTEVE_HOME = isoState // set AFTER the strip — this is the whole point of the test

  let isoLog = ''
  const iso = spawn('node', ['server.js', '--test-mode', '--bind', '127.0.0.1'], { cwd: REPO_ROOT, env })
  iso.stdout.on('data', data => { isoLog += data.toString() })
  iso.stderr.on('data', data => { isoLog += data.toString() })
  try {
    // Wait for the listen line, not the reconcile line: reconcileSkills() runs BEFORE
    // app.listen(), so a daemon that is listening has provably finished reconciling.
    await waitFor(async () => isoLog.includes('HTTP server listening'), 'second instance startup')
  } finally {
    await new Promise(resolve => { iso.on('exit', resolve); iso.kill('SIGTERM') })
    try { TmuxSandbox.reapHome(isoHome) } catch (e) { console.error(e.message) }
  }

  // The artifacts in the home it does not own survive, in both formats.
  assert.ok(fs.existsSync(claudeSkillPath('autoresearch')),
    'second instance deleted the real home\'s Claude command — #641 has regressed')
  assert.ok(fs.lstatSync(codexLinkPath('autoresearch')).isSymbolicLink(),
    'second instance deleted the real home\'s Codex link — #641 has regressed')
  assert.ok(fs.existsSync(codexSkillPath('autoresearch')))

  // And it said, in its own log, which home it was managing and that it removed nothing.
  assert.ok(isoLog.includes(`Skills: managing ${isoHome}`), isoLog.slice(-2000))
  assert.match(isoLog, new RegExp(`Skills reconciled: 0 enabled, 0 installed, 0 removed \\(home: ${isoHome}\\)`))
  assert.ok(!isoLog.includes('Skill removed:'), isoLog.slice(-2000))
})

test('a user-owned non-symlink path is logged and never clobbered', async () => {
  const conflict = codexLinkPath('fork')
  fs.mkdirSync(conflict, { recursive: true })
  fs.writeFileSync(path.join(conflict, 'USER_FILE.md'), 'mine\n')

  assert.strictEqual((await postSkill('enable', 'fork')).ok, true)
  assert.ok(!fs.lstatSync(conflict).isSymbolicLink())
  assert.strictEqual(fs.readFileSync(path.join(conflict, 'USER_FILE.md'), 'utf8'), 'mine\n')
  assert.ok(fs.existsSync(claudeSkillPath('fork')))
  assert.ok(daemonLog.includes('exists and is not ours — leaving it alone'))

  assert.strictEqual((await postSkill('disable', 'fork')).ok, true)
  assert.ok(!fs.lstatSync(conflict).isSymbolicLink())
  assert.strictEqual(fs.readFileSync(path.join(conflict, 'USER_FILE.md'), 'utf8'), 'mine\n')
})
