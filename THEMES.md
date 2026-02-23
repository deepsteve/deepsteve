# Theming

deepsteve supports custom themes via CSS files. Themes are applied instantly in the browser without a page reload.

## Theme directory

Themes live at:

```
~/.deepsteve/themes/
```

The server creates this directory on startup if it doesn't exist. Each `.css` file in this directory is a theme. The filename (without `.css`) becomes the theme name shown in the settings UI.

## Creating a theme

Write a `.css` file to the themes directory that overrides CSS custom properties:

```css
/* ~/.deepsteve/themes/tokyo-night.css */
:root {
  --ds-bg-primary: #1a1b26;
  --ds-bg-secondary: #24283b;
  --ds-bg-tertiary: #414868;
  --ds-border: #565f89;
  --ds-text-primary: #a9b1d6;
  --ds-text-secondary: #565f89;
  --ds-text-bright: #c0caf5;
  --ds-accent-green: #9ece6a;
  --ds-accent-green-hover: #b5e890;
  --ds-accent-green-active: #73a94e;
  --ds-accent-red: #f7768e;
  --ds-accent-blue: #7aa2f7;
  --ds-accent-orange: #ff9e64;
  --ds-accent-green-soft: #9ece6a;
  --ds-selected-bg: #1f3a2e;
  --ds-btn-neutral: #414868;
  --ds-btn-neutral-hover: #565f89;
  --ds-btn-neutral-active: #343b58;
  --ds-overlay: rgba(0, 0, 0, 0.7);
  --ds-shadow: rgba(0, 0, 0, 0.5);
  --ds-reconnect-overlay: rgba(26, 27, 38, 0.75);
  --ds-reconnect-glow: rgba(255, 158, 100, 0.3);
}
```

You can also include arbitrary CSS rules beyond variables for deeper customization.

## Available CSS variables

| Variable | Default | Used for |
|---|---|---|
| `--ds-bg-primary` | `#0d1117` | Body, terminal, input fields, list backgrounds |
| `--ds-bg-secondary` | `#161b22` | Tab bar, modals, dropdown menus, context menus |
| `--ds-bg-tertiary` | `#21262d` | Tabs, buttons, list items, hover states |
| `--ds-border` | `#30363d` | All borders, also used for hover on secondary elements |
| `--ds-text-primary` | `#c9d1d9` | Body text, normal content |
| `--ds-text-secondary` | `#8b949e` | Muted text, labels, descriptions |
| `--ds-text-bright` | `#f0f6fc` | Headings, active tab text, bright highlights |
| `--ds-accent-green` | `#238636` | Primary buttons, focus borders, checkboxes |
| `--ds-accent-green-hover` | `#2ea043` | Primary button hover |
| `--ds-accent-green-active` | `#1a7f37` | Primary button active/pressed |
| `--ds-accent-red` | `#f85149` | Close buttons, delete, errors |
| `--ds-accent-blue` | `#58a6ff` | Tab badges, sidebar resizer highlight |
| `--ds-accent-orange` | `#f0883e` | Reconnecting border |
| `--ds-accent-green-soft` | `#3fb950` | Active session status indicator |
| `--ds-btn-neutral` | `#30363d` | Neutral buttons (e.g. wand/issue picker) |
| `--ds-btn-neutral-hover` | `#3d444d` | Neutral button hover |
| `--ds-btn-neutral-active` | `#272c33` | Neutral button active/pressed |
| `--ds-selected-bg` | `#1f3a2e` | Selected issue item background |
| `--ds-overlay` | `rgba(0,0,0,0.7)` | Modal backdrop |
| `--ds-shadow` | `rgba(0,0,0,0.4)` | Dropdown/context menu shadow |
| `--ds-reconnect-overlay` | `rgba(13,17,23,0.75)` | Reconnecting terminal overlay |
| `--ds-reconnect-glow` | `rgba(240,136,62,0.3)` | Reconnecting badge glow |

`--ds-bg-primary` also controls the xterm.js terminal background color.

## Activating a theme

Open **Settings** (gear icon in the tab bar) and select a theme from the **Theme** dropdown. The change applies immediately to all connected browser tabs.

You can also set it via API:

```bash
# Set a theme
curl -X POST http://localhost:3000/api/themes/active \
  -H 'Content-Type: application/json' \
  -d '{"theme": "tokyo-night"}'

# Reset to default
curl -X POST http://localhost:3000/api/themes/active \
  -H 'Content-Type: application/json' \
  -d '{"theme": null}'

# List available themes
curl http://localhost:3000/api/themes
```

## Live reload

The server watches `~/.deepsteve/themes/` with `fs.watch()`. When the **active** theme file is modified on disk, the server reads the updated CSS and broadcasts it to all connected browser tabs via WebSocket. Changes appear instantly — no page reload or manual action needed.

This means you can:

1. Set a theme as active (via settings UI or API)
2. Edit the `.css` file in any editor
3. See changes reflected in the browser immediately on save

This is designed so that Claude (or any agent) can write/modify theme files and see results in real time.

## Constraints

- Theme files must be `.css` files in `~/.deepsteve/themes/` (flat directory, no subdirectories)
- Maximum file size: 64KB per theme
- The active theme name is persisted in `~/.deepsteve/settings.json` and survives restarts
