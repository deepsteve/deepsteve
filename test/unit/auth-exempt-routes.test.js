// The set of routes mounted ABOVE security.authGate is a security boundary, and it must not grow
// by accident.
//
// authGate is deliberately positional (server.js): registered before every inline /api route and
// before the async-mounted /mcp and mod routes, so everything below it is default-deny. Everything
// ABOVE it answers unauthenticated callers. That was two entries for a long time — the static
// handlers and /healthz — and #675 added a third, POST /api/client-log, because a beacon that
// reports "our cookie is broken" cannot itself require the cookie.
//
// Three is still small enough to enumerate, which is exactly why it is worth pinning now: the next
// route added just above the gate for convenience would be a silent auth bypass, and nothing in the
// tree would notice. Same source-scanning idiom as integration-scratch-guard.test.js (#637) and
// compose-projects.test.js (#616).
//
// Pure fs reads, so it runs in the bare `unit` CI job.
//
// Run: node --test test/unit/auth-exempt-routes.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..', 'server.js');

// Every route/middleware registration, in source order, up to the authGate mount.
function registrationsAboveTheGate() {
  const src = fs.readFileSync(SERVER, 'utf8');
  const gate = src.indexOf('app.use(security.authGate)');
  assert.notStrictEqual(gate, -1, 'authGate mount not found — this guard is scanning the wrong shape');
  const above = src.slice(0, gate);
  // app.get / app.post / app.use / app.all / app.delete / app.put / app.patch
  return [...above.matchAll(/^app\.(get|post|use|all|delete|put|patch)\(([^\n]*)/gm)]
    .map(m => ({ verb: m[1], line: m[0].trim() }));
}

test('the auth-exempt surface stays exactly what it is meant to be', async (t) => {
  const regs = registrationsAboveTheGate();

  await t.test('the scan is not vacuous', () => {
    // A broken regex or a moved gate would turn every assertion below into a silent pass.
    assert.ok(regs.length >= 4, `expected several registrations above the gate, found ${regs.length}`);
    assert.ok(regs.some(r => r.line.includes('security.hostGuard')),
      'hostGuard must be above the gate — it is the first defense');
    assert.ok(regs.some(r => r.line.includes('/healthz')),
      'the /healthz probe must be above the gate');
  });

  await t.test('only the intended endpoints answer unauthenticated callers', () => {
    // Route registrations (as opposed to bare middleware) that name a path above the gate.
    const routes = regs
      .filter(r => r.verb !== 'use')
      .map(r => {
        const m = /^app\.(\w+)\(\s*['"`]([^'"`]+)['"`]/.exec(r.line);
        return m ? `${m[1].toUpperCase()} ${m[2]}` : r.line;
      });
    assert.deepStrictEqual(routes.sort(), ['GET /healthz', 'POST /api/client-log'],
      'a new route above authGate is an unauthenticated endpoint — move it below the gate, or ' +
      'add it here deliberately with a comment saying why it must be exempt');
  });

  await t.test('the beacon is a POST route, never a path-mounted middleware', () => {
    // app.use('/api/client-log', ...) would exempt GET, HEAD and OPTIONS along with POST.
    const src = fs.readFileSync(SERVER, 'utf8');
    assert.ok(!/app\.use\(\s*['"`]\/api\/client-log/.test(src),
      'mounting the beacon with app.use would exempt every method, not just POST');
  });

  await t.test('the beacon checks Origin before it parses a body', () => {
    const src = fs.readFileSync(SERVER, 'utf8');
    const decl = /app\.post\(\s*'\/api\/client-log',\s*([^,]+),\s*express\.json/.exec(src);
    assert.ok(decl, 'expected: app.post(path, <origin guard>, express.json(...), handler)');
    assert.match(decl[1], /requireAllowedOrigin/,
      'Origin is the only thing gating this endpoint — it must run before we parse 8kb of JSON');
  });
});
