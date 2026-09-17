#!/usr/bin/env node
// Runs Fly TikTok's phone bridge in the background and talks to it. See ../README.md.
//
//   node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs start       start the bridge, with swipes off
//   node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs stop        stop it
//   node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs status      the phone, WebDriverAgent, swipes, time on task
//   node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs arm         let the app's swipes through to the phone
//   node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs disarm      refuse them again
//   node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs log         the bridge's recent log
//   node ~/.deepsteve/mods/fly-tiktok/phone/fly.mjs reset-time  start time on task over from 00:00:00
//
// The switch in the app arms and disarms too. The bridge's PID, log and time on task are in .run/
// next to this file. Extra arguments to start go to the bridge, e.g. start -- --no-audio.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { formatDuration } from './task-clock.mjs';

const BRIDGE = 'http://127.0.0.1:3717';
const runDir = fileURLToPath(new URL('.run/', import.meta.url));
const pidFile = `${runDir}bridge.pid`;
const logFile = `${runDir}bridge.log`;
const wait = ms => new Promise(r => setTimeout(r, ms));

// The bridge's PID, if the recorded process is still a running bridge.
function runningPid() {
  if (!existsSync(pidFile)) return null;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    if (command.includes('phone-usb.mjs')) return pid;
  } catch { /* no such process */ }
  rmSync(pidFile, { force: true });
  return null;
}

async function call(path, method = 'GET') {
  const res = await fetch(BRIDGE + path, { method });
  return res.json();
}

async function status() {
  const pid = runningPid();
  if (!pid) return console.log('bridge: not running (fly.mjs start)');
  let s;
  try {
    s = await call('/status');
  } catch {
    return console.log(`bridge: process ${pid} is up but not answering yet (fly.mjs log)`);
  }
  const lines = [`bridge: running (pid ${pid}), swipes ${s.armed ? 'ON' : 'off (fly.mjs arm, or the switch in the app)'}`];
  lines.push(`phone: ${s.device ? `${s.device.name}, ${s.device.w}×${s.device.h}` : 'NOT on the cable (plug it in, unlock it, trust this Mac)'}`);
  lines.push(`WebDriverAgent: ${s.wda ? 'up' : 'NOT reachable (start it from Xcode; see the README)'}`);
  if (s.locked) lines.push('phone: LOCKED, so no frames and no swipes (unlock it; Auto-Lock → Never while recording)');
  if (s.stillSeconds !== null) lines.push(`screen still for ${s.stillSeconds} s`);
  if (s.device) lines.push(`phone sound: ${s.audioDb === null || s.audioDb === undefined ? 'not playing here' : `playing on this Mac, ${Math.round(s.audioDb)} dB`}`);
  lines.push(`page: ${s.clients ? 'connected' : 'not connected'}; swipes sent ${s.swipes}, refused while off ${s.refused}`);
  if (s.task) lines.push(`time on task: ${formatDuration(s.task.seconds)}, ${s.task.counting ? 'counting' : `paused (${s.task.reason})`}`);
  if (s.lastError) lines.push(`last helper error: ${s.lastError.message} (${s.lastError.at})`);
  console.log(lines.join('\n'));
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'start') {
  const pid = runningPid();
  if (pid) {
    console.log(`already running (pid ${pid})`);
  } else {
    mkdirSync(runDir, { recursive: true });
    const log = openSync(logFile, 'a');
    const bridge = fileURLToPath(new URL('phone-usb.mjs', import.meta.url));
    const args = rest.filter(a => a !== '--');
    const child = spawn(process.execPath, [bridge, ...args], { detached: true, stdio: ['ignore', log, log] });
    writeFileSync(pidFile, String(child.pid));
    child.unref();
    let up = false;
    for (let k = 0; k < 60 && !up; k++) { // up to 30 s: it may be building the helper first
      await wait(500);
      if (!runningPid()) {
        console.log('the bridge exited (fly.mjs log)');
        process.exit(1);
      }
      try { await call('/status'); up = true; } catch { /* not listening yet */ }
    }
  }
  await status();
} else if (command === 'stop') {
  const pid = runningPid();
  if (!pid) {
    console.log('not running');
  } else {
    process.kill(pid, 'SIGTERM'); // the helper exits when the bridge closes its stdin
    for (let k = 0; k < 30 && runningPid(); k++) await wait(100);
    rmSync(pidFile, { force: true });
    console.log('stopped');
  }
} else if (command === 'status') {
  await status();
} else if (command === 'arm' || command === 'disarm') {
  if (!runningPid()) {
    console.log('not running (fly.mjs start)');
    process.exit(1);
  }
  const { armed } = await call(`/${command}`, 'POST');
  console.log(`swipes ${armed ? 'ON' : 'off'}`);
} else if (command === 'reset-time') {
  if (!runningPid()) {
    console.log('not running (fly.mjs start)');
    process.exit(1);
  }
  const res = await fetch(`${BRIDGE}/task/reset`, { method: 'POST' });
  console.log(res.ok ? 'time on task: 00:00:00' : `reset failed (${res.status})`);
} else if (command === 'log') {
  console.log(existsSync(logFile) ? readFileSync(logFile, 'utf8').trimEnd().split('\n').slice(-40).join('\n') : 'no log yet');
} else {
  console.log('usage: node fly.mjs start|stop|status|arm|disarm|log|reset-time');
  process.exit(2);
}
