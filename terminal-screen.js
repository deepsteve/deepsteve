const { Terminal } = require('@xterm/headless')

const DEFAULT_COLS = 120
const DEFAULT_ROWS = 40
const MAX_SCROLLBACK_LINES = 10000

/**
 * Server-side terminal state used by read_session_screen.
 *
 * PTY output is a stream of terminal instructions, not a transcript. Feeding it
 * through the same emulator family as the browser preserves cursor movement,
 * erase operations, alternate-screen buffers, reflow, and complete CSI parsing.
 */
class TerminalScreen {
  constructor({ cols = DEFAULT_COLS, rows = DEFAULT_ROWS } = {}) {
    this.terminal = new Terminal({
      cols: positiveInt(cols, DEFAULT_COLS),
      rows: positiveInt(rows, DEFAULT_ROWS),
      scrollback: MAX_SCROLLBACK_LINES,
      allowProposedApi: true,
    })
    this.pendingWrites = 0
    this.idlePromise = Promise.resolve()
    this.resolveIdle = null
    this.disposed = false
  }

  write(data) {
    if (!data || this.disposed) return
    if (this.pendingWrites === 0) {
      this.idlePromise = new Promise((resolve) => {
        this.resolveIdle = resolve
      })
    }
    this.pendingWrites++
    this.terminal.write(data, () => {
      if (this.disposed) return
      this.pendingWrites--
      if (this.pendingWrites !== 0) return
      const resolve = this.resolveIdle
      this.resolveIdle = null
      resolve()
    })
  }

  resize(cols, rows) {
    if (this.disposed) return
    this.terminal.resize(
      positiveInt(cols, this.terminal.cols),
      positiveInt(rows, this.terminal.rows),
    )
  }

  async lines(count) {
    await this.idlePromise
    if (this.disposed) return []
    const buffer = this.terminal.buffer.active
    const lines = []
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (!line) continue
      lines.push(line.translateToString(true).replace(/\s+$/g, ''))
    }
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines.slice(-count)
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.pendingWrites = 0
    if (this.resolveIdle) this.resolveIdle()
    this.resolveIdle = null
    this.terminal.dispose()
  }
}

function positiveInt(value, fallback) {
  const parsed = Math.round(Number(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

module.exports = { TerminalScreen }
