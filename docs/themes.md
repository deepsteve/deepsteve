# Themes Guide

Themes let you customize deepsteve's appearance by overriding CSS custom properties.

## Using Themes

1. Place `.css` files in `~/.deepsteve/themes/`
2. Open the settings panel (gear icon in the toolbar)
3. Select your theme from the dropdown

Theme files are limited to 64KB. Changes are picked up via `fs.watch()` — edits to the active theme apply immediately without a page refresh.

## Creating a Theme

A theme file overrides any of the CSS custom properties defined in `:root`. You don't need to override all of them — only the ones you want to change.

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

### Context Panel (the projects rail)

The rail's whole look is driven by these, so a theme can turn a flush square column into a
standalone bezelled panel without touching a rule. `retro-monitor` and `hacker-monitor` both do.

| Variable | Default | Description |
|---|---|---|
| `--ds-context-width` | `200px` | Resting width (a drag overrides it per window) |
| `--ds-context-bg` | `var(--ds-bg-secondary)` | Panel background |
| `--ds-context-border` | `1px solid var(--ds-border)` | Full shorthand, so a theme can set a thick bezel |
| `--ds-context-radius` | `0px` | Corner rounding; row inset/rounding is derived from it |
| `--ds-context-gap` | `0px` | Gap between the panel and the terminal |
| `--ds-context-shadow` | `none` | Panel shadow (inset works, for a CRT bezel) |
| `--ds-main-inset` | `none` | The **terminal** pane's matching inner shadow — see *Panel Edges* below |
| `--ds-main-radius` | `0px` | The terminal pane's corner rounding — set it here, not on `#app-main` |
| `--ds-main-frame` | `0px` | The width of that pane's border, so the inner shadow can follow it |

### Panel Edges

The app is one row: `[ #context-rail | #context-resizer | #app-main ]` — the projects panel
and the terminal side by side. Two rules keep them reading as halves of one thing.

