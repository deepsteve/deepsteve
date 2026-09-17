#!/usr/bin/env node
// Fly TikTok's phone bridge: the app talks to it over HTTP on this machine, and it reaches the
// iPhone over its USB cable. Start it with fly.mjs; ../README.md says how to set up the phone.
//
//   GET  /events                    server-sent events: screen, usb, armed, frame, swiped, task, error
//   GET  /screen                    the phone as MJPEG, for an <img>
//   POST /swipe?direction=up|down   a real touch on the phone, through WebDriverAgent
//   POST /arm, POST /disarm         let swipes through, or refuse them
//   GET  /status
//
//   node phone-usb.mjs [--port 3717] [--armed] [--wda http://127.0.0.1:8100] [--no-audio]
//
// The Mac synthesizes no input. WebDriverAgent runs on the phone as a UI test and injects genuine
// touches through XCTest, the only sanctioned way to touch iOS, so no pointer moves, no keystrokes
// or focus changes happen here, and nothing can leak into another app. (Synthesizing a trackpad
// scroll into iPhone Mirroring was tried first: the same gesture, byte for byte, sometimes pages
// the feed and sometimes leaves it held mid-scroll.)
//
// Two things have to be running, both over USB:
//   1. WebDriverAgent on the phone, from Xcode, signed with your own Apple ID.
//   2. A forwarder so this machine can reach it: iproxy 8100 8100 (libimobiledevice).
// This starts iproxy itself when it can find one.
//
// Deep Steve only serves this file with the app; it never runs it. Only pages on this machine may
// call it.

import { execFile, execFileSync, spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { allowedOrigin, jpegSplitter } from './phone-bridge-lib.mjs';
import { createTaskClock, formatDuration } from './task-clock.mjs';

const STILL_MOTION = 0.002; // as brain.js: below this the screen isn't moving
const { values: opts } = parseArgs({
  options: {
    port: { type: 'string', default: '3717' },
    armed: { type: 'boolean', default: false },
    wda: { type: 'string', default: 'http://127.0.0.1:8100' },
    'no-audio': { type: 'boolean', default: false }, // don't play the phone's sound on this Mac
  },
});

const source = fileURLToPath(new URL('phone-usb-helper.swift', import.meta.url));
const buildDir = fileURLToPath(new URL('.build/', import.meta.url));
// The helper lives in an app bundle. macOS treats the phone's screen as a camera, and only puts
// up the camera prompt for something it can name: a bare binary that wasn't launched from a
// terminal asks, gets no prompt, and gets no frames, silently.
// Without a usage description in the bundle, macOS kills the app outright when it asks.
const app = `${buildDir}PhoneUSBHelper.app/`;
const binary = `${app}Contents/MacOS/phone-usb-helper`;
const mtime = path => { try { return statSync(path).mtimeMs; } catch { return 0; } };
if (mtime(binary) < mtime(source)) {
  console.log('building phone-usb-helper…');
  mkdirSync(`${app}Contents/MacOS/`, { recursive: true });
  writeFileSync(`${app}Contents/Info.plist`, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>phone-usb-helper</string>
  <key>CFBundleIdentifier</key><string>com.deepsteve.fly-tiktok.phone-usb-helper</string>
  <key>CFBundleName</key><string>Phone USB Helper</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSCameraUsageDescription</key><string>The phone's screen, over the USB cable, counts as a camera.</string>
  <key>NSMicrophoneUsageDescription</key><string>The phone's sound, over the USB cable, counts as a microphone.</string>
</dict></plist>
`);
  execFileSync('swiftc', ['-O', source, '-o', binary], { stdio: 'inherit' });
  // Signed ad hoc, which needs no certificate. macOS ties the camera and microphone permissions to
  // the signature, so it asks again only after the helper is rebuilt, when this source changes.
  execFileSync('codesign', ['-s', '-', '-f', app.replace(/\/$/, '')], { stdio: 'inherit' });
}

const clients = new Set();
const viewers = new Set();
let armed = opts.armed;
let device = null;       // the phone, when the cable is in
let screen = null;       // its video size, in pixels
let wdaReady = false;    // WebDriverAgent answering on the other end of the cable
let session = null;      // its session id, and the phone's size in points
let lastFrame = null;
let latestJpeg = null;
let movedAt = Date.now();
let lastError = null;
let frames = 0;
let videoFrames = 0;
let swipes = 0;
let refused = 0;

const send = line => { for (const res of clients) res.write(`data: ${line}\n\n`); };
const log = message => console.log(`${new Date().toLocaleTimeString()} ${message}`);
const fail = message => {
  lastError = { message, at: new Date().toISOString() };
  log(message);
  send(JSON.stringify({ type: 'error', message }));
};

// ---- The cable: the phone's screen ----

// Launched through LaunchServices, not spawned: macOS grants the camera (which the phone's screen
// is, to it) to an app it launched itself, and judges a child by whatever started its parent. So
// the helper gets no pipes; it calls back here on a socket, with two connections that each
// announce themselves with a byte: "j" carries JSON lines, "v" the JPEGs.
const socketPath = `${buildDir}phone-usb-helper.sock`;
const helper = { json: null, video: null };
rmSync(socketPath, { force: true });
const helperServer = createSocketServer(conn => {
  conn.once('data', first => {
    conn.pause();
    conn.unshift(first.subarray(1));
    const tag = String.fromCharCode(first[0]);
    if (tag === 'j') attachJson(conn);
    else if (tag === 'v') attachVideo(conn);
    else conn.destroy();
  });
});
helperServer.listen(socketPath, () => {
  const helperArgs = ['--socket', socketPath, ...(opts['no-audio'] ? ['--no-audio'] : [])];
  execFile('open', ['-n', '-a', app.replace(/\/$/, ''), '--args', ...helperArgs], err => {
    if (err) {
      log(`couldn't launch the helper: ${err.message}`);
      process.exit(1);
    }
  });
});
const helperTimeout = setTimeout(() => {
  log('the helper never called back (is .build/PhoneUSBHelper.app next to phone-usb.mjs intact?)');
  process.exit(1);
}, 20000);

