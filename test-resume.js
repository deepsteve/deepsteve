#!/usr/bin/env node
/**
 * Test: Claude Code session resume via --session-id / --resume
 *
 * 1. Spawn claude with --session-id, send a message containing a secret
 * 2. Wait for Claude to respond, then gracefully exit
 * 3. Spawn claude with --resume using the same session ID
 * 4. Ask Claude for the secret
 * 5. Verify the secret appears in the response
 *
 * Key insight: BEL (\x07) inside OSC sequences (e.g. ]0;title\x07) must be
 * ignored — only "standalone" BELs indicate Claude is waiting for input.
 */

const pty = require('node-pty');
const { randomUUID } = require('crypto');
const path = require('path');

const SECRET = 'PINEAPPLE-' + Math.random().toString(36).slice(2, 8).toUpperCase();
const SESSION_ID = randomUUID();
const CWD = process.argv[2] || process.cwd();
const USE_WORKTREE = process.argv.includes('--worktree');
const WORKTREE_NAME = 'test-resume-' + Date.now();

console.log('=== Claude Resume Test ===');
console.log(`Secret:     ${SECRET}`);
console.log(`Session ID: ${SESSION_ID}`);
console.log(`CWD:        ${CWD}`);
console.log(`Worktree:   ${USE_WORKTREE ? WORKTREE_NAME : 'none'}`);
console.log('');

function spawnClaude(args) {
  const shellCmd = `claude ${args.join(' ')}`;
  console.log(`[spawn] zsh -l -c "${shellCmd}"`);
  const env = { ...process.env };
  delete env.CLAUDECODE;
  return pty.spawn('zsh', ['-l', '-c', shellCmd], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: CWD,
    env
  });
}

/**
 * Check if a BEL in the data is "standalone" (not inside an OSC sequence).
 * OSC sequences look like: ESC ] ... BEL  or  \x9d ... BEL
 * A standalone BEL means Claude is waiting for input.
 */
function hasStandaloneBel(data) {
  let inOsc = false;
  for (let i = 0; i < data.length; i++) {
    const ch = data[i];
    const code = ch.charCodeAt(0);
    // ESC ] starts OSC
    if (code === 0x1b && i + 1 < data.length && data[i + 1] === ']') {
      inOsc = true;
      i++; // skip ]
      continue;
    }
    // 8-bit OSC
    if (code === 0x9d) {
      inOsc = true;
      continue;
    }
    // BEL
    if (code === 0x07) {
      if (inOsc) {
        inOsc = false; // BEL terminates the OSC
      } else {
        return true; // standalone BEL!
      }
    }
    // ST (ESC \) also terminates OSC
    if (code === 0x1b && i + 1 < data.length && data[i + 1] === '\\') {
      inOsc = false;
      i++;
    }
  }
  return false;
}

function waitForReady(shell, label) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let chunks = 0;
    const timeout = setTimeout(() => {
      const clean = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      console.log(`[${label}] Timed out waiting for ready after ${chunks} chunks. Clean buffer:\n${clean.slice(-1000)}`);
      reject(new Error(`${label}: timed out waiting for BEL`));
    }, 60000);

    const handler = (data) => {
      buffer += data;
      chunks++;
      if (chunks <= 10) {
        const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (clean) console.log(`[${label}] ready-chunk ${chunks}: ${clean.slice(0, 200)}`);
      }
      // Use any BEL (including OSC) — same as the deepsteve server does
      if (data.includes('\x07')) {
        clearTimeout(timeout);
        shell.removeListener('data', handler);
        console.log(`[${label}] BEL received after ${chunks} chunks`);
        resolve(buffer);
      }
    };
    shell.on('data', handler);
  });
}

function sendAndWaitForResponse(shell, message, label) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let chunks = 0;
    let belCount = 0;
    const timeout = setTimeout(() => {
      const clean = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
      console.log(`[${label}] Timed out after ${chunks} chunks, ${belCount} BELs. Clean buffer (last 2000):\n${clean.slice(-2000)}`);
      const controls = [...buffer].filter(c => c.charCodeAt(0) < 32).map(c => c.charCodeAt(0));
      console.log(`[${label}] Control chars seen: ${[...new Set(controls)].join(', ')}`);
      reject(new Error(`${label}: timed out waiting for response`));
    }, 120000);

    // Wait for 2nd BEL — first is title update after sending, second is after response
    const handler = (data) => {
      buffer += data;
      chunks++;
      if (chunks <= 15 || chunks % 20 === 0) {
        const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim();
        if (clean) console.log(`[${label}] chunk ${chunks}: ${clean.slice(0, 150)}`);
      }
      if (data.includes('\x07')) {
        belCount++;
        console.log(`[${label}] BEL #${belCount} at chunk ${chunks}`);
        if (belCount >= 2) {
          clearTimeout(timeout);
          shell.removeListener('data', handler);
          console.log(`[${label}] Response done (BEL #${belCount}) after ${chunks} chunks`);
          resolve(buffer);
        }
      }
    };
    shell.on('data', handler);

    console.log(`[${label}] Sending: ${message}`);
    // Ink's input-parser only recognizes Enter when \r arrives as its own
    // stdin read, so write text and \r separately.
    shell.write(message);
    setTimeout(() => {
      console.log(`[${label}] Sending \\r`);
      shell.write('\r');
    }, 1000);
  });
}

