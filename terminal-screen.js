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

  // Scans BACKWARD from the end rather than translating the whole buffer and
  // slicing (#607). buffer.length is viewport + scrollback (up to
  // MAX_SCROLLBACK_LINES), so the old forward walk cost ~10k translateToString
  // calls regardless of `count` — far too expensive for the prompt-submission
  // poller, which reads one viewport every few hundred ms. Result is identical:
  // trailing blank rows are dropped, then the last `count` rows are returned
  // (interior blanks included).
  async lines(count) {
    await this.idlePromise
    if (this.disposed) return []
    const buffer = this.terminal.buffer.active
    const read = (i) => {
      const line = buffer.getLine(i)
      return line ? line.translateToString(true).replace(/\s+$/g, '') : ''
    }
    let last = buffer.length - 1
    while (last >= 0 && read(last) === '') last--
    if (last < 0) return []
    // A non-positive count meant slice(-0)/slice(0) before, i.e. "everything".
    const first = count > 0 ? Math.max(0, last - Math.trunc(count) + 1) : 0
    const lines = []
    for (let i = first; i <= last; i++) lines.push(read(i))
    return lines
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
