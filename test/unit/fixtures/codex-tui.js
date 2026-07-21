const CODEX_TUI_CHUNKS = [
  '\x1b]0;Codex\x07\x1b[?1049h\x1b[?2026h\x1b[?25l\x1b[2J\x1b[H' +
    '\x1b[1;1H\x1b[2K\x1b[1mOpenAI Codex\x1b[0m  github-issue-595' +
    '\x1b[3;1H\x1b[2K\u203a Make read_session_screen reliable' +
    '\x1b[5;1H\x1b[2K\x1b[33m\u2022 Working (1s \u2022 esc to interrupt)\x1b[0m' +
    '\x1b[6;1H\x1b[2K  \u21b3 Reading raw scrollback' +
    '\x1b[8;1H\x1b[2K\u203a Add regression coverage' +
    '\x1b[10;1H\x1b[2K? for shortcuts                         95% context left' +
    '\x1b[0',
  ' q\x1b[?2026l',
  '\x1b[?2026h\x1b[5;1H\x1b[2K\x1b[36m\u2022 Working (2s \u2022 esc to interrupt)\x1b[0m' +
    '\x1b[6;1H\x1b[2K  \u21b3 Interpreting terminal state' +
    '\x1b[8;1H\x1b[2K\u203a Add regression coverage' +
    '\x1b[0 q\x1b[?25h\x1b[?2026l',
]

module.exports = { CODEX_TUI_CHUNKS }