function killShell(shell, label) {
  return new Promise((resolve) => {
    shell.on('exit', () => {
      console.log(`[${label}] Exited`);
      resolve();
    });
    shell.kill();
  });
}

async function gracefulExit(shell, label) {
  return new Promise((resolve) => {
    let exited = false;
    shell.on('exit', () => {
      exited = true;
      console.log(`[${label}] Exited gracefully`);
      resolve();
    });

    // Send /exit and wait
    console.log(`[${label}] Sending /exit...`);
    shell.write('/exit');
    setTimeout(() => shell.write('\r'), 100);

    setTimeout(() => {
      if (!exited) {
        console.log(`[${label}] /exit timed out, sending Ctrl+C then /exit again...`);
        shell.write('\x03'); // Ctrl+C
        setTimeout(() => {
          if (!exited) {
            shell.write('/exit');
    setTimeout(() => shell.write('\r'), 100);
            setTimeout(() => {
              if (!exited) {
                console.log(`[${label}] Force killing`);
                shell.kill();
              }
            }, 5000);
          }
        }, 1000);
      }
    }, 10000);
  });
}

async function run() {
  // --- Phase 1: Create session and plant secret ---
  console.log('\n--- Phase 1: Create session, plant secret ---');
  const args1 = ['--session-id', SESSION_ID];
  if (USE_WORKTREE) args1.push('--worktree', WORKTREE_NAME);
  const shell1 = spawnClaude(args1);

  await waitForReady(shell1, 'phase1');
  console.log('[phase1] Claude is ready');

  const plantMsg = `Remember this secret code, I will ask you for it later: ${SECRET}. Just confirm you got it, nothing else.`;
  const response1 = await sendAndWaitForResponse(shell1, plantMsg, 'phase1');
  console.log('[phase1] Claude responded');

  const clean1 = response1.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').trim();
  console.log(`[phase1] Response preview: ${clean1.slice(-500)}`);

  // Check session was saved before exiting
  const sessionFile = path.join(
    process.env.HOME, '.claude', 'projects',
    CWD.replace(/\//g, '-').replace(/^-/, ''),
    SESSION_ID + '.jsonl'
  );
  const fs = require('fs');
  console.log(`[phase1] Session file exists before exit: ${fs.existsSync(sessionFile)}`);

  await gracefulExit(shell1, 'phase1');

  console.log(`[phase1] Session file exists after exit: ${fs.existsSync(sessionFile)}`);
  console.log('[phase1] Waiting 3s before resume...');
  await new Promise(r => setTimeout(r, 3000));

  // --- Phase 2: Resume session and ask for secret ---
  console.log('\n--- Phase 2: Resume session, ask for secret ---');
  const args2 = ['--resume', SESSION_ID];
  if (USE_WORKTREE) args2.push('--worktree', WORKTREE_NAME);
  const shell2 = spawnClaude(args2);

  await waitForReady(shell2, 'phase2');
  console.log('[phase2] Claude is ready (resumed)');

  const askMsg = `What was the secret code I told you to remember?`;
  const response2 = await sendAndWaitForResponse(shell2, askMsg, 'phase2');

  const clean2 = response2.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').trim();
  console.log(`[phase2] Response preview: ${clean2.slice(-500)}`);

  await gracefulExit(shell2, 'phase2');

  // --- Verify ---
  console.log('\n--- Verification ---');
  const found = clean2.includes(SECRET);
  if (found) {
    console.log(`PASS: Secret "${SECRET}" found in resumed session response`);
  } else {
    console.log(`FAIL: Secret "${SECRET}" NOT found in resumed session response`);
    console.log('Full clean response:');
    console.log(clean2);
  }

  process.exit(found ? 0 : 1);
}

run().catch(err => {
  console.error('Test failed with error:', err.message);
  process.exit(1);
});
