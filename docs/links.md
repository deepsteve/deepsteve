# Links into Deep Steve (`/v1/<type>/<id>`)

A scheduled agent that runs unattended usually ends by emailing a report. When the report needs a
decision, the email carries a link, and the decision takes one click (#705). The link format is
not specific to decisions. It is how anything outside Deep Steve points at something inside it:

```
http://deepsteve.localhost:3000/v1/<type>/<id>
```

| Type | What it is | State |
|---|---|---|
| `decision` | A Workshop question: options, context, a recommendation | built |
| `markdown` | Structured text or notes | reserved: "not available yet" page (501) |
| `html` | A page an agent wrote | reserved: "not available yet" page (501) |

The type is in the link so the link says what it points at, and so one type can be removed without
touching the others. The version is in the link so the scheme can change later without breaking
links already sent.

The scheme lives in `links.js` at the repo root, mounted in `server.js` after the auth gate. It
knows nothing about storage: a mod registers a **provider** (`owns(id)`, `resolve(id)`, and
per-type `render`/`act` handlers), and the link format stays the same whatever the provider does.
Workshop's provider is in `mods/workshop/tools.js`, under "decision links".

## The four rules

1. **The stored item decides the type, not the link.** The provider resolves the id. A GET whose
   type doesn't match is redirected to the right link. A POST to the wrong type is refused (409
   with `location`), never re-aimed, because an answer must land where it was sent.
2. **A link that's been sent is a promise.** It opens, redirects, or explains itself for as long
   as it could still be in someone's inbox:
   - A **removed type answers 410** with a "this feature was removed" page. You remove a type by
     *moving* it from `TYPE_STATES` into `REMOVED_TYPES`, never by deleting its entry.
   - A decision that is no longer stored gets the "Nothing found" page, worded to cover both
     "cleared out" and "belongs to another computer".
   - Moving to `v2`, or dropping the prefix, must keep `v1` redirecting.
3. **Ids are never reused, and never chosen by an agent.** A Workshop item's id is a random UUID
   minted by the server. It isn't a short sequential ticket (`w18`), which an agent could guess or
   assume and which a wiped store would reissue. Items stored before #705 keep the `w<n>` ids they
   were minted with, and their links still resolve.
4. **Answers go to the same versioned address** (`POST /v1/decision/<id>`), and POST runs the same
   decision as GET. A removed version or type therefore cannot be answered.

## How a request is decided

`decide()` is pure and every branch is pinned in `test/unit/links.test.js`. The checks run in this
order:

| # | Condition | Answer |
|---|---|---|
| 1 | type is in `REMOVED_TYPES` | 410 page, checked before resolution |
| 2 | type unknown | 404 page |
| 3 | malformed id | 404 page |
| 4 | no provider owns the id | 503 while none has registered (mods mount asynchronously), otherwise 404 |
| 5 | `resolve` returns null / `{ gone }` / `{ type: null }` | 404 / 410 / 404 "not something a link can open" |
| 6 | resolved type ≠ link type | GET 302, POST 409 |
| 7 | reserved type | 501 page |
| 8 | the owner has no handler for this type and method | 503 |

In step 5, `{ gone }` is for a provider that can tell a cleared item from one it never issued.
Workshop's random ids can't, so a missing Workshop item is null.

GET only ever calls `render`, and POST only ever calls `act`. Every `/v1` response is
`Cache-Control: no-store` and carries a CSP with `script-src 'self'`, `frame-ancestors 'none'`,
and no remote images. That last part stops a question from doubling as a tracking pixel.

## Safety rules

- **Opening a link never changes anything.** Link previews and prefetchers open links too. The
  decision page computes "expired" at render time instead of sweeping, so even that writes nothing.
- **Answering takes a POST behind the auth gate plus `requireAllowedOrigin`.** A missing or
  foreign Origin is a 403, even with a valid cookie. By that point the request is authenticated,
  so the Origin check isn't auth. It only proves the request came from the button on our own page.
- **An item is answered once.** A second click gets the existing 409 along with the recorded
  answer.
- **`html` items, when built, render isolated.** They get an iframe sandbox *without*
  `allow-same-origin` and no `window.deepsteve` bridge, so a page opened from a link cannot act as
  the user. That is deliberately stricter than display tabs and project mods, whose pages can.

## Signing in from a link

