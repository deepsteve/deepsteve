# Tasks app views

A view is one HTML file that draws the task list. The Tasks app shows it on the left and the
selected task's terminal on the right. The view decides how the tasks are laid out: a board, a
timeline, a 3D workspace, anything. The app handles selection, the terminal, and getting to a
session.

## Where views live

- **Built-in views** ship in this directory (`board.html`, `orbit.html`). Don't edit them here.
  They are overwritten on every deploy.
- **Custom views** live in `~/.deepsteve/tasks-app/views/<name>.html`. A custom view with a
  built-in's name replaces it. The app's **Reset** control deletes the custom file and brings the
  built-in back.
- A name is lowercase letters, digits and dashes: `board`, `by-project`, `galaxy-3d`.
- The app polls the file's mtime and reloads the view within about 2 seconds of a save.

## The API

The view runs in an iframe inside the app, on the same origin. It reaches the app through its
parent:

```js
const app = window.parent.taskApp;
```

| Call | What it does |
|---|---|
| `app.version` | `1` |
| `app.getTasks()` | The current task list (see the shape below). |
| `app.onTasks(cb)` | Calls `cb(tasks)` now and on every change. Returns an unsubscribe function. |
| `app.getSelected()` | The selected task's id, or `null`. |
| `app.select(id)` | Selects a task. The terminal pane follows. |
| `app.onSelect(cb)` | Calls `cb(id)` now and on every change. Returns an unsubscribe function. |
| `app.open(id)` | Goes to the task's terminal: jumps to a live session, reopens a closed one. Does nothing if the task has no session. |
| `app.setStatus(id, status)` | `'pending'`, `'in-progress'` or `'done'`. Returns a Promise. |
| `app.addTask({ title, description?, priority? })` | Creates a task. Resolves to the new task. |
| `app.setOrder(ids)` | Tells the app the order the view draws tasks in. `j`/`k` and ⌘↑/⌘↓ walk that order. Call it whenever the order changes. |
| `app.loadState()` | Resolves to whatever `saveState` last stored for this view, or `null`. |
| `app.saveState(value)` | Stores any JSON value for this view, on the server, so every window gets the same layout. Keep it under 100 KB. |
| `app.getProjects()` | `[{ id, name, dirs }]` for every project that is not archived. |

A task:

```js
{
  id: 12,
  title: 'Rotate the API key',
  description: '…',
  priority: 'low' | 'medium' | 'high',
  status: 'pending' | 'in-progress' | 'done',
  created: 1790000000000,                        // ms since epoch
  project: { id, name, dir } | null,             // derived from where its sessions ran
  sessions: [{ id, label, state, closedAt }],    // state: 'live' | 'closed' | 'saved' | 'gone'
}
```

## Rules

- **One self-contained file.** Inline the CSS and JS. Import libraries from a CDN, for example
  `https://esm.sh/three@0.160.0`.
- **Go through `app` for data.** Don't fetch `/api/tasks` yourself. The app already keeps the
  list current and handles auth.
- **Pick your own colours.** The host's theme variables don't reach a view. The app's background
  is `#0d1117`, text `#c9d1d9`, muted text `#8b949e`, borders `#30363d`, accent `#58a6ff`.
- **No `alert`, `confirm` or `prompt`.** The sandbox blocks them. Build the input into the page.
- **Keys.** The app listens on the view's window for `j`/`k`/`↑`/`↓` (move the selection),
  `Enter`/`o` (open the terminal) and ⌘\ (quiet mode), except while focus is in a text field. If
  the view uses one of those keys itself, call `e.preventDefault()` in its handler and the app
  leaves the keystroke alone.
- **Show the selection.** Highlight `app.getSelected()`, and select on click. A double-click that
  calls `app.open(id)` matches the built-in views.
- **Stay fast with many tasks.** A list can hold hundreds of done tasks. Collapse or cap them
  rather than drawing every one.