**Frame both panes or neither.** The commonest theme bug is framing one side of that row and
leaving the other on the base default, which makes the projects panel look boxed next to a
borderless terminal (#690). Whenever you put a `border` on `#app-main` or `#app-container`,
decide what the rail's edge is in the same breath.

**An inset `box-shadow` on `#app-main` will not render.** An inset shadow paints *below*
descendant backgrounds, and every child of `#app-main` — `#tabs`, the xterm canvas,
`#panel-container` — is opaque, so it covers the shadow completely. The declaration looks
correct and draws nothing. Use `--ds-main-inset` instead: the base stylesheet paints it as an
`#app-main::after` overlay above the content.

**State `#app-main`'s rounding and border width as `--ds-main-radius` / `--ds-main-frame`,
not as declarations on the rule.** That overlay is positioned at `#app-main`'s *padding* box,
so its corners have to use the padding-box radius — the outer radius minus the border width.
It cannot read either number off the rule, and inheriting the outer radius makes it curve
tighter than the border's inner edge: the ring pulls away from the frame, leaving a gap that
widens to the full border width at each corner (4px of it in `retro-monitor`). Declare both
vars and let the base stylesheet derive the corner; write the border as
`border: var(--ds-main-frame) solid <colour>` so there is one number, not two.

The rail needs none of this — its highlight is a real `box-shadow` on the element, and an
inset shadow gets the padding-box corner for free. Only the overlay has to be told.

`test/unit/theme-pane-parity.test.js` enforces all three rules.

Two structural families exist in the shipped themes, and either is fine:

- **Two standalone panels** — the frame goes on `#app-main`, and the rail gets its own
  matching frame via `--ds-context-*` plus a `--ds-context-gap` so it reads as a separate
  unit (`retro-monitor`, `retro-monitor-dim`, `hacker-monitor`).
- **One window around both** — the frame goes on `#app-container`, and the two panes inside
  it get a matching lighter treatment (`ascii-art`'s single-line boxes, `win-95`'s sunken
  bevels).

### Context Panel Motion (#691)

The panel slides open and closed, and these four are the only timing tokens in the stylesheet —
everything else uses literals. The weight comes from the asymmetry (a longer decelerating open,
a shorter accelerating close), so retune both halves together.

| Variable | Default | Description |
|---|---|---|
| `--ds-context-anim-open` | `0.2s` | Open duration |
| `--ds-context-anim-close` | `0.15s` | Close duration |
| `--ds-context-ease-open` | `ease-out` | Open easing |
| `--ds-context-ease-close` | `ease-in` | Close easing |

**Setting both durations to `0s` opts a theme out of the motion entirely** — the panel then flips
the way it did before #691. Viewers who have asked their OS for reduced motion already get that,
whatever a theme sets.

### Terminal Background Sync

The xterm.js terminal background automatically syncs to `--ds-bg-primary`. When a theme changes, `updateTerminalTheme()` reads the computed value and applies it to the terminal instance — no page refresh needed.

## Example: retro-monitor.css

The built-in retro theme demonstrates how to go beyond simple color changes: a CRT monitor
bezel built from body padding, and a second standalone bezel for the projects rail beside it.

```css
:root {
  --ds-bg-primary: #0a0a0a;
  --ds-bg-secondary: #2a2a2a;
  --ds-bg-tertiary: #3a3a3a;
  --ds-border: #555;
  --ds-text-primary: #d0d0d0;
  --ds-text-secondary: #999;
  --ds-text-bright: #fff;

  /* The rail as its own CRT to the LEFT of the terminal: same bezel, same rounding,
     same inner highlight, plus a gap so it reads as a separate unit. */
  --ds-context-bg: #2a2a2a;
  --ds-context-border: 4px solid #999;
  --ds-context-radius: 18px;
  --ds-context-gap: 8px;
  --ds-context-shadow: inset 0 0 0 2px #777, inset 0 0 8px rgba(0,0,0,0.3);

  /* The terminal's half of that highlight. It CANNOT be a box-shadow on #app-main —
     see "Panel Edges" above. */
  --ds-main-inset: inset 0 0 0 2px #777, inset 0 0 8px rgba(0,0,0,0.3);

  /* ...and the frame it sits inside. Both stated here so the overlay can round at the
     padding box (18px - 4px) instead of pulling away from the border at the corners. */
  --ds-main-radius: 18px;
  --ds-main-frame: 4px;
}

/* Give tabs room to clear the rounded top corners. Horizontal only: in vertical mode
   #tabs is a sidebar, where this strip padding just eats 32px of its width. */
#app-container:not(.vertical-layout) #tabs {
  padding-top: 10px !important;
  padding-left: 16px !important;
  padding-right: 16px !important;
}

/* Base CSS sets body to height:100vh, overflow:hidden, box-sizing:border-box.
   Adding padding shrinks the content area. */
body {
  background: #1a1a1a !important;
  display: flex !important;
  flex-direction: column !important;
  padding: 12px 25px 25px 25px;
}

/* The outer row [ #context-rail | #app-main ] carries NO bezel, so the rail stays a
   separate panel. The gap between the two lives here, not as a rail margin, so the
   rail's top and bottom stay flush with the terminal. #app-container base has
   height:100vh, so override it to flex:1 to fill the space left by the padding. */
#app-container {
  flex: 1 !important;
  min-height: 0 !important;
  height: auto !important;
  gap: var(--ds-context-gap);
}

#context-rail { margin: 0 !important; }

/* #context-resizer is a flex sibling BETWEEN the two panels, so the gap above applies
   on both of its sides — a ~22px dead zone instead of one 8px seam. Cancel both. */
#context-resizer { margin: 0 calc(var(--ds-context-gap) * -1) !important; }

/* The bezel lives on #app-main (the terminal side) only. The rounding comes from
   --ds-main-radius via the base stylesheet; only the colour is decided here. */
#app-main {
  overflow: clip;
  border: var(--ds-main-frame) solid #999;
}
```

Key techniques:

- **Body padding** creates the bezel — because `box-sizing: border-box` is set, padding shrinks the content area rather than expanding the page.
- **`#app-container { flex: 1 }`** overrides the default `height: 100vh` so the container fills the remaining space after padding.
- **Inset shadows only** — `body` has `overflow: hidden`, so any outset shadows or elements outside the viewport are clipped.
- **`--ds-main-radius`** rounds the screen corners (never `border-radius` on `#app-main` — see **Panel Edges**). Use `overflow: clip` to ensure child content is clipped to the radius — that same clip trims the `--ds-main-inset` overlay to the inner rounded rect.
- **The frame goes on `#app-main`, never `#app-container`,** when the rail is meant to read as its own panel: `#app-container` is the row that holds *both*.

## Tips

- Use `!important` for non-variable overrides (e.g. `body { background: red !important; }`) since the base stylesheet uses specific selectors.
- All shadows must be `inset` — `body` has `overflow: hidden`, so outset shadows are invisible.
- When adding `body` padding, override `#app-container` height from `100vh` to `flex: 1` so the content still fills the viewport.
- A minimal theme only needs a `:root` block with color overrides — no structural CSS required. The moment it adds a `border` to `#app-main` or `#app-container`, though, it owes the rail a `--ds-context-border` too; see **Panel Edges**.