The auth cookie is `SameSite=Strict`, so a link clicked in webmail (a cross-site navigation)
arrives **without** it, even for a user who is signed in. For a GET with `Accept: text/html` on a
loopback host under `/v<n>/`, `authGate` answers that 401 with a small HTML page (the "link
bounce" in `security.js`) instead of `Unauthorized`:
- `setAuthCookie` has already put the token on that same response.
- The page reloads itself once. That reload starts from our own origin, so the cookie is sent.
- A per-path `sessionStorage` stamp allows one reload in 10 seconds. A browser that refuses the
  cookie gets "open Deep Steve once, then open the link again" instead of a loop.
- The page script is pinned by a CSP hash.
- Every other gated path keeps the text/plain 401 that `api-fetch.js` and `auth-heal.js` expect.

The bounce changes what the rejection says, never who is authorized, and nothing was added above
the gate (`test/unit/auth-exempt-routes.test.js` still pins that set).

## The `decision` type

`workshop_ask` returns `{ id, url, message }`, and the agent puts `url` in its email. The page shows
the question, its context and the recommendation, with:
- one button per option, showing the option's `then` when it has one
- an optional note
- **Discuss**

It is `mods/workshop/decision-page.js` and `decision-page.css`, served from `/mods` like any mod
file. Agent text reaches the DOM only as `textContent` or as elements built from `markdown.js`'s
AST.

**A durable question** (`durable_days: N`, at most 30):
- isn't dismissed when its session goes; it expires after N days instead (`durableUntil`)
- once closed, it is kept in its own retention bucket, so a busy inbox can't evict an answer the
  next run hasn't read yet

**Grouping answers by job.** A question asked from a scheduled run records the task that asked
(`scheduledTaskId`). Scheduled tasks stamp it on the run's session, it is persisted across
restarts, and the agent never names it. There is deliberately no agent-chosen tag: two jobs that
picked the same word would read each other's answers.

**What happens when an option is clicked:**

| Asker state | Delivery | `deliveredVia` |
|---|---|---|
| holding in `workshop_ask` (`wait_seconds`) | resolves the pending call | `inline` |
| still running | typed into it through the prompt FIFO | `prompt` |
| gone, and the option has `then` | new session in the asker's **project root** (no worktree), with the asker's agent and config profile, prompted with the question, context, the choice, the note, `then`, and the closing instructions below | `then` (plus `followUpSessionId`) |
| gone, no `then` | recorded only, readable with `workshop_answers` | `undelivered` |

**A follow-up closes itself.** A `then` session is a one-shot, not a tab someone has to find and
close. Its prompt ends with:
1. report the outcome with `workshop_brief`, so the report outlives the session, and tell anyone
   else the instruction names
2. call `close_session` with no arguments, as its very last action
3. if it can't finish without the human, say so and stay open instead

This is a prompt, not a timer, on purpose. The existing auto-close only waits while a session is
**busy**, and a follow-up sitting on a permission prompt reads as idle: a timer would close
exactly the session still waiting on a human. Because the follow-up closes itself, `then` should be
written as a complete action ("file the issue, then start_issue it"), not the opening of a
conversation.

**Discuss** changes nothing about the item, and its session stays open, because you are talking
in it:
- If the asker is **live**, it sends a `repair` + `focus` open-session, which brings the existing
  tab forward.
- If the asker is **restorable** (a saved record whose cwd exists), it sends an open-session with
  `restore: true`. This is the one server push the browser treats as an explicit restore, and
  `isPendingOpenLive` keeps it queued while the saved record exists.
- **Otherwise** it starts a fresh session in the project, seeded with the question and told not
  to act until asked.

**`workshop_answers({ since? })`** returns answered questions, newest first, up to 50, scoped by
who is calling:
- **from a scheduled run:** every question asked by any run of the same task
- **from any other session:** that session's own questions

A recurring job calls it at the start of each run, so a "no" or a free-text reply reaches the next
run without anyone editing the job by hand.

## Limits

- **Same machine only.** The cookie is issued only on a loopback host ([remote.md](remote.md)),
  so the link won't open from a phone.
- **Workshop is experimental and off by default in the browser**, but its tools and the provider
  register server-side regardless.
- An unattended agent also needs `workshop_ask` in its allowed tools, or it stalls on a permission
  prompt before it ever gets to send the email.