function attachJson(conn) {
  helper.json = conn;
  clearTimeout(helperTimeout);
  conn.resume(); // paused by hand above, so a listener alone won't restart it
  conn.on('close', () => {
    log('phone-usb-helper went away');
    saveTask();
    process.exit(1);
  });
  createInterface({ input: conn }).on('line', line => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === 'screen') {
      screen = { w: msg.w, h: msg.h };
      if (device) device = { ...device, w: msg.w, h: msg.h };
      log(`the phone's screen is ${msg.w}×${msg.h}`);
      send(JSON.stringify(usbState()));
    } else if (msg.type === 'device') {
      device = msg.device;
      if (!device) {
        latestJpeg = null;
        session = null;
        screen = null;
      }
      log(device ? `${device.name} on the cable` : 'no phone on the cable');
      send(JSON.stringify(usbState()));
    } else if (msg.type === 'frame') {
      lastFrame = msg;
      frames++;
      if (msg.motion > STILL_MOTION) movedAt = Date.now();
    } else if (msg.type === 'error') {
      lastError = { message: msg.message, at: new Date().toISOString() };
      log(`helper: ${msg.message}`);
    }
  send(line);
  });
}

function attachVideo(conn) {
  helper.video = conn;
  conn.resume();
  conn.on('data', jpegSplitter(jpeg => {
    latestJpeg = jpeg;
    videoFrames++;
    for (const res of viewers) sendJpeg(res, jpeg);
  }));
}

// ---- The cable: touching the phone ----

