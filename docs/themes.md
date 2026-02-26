# Themes Guide

Themes let you customize deepsteve's appearance by overriding CSS custom properties.

## Using Themes

1. Place `.css` files in `~/.deepsteve/themes/`
2. Open the settings panel (gear icon in the toolbar)
3. Select your theme from the dropdown

Theme files are limited to 64KB. Changes are picked up via `fs.watch()` — edits to the active theme apply immediately without a page refresh.

## Creating a Theme

A theme file overrides any of the 25 CSS custom properties defined in `:root`. You don't need to override all of them — only the ones you want to change.

### Background & Surface Colors

| Variable | Default | Description |
|---|---|---|
| `--ds-bg-primary` | `#0d1117` | Main background, terminal background |
| `--ds-bg-secondary` | `#161b22` | Tab bar, secondary surfaces |
| `--ds-bg-tertiary` | `#21262d` | Hover states, input fields |
| `--ds-selected-bg` | `#1f3a2e` | Selected/active tab background |

### Border & Text

| Variable | Default | Description |
|---|---|---|
| `--ds-border` | `#30363d` | Borders and dividers |
| `--ds-text-primary` | `#c9d1d9` | Main text color |
| `--ds-text-secondary` | `#8b949e` | Muted/secondary text |
| `--ds-text-bright` | `#f0f6fc` | High-emphasis text |

### Accent Colors

| Variable | Default | Description |
|---|---|---|
| `--ds-accent-green` | `#238636` | Primary action buttons |
| `--ds-accent-green-hover` | `#2ea043` | Button hover state |
| `--ds-accent-green-active` | `#1a7f37` | Button active/pressed state |
| `--ds-accent-green-soft` | `#3fb950` | Subtle green highlights |
| `--ds-accent-red` | `#f85149` | Destructive actions, errors |
| `--ds-accent-blue` | `#58a6ff` | Links, informational highlights |
| `--ds-accent-orange` | `#f0883e` | Warnings, attention states |

### Buttons

| Variable | Default | Description |
|---|---|---|
| `--ds-btn-neutral` | `#30363d` | Neutral button background |
| `--ds-btn-neutral-hover` | `#3d444d` | Neutral button hover |
| `--ds-btn-neutral-active` | `#272c33` | Neutral button active |

### Overlays & Shadows

| Variable | Default | Description |
|---|---|---|
| `--ds-overlay` | `rgba(0, 0, 0, 0.7)` | Modal backdrop |
| `--ds-shadow` | `rgba(0, 0, 0, 0.4)` | Drop shadows |
| `--ds-reconnect-overlay` | `rgba(13, 17, 23, 0.75)` | Reconnecting overlay |
| `--ds-reconnect-glow` | `rgba(240, 136, 62, 0.3)` | Reconnecting glow effect |
| `--ds-refresh-glow` | `rgba(88, 166, 255, 0.3)` | Refresh glow effect |

### Terminal Background Sync

The xterm.js terminal background automatically syncs to `--ds-bg-primary`. When a theme changes, `updateTerminalTheme()` reads the computed value and applies it to the terminal instance — no page refresh needed.

## Example: retro-monitor.css

The built-in retro theme demonstrates how to go beyond simple color changes. It adds a CRT monitor bezel effect using body padding and inset shadows:

```css
:root {
  --ds-bg-primary: #0a0a0a;
  --ds-bg-secondary: #2a2a2a;
  --ds-bg-tertiary: #3a3a3a;
  --ds-border: #555;
  --ds-text-primary: #d0d0d0;
  --ds-text-secondary: #999;
  --ds-text-bright: #fff;
}

/* Give tabs room to clear the rounded top corners */
#tabs {
  padding-top: 10px !important;
  padding-left: 16px !important;
  padding-right: 16px !important;
}

/* 90s CRT monitor bezel.
 *
 * Base CSS sets body to height:100vh, overflow:hidden, box-sizing:border-box.
 * Adding padding shrinks the content area. #app-container base has height:100vh
 * so we override to flex:1 to fill remaining space. All shadows must be inset
 * since body overflow:hidden clips anything outside. */
body {
  background: #c8c0b8 !important;
  display: flex !important;
  flex-direction: column !important;
  padding: 12px 25px 25px 25px;
}

#app-container {
  flex: 1 !important;
  min-height: 0 !important;
  height: auto !important;
  border-radius: 18px;
  overflow: clip;
  border: 4px solid #999;
  box-shadow:
    inset 0 0 0 2px #777,
    inset 0 0 8px rgba(0,0,0,0.3);
}
```

Key techniques:

- **Body padding** creates the bezel — because `box-sizing: border-box` is set, padding shrinks the content area rather than expanding the page.
- **`#app-container { flex: 1 }`** overrides the default `height: 100vh` so the container fills the remaining space after padding.
- **Inset shadows only** — `body` has `overflow: hidden`, so any outset shadows or elements outside the viewport are clipped.
- **`border-radius` on `#app-container`** rounds the screen corners. Use `overflow: clip` to ensure child content is clipped to the radius.

## Tips

- Use `!important` for non-variable overrides (e.g. `body { background: red !important; }`) since the base stylesheet uses specific selectors.
- All shadows must be `inset` — `body` has `overflow: hidden`, so outset shadows are invisible.
- When adding `body` padding, override `#app-container` height from `100vh` to `flex: 1` so the content still fills the viewport.
- A minimal theme only needs a `:root` block with color overrides — no structural CSS required.
