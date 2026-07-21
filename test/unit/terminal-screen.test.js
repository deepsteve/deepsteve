const { test } = require('node:test')
const assert = require('node:assert')

const { TerminalScreen } = require('../../terminal-screen')
const { CODEX_TUI_CHUNKS } = require('./fixtures/codex-tui')

test('Codex full-screen redraws resolve to one stable current frame', async () => {
  const screen = new TerminalScreen({ cols: 80, rows: 12 })
  for (const chunk of CODEX_TUI_CHUNKS) screen.write(chunk)

  const lines = await screen.lines(40)
  const text = lines.join('\n')

  assert.deepStrictEqual(lines, [
    'OpenAI Codex  github-issue-595',
    '',
    '\u203a Make read_session_screen reliable',
    '',
    '\u2022 Working (2s \u2022 esc to interrupt)',
    '  \u21b3 Interpreting terminal state',
    '',
    '\u203a Add regression coverage',
    '',
    '? for shortcuts                         95% context left',
  ])
  assert.strictEqual((text.match(/Working/g) || []).length, 1)
  assert.doesNotMatch(text, /Working \(1s|Reading raw scrollback/)
  assert.doesNotMatch(text, /\x1b|\[0 q/)
  screen.dispose()
})

test('CSI parameter and intermediate bytes can cross PTY chunks without leaking', async () => {
  const screen = new TerminalScreen({ cols: 40, rows: 4 })
  screen.write('before\x1b[0')
  screen.write(' qafter\x1b[2;1Hsecond')

  assert.deepStrictEqual(await screen.lines(4), ['beforeafter', 'second'])
  screen.dispose()
})

test('plain terminal output keeps interpreted scrollback behavior', async () => {
  const screen = new TerminalScreen({ cols: 40, rows: 4 })
  for (let i = 0; i < 8; i++) screen.write(`plain-${i}\r\n`)

  assert.deepStrictEqual(await screen.lines(3), ['plain-5', 'plain-6', 'plain-7'])
  screen.dispose()
})

test('Claude-style colors and in-place prompt updates remain readable', async () => {
  const screen = new TerminalScreen({ cols: 60, rows: 6 })
  screen.write(
    '\x1b[2J\x1b[H\x1b[1mClaude Code\x1b[0m\r\n' +
    '\r\n\x1b[35m>\x1b[0m draft prompt\r\n' +
    'ready',
  )
  screen.write('\x1b[3;1H\x1b[2K\x1b[35m>\x1b[0m final prompt')

  assert.deepStrictEqual(await screen.lines(6), [
    'Claude Code',
    '',
    '> final prompt',
    'ready',
  ])
  screen.dispose()
})

test('resize preserves readable content and applies the new width', async () => {
  const screen = new TerminalScreen({ cols: 12, rows: 4 })
  screen.write('interpreted' + String.fromCharCode(13, 10) + 'terminal')
  await screen.lines(4)
  screen.resize(30, 4)
  screen.write(String.fromCharCode(13, 10) + 'width-after-resize-is-wide')
  assert.deepStrictEqual(await screen.lines(4), ['interpreted', 'terminal', 'width-after-resize-is-wide'])
  screen.dispose()
})