// iproxy carries a port over USB. Without it nothing on this machine can reach WebDriverAgent.
function startForwarder() {
  for (const tool of ['iproxy', '/opt/homebrew/bin/iproxy', '/usr/local/bin/iproxy']) {
    try {
      const child = spawn(tool, ['8100', '8100'], { stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      log(`forwarding port 8100 over USB with ${tool}`);
      return child;
    } catch { /* try the next one */ }
  }
  log('no iproxy found: install libimobiledevice, or forward port 8100 yourself, or WebDriverAgent can\'t be reached');
  return null;
}
const forwarder = startForwarder();

async function wda(path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  const res = await fetch(opts.wda + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { value: text }; }
  if (!res.ok) throw new Error(parsed?.value?.message ?? `WebDriverAgent said ${res.status}`);
  return parsed;
}

// One session, reused, remade when the phone or the agent restarts. Made as soon as the agent is
// up, so the fly's first swipe doesn't wait for it; concurrent callers share the one attempt.
let sessionStarting = null;
function ensureSession() {
  if (session) return Promise.resolve(session);
  sessionStarting ??= startSession().finally(() => { sessionStarting = null; });
  return sessionStarting;
}

async function startSession() {
  // By default XCTest waits for the app to go idle before every action, and TikTok, playing a
  // video, never does: a session took over 40 s to start and a swipe timed out waiting. These are
  // WebDriverAgent's own capability names (FBCapabilities.m, FBSettings.m).
  const capabilities = { shouldWaitForQuiescence: false, waitForIdleTimeout: 0, eventloopIdleDelaySec: 0 };
  const started = await wda('/session', { method: 'POST', body: { capabilities: { alwaysMatch: capabilities } }, timeoutMs: 60000 });
  const id = started.sessionId ?? started.value?.sessionId;
  if (!id) throw new Error('WebDriverAgent gave no session');
  // Before touching the screen, WebDriverAgent asks XCTest for a snapshot of the app in front, to
  // find its frame. TikTok's full accessibility tree took about a minute to snapshot, every time,
  // so every swipe timed out; one level deep is enough for a frame and took 55 ms. Measured on
  // /window/size, which goes through the same snapshot.
  await wda(`/session/${id}/appium/settings`, {
    method: 'POST',
    body: { settings: { snapshotMaxDepth: 1, waitForIdleTimeout: 0, animationCoolOffTimeout: 0 } },
  });
  // The system app's frame, not the active app's: right after the agent starts, the active app is
  // its own runner, which reports a 320×480 legacy frame, and a swipe in those coordinates lands
  // in the top corner of the real screen.
  const screen = await wda(`/session/${id}/wda/screen`, { timeoutMs: 30000 });
  const size = screen.value?.screenSize ?? (await wda(`/session/${id}/window/size`)).value;
  session = { id, w: size.width, h: size.height };
  log(`WebDriverAgent session on a ${session.w}×${session.h} pt screen`);
  return session;
}

// A real flick, in the phone's own coordinates: up the middle, left of TikTok's buttons. A touch
// that barely rests, moves fast and lifts without holding, which iOS reads as a fling, so the feed
// pages the way it does under a thumb.
async function swipe(direction) {
  const s = await ensureSession();
  const x = Math.round(s.w * 0.4);
  const near = Math.round(s.h * 0.72);
  const far = Math.round(s.h * 0.28);
  const up = direction !== 'down';
  await wda(`/session/${s.id}/wda/pressAndDragWithVelocity`, {
    method: 'POST',
    body: {
      fromX: x, fromY: up ? near : far,
      toX: x, toY: up ? far : near,
      pressDuration: 0.05, // longer and iOS reads a press-and-drag, not a flick
      velocity: 2500,      // points a second
      holdDuration: 0,     // lift while still moving
    },
  });
}

// Is the agent there? Checked on a timer so the page can say so before anything is asked of it.
let locked = null; // a locked phone sends no frames and takes no swipes; auto-lock does it quietly
async function pollWda() {
  let ready = false;
  try {
    const status = await wda('/status');
    ready = Boolean(status.value?.ready ?? true);
  } catch { ready = false; }
  let nowLocked = null;
  if (ready) {
    try { nowLocked = Boolean((await wda('/wda/locked')).value); } catch { /* unknown */ }
  }
  if (nowLocked !== locked) {
    locked = nowLocked;
    if (locked !== null) log(locked ? 'the phone is locked: unlock it' : 'the phone is unlocked');
    send(JSON.stringify(usbState()));
  }
  if (ready !== wdaReady) {
    wdaReady = ready;
    if (!ready) session = null;
    log(ready ? 'WebDriverAgent is up' : 'WebDriverAgent is not reachable (start it from Xcode, and iproxy 8100 8100)');
    send(JSON.stringify(usbState()));
  }
  // Retried on this timer rather than tried once: the first attempt can land while iproxy is still
  // coming up, and fail with a reset connection.
  if (wdaReady && !session && !sessionStarting && Date.now() - sessionFailedAt > 10000) {
    ensureSession().catch(err => {
      sessionFailedAt = Date.now();
      log(`WebDriverAgent session failed, retrying in 10 s: ${err.message}`);
    });
  }
}
let sessionFailedAt = 0;
setInterval(pollWda, 2000);
pollWda();

// ---- What the page sees ----

// The phone drawn at a sensible size: its own aspect, 720 points tall, like the mirroring window.
function windowShape() {
  if (!device || !screen) return null;
  const h = 720;
  return { x: 0, y: 0, w: Math.round((h * screen.w) / screen.h), h };
}

// ---- Time on task ----

const taskFile = fileURLToPath(new URL('.run/time-on-task.json', import.meta.url));
const pages = new Map(); // the page's id → { res, visible }, one per open page
const taskClock = createTaskClock({ seconds: loadTaskSeconds() });
let taskSavedAt = 0;

function loadTaskSeconds() {
  try {
    return Number(JSON.parse(readFileSync(taskFile, 'utf8')).seconds) || 0;
  } catch {
    return 0;
  }
}

function saveTask() {
  const { seconds } = taskClock.snapshot();
  mkdirSync(fileURLToPath(new URL('.run/', import.meta.url)), { recursive: true });
  writeFileSync(`${taskFile}.tmp`, JSON.stringify({ seconds, updatedAt: new Date().toISOString() }) + '\n');
  renameSync(`${taskFile}.tmp`, taskFile); // never a half-written total
  taskSavedAt = Date.now();
}

function tickTask() {
  const before = taskClock.snapshot();
  const now = taskClock.tick({
    armed, device, wda: wdaReady, locked,
    pages: pages.size, visiblePages: [...pages.values()].filter(p => p.visible).length,
  });
  if (now.reason !== before.reason) log(now.counting ? `time on task counting, at ${formatDuration(now.seconds)}` : `time on task paused: ${now.reason}`);
  send(JSON.stringify({ type: 'task', ...now }));
  if (Date.now() - taskSavedAt > 10000) saveTask();
}
setInterval(tickTask, 1000);

function usbState() {
  return { type: 'usb', transport: 'usb', device, wda: wdaReady, locked, window: windowShape() };
}

function sendJpeg(res, jpeg) {
  if (res.writableLength > 4 * 1024 * 1024) return; // a slow viewer skips frames instead of queueing them
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
  res.write(jpeg);
  res.write('\r\n');
}

function setArmed(value) {
  if (armed !== value) log(value ? 'swipes ON: the page\'s swipes go to the phone' : 'swipes off');
  armed = value;
  send(JSON.stringify({ type: 'armed', armed }));
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const { origin } = req.headers;
  if (!allowedOrigin(origin)) return json(res, 403, { error: `origin ${origin} not allowed` });
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');
  }
  const url = new URL(req.url, 'http://bridge');

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    return res.writeHead(204).end();
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const hello = [{ type: 'armed', armed }, usbState(), { type: 'window', window: windowShape() }, { type: 'task', ...taskClock.snapshot() }];
    if (screen) hello.unshift({ type: 'screen', ...screen });
    for (const msg of hello) res.write(`data: ${JSON.stringify(msg)}\n\n`);
    clients.add(res);
    const page = url.searchParams.get('page');
    if (page) pages.set(page, { res, visible: url.searchParams.get('visible') !== '0' });
    req.on('close', () => {
      clients.delete(res);
      if (page && pages.get(page)?.res === res) pages.delete(page);
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/page') { // a page saying whether it can be seen
    const page = pages.get(url.searchParams.get('id'));
    if (page) page.visible = url.searchParams.get('visible') !== '0';
    return json(res, 200, { known: Boolean(page) });
  }
  if (req.method === 'POST' && url.pathname === '/task/reset') {
    const now = taskClock.reset();
    saveTask();
    log('time on task reset to 00:00:00');
    send(JSON.stringify({ type: 'task', ...now }));
    return json(res, 200, now);
  }
  if (req.method === 'GET' && url.pathname === '/screen') {
    res.writeHead(200, {
      'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
    });
    if (latestJpeg) sendJpeg(res, latestJpeg);
    viewers.add(res);
    req.on('close', () => viewers.delete(res));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/swipe') {
    const direction = url.searchParams.get('direction') ?? 'up';
    if (direction !== 'up' && direction !== 'down') return json(res, 400, { error: 'direction is up or down' });
    if (!armed) {
      refused++;
      return json(res, 423, { error: 'swipes are off (fly.mjs arm, or the switch in the app)' });
    }
    if (!device) return json(res, 409, { error: 'no phone on the cable' });
    if (!wdaReady) return json(res, 409, { error: 'WebDriverAgent is not running on the phone' });
    try {
      await swipe(direction);
      swipes++;
      log(`swiped ${direction} (${swipes})`);
      send(JSON.stringify({ type: 'swiped', direction, method: 'usb', t: Date.now() }));
      return json(res, 202, { direction, method: 'usb' });
    } catch (err) {
      session = null; // most likely it went away; the next swipe makes a new one
      fail(`swipe failed: ${err.message}`);
      return json(res, 502, { error: err.message });
    }
  }
  if (req.method === 'POST' && (url.pathname === '/arm' || url.pathname === '/disarm')) {
    setArmed(url.pathname === '/arm');
    return json(res, 200, { armed });
  }
  if (req.method === 'GET' && url.pathname === '/status') {
    return json(res, 200, {
      transport: 'usb', locked, armed, device, wda: wdaReady, window: windowShape(), screen,
      swipes, refused, frames, videoFrames, lastError, clients: clients.size, viewers: viewers.size,
      motion: lastFrame?.motion ?? null,
      audioDb: lastFrame?.audioDb ?? null, // the phone's sound level as it plays here; null: not playing
      task: taskClock.snapshot(), pages: pages.size, visiblePages: [...pages.values()].filter(p => p.visible).length,
      stillSeconds: lastFrame ? Math.round((Date.now() - movedAt) / 1000) : null,
    });
  }
  return json(res, 404, { error: 'no such thing' });
});

server.listen(Number(opts.port), '127.0.0.1', () => {
  log(`phone bridge (USB) on http://127.0.0.1:${opts.port}; swipes ${armed ? 'ON' : 'off (POST /arm)'}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    saveTask();
    helper.json?.destroy(); // its end closing is what ends the helper
    helper.video?.destroy();
    forwarder?.kill();
    process.exit(0);
  });
}
