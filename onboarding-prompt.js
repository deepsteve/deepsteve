/**
 * The canned first-run onboarding prompt (#695).
 *
 * Same shape and the same reason as issue-prompt.js: the rendering is pure and lives
 * here, the orchestration (spawn, allowedTools, prompt delivery) lives in server.js's
 * startOnboardingSession. Keeping the text out of the daemon is what lets a plain
 * `node --test` assert the two things that can silently rot — that the prompt names
 * exactly the tools the session is granted, and that it stays inside the composer
 * budget — without booting anything.
 *
 * Deliberately NOT a setting. wandPromptTemplate is user-editable because an issue
 * prompt is the user's own instruction to their agent; this one is a fixed part of the
 * product's first impression, and a half-edited copy of it would break the one flow
 * that has to work on a machine where nothing has been configured yet.
 *
 * Root-level, so restart.sh (`cp *.js`), release.sh (`for rootjs in *.js`) and
 * package.json's `/*.js` all ship it with no deploy-script change — the same argument
 * html-source.js and mod-kind.js make for living here.
 */

// The tour page, relative to the install root. The server joins it onto __dirname to
// get the absolute path create_display_tab requires (html-source.js refuses a relative
// file_path), and test/unit/onboarding-prompt.test.js asserts the file is really there
// and that release.sh embeds it — an install.sh missing it would fail this flow on
// exactly the fresh machine it exists to serve.
const TOUR_PAGE_REL = 'public/onboarding-tour.html';

/**
 * The tools the onboarding session is pre-permitted to call, via claude's
 * --allowedTools (#612's plumbing, reused).
 *
 * This array is the SINGLE source for both the grant and the prompt: server.js passes
 * it to getSpawnArgs, renderOnboardingPrompt names it, and a unit test asserts the two
 * agree in both directions. Granting a tool the prompt never mentions is dead
 * permission; naming one that was not granted is a permission dialog in front of
 * somebody's first thirty seconds with the product, which is the whole failure this
 * exists to prevent.
 *
 * Two, not more. The grant is a real widening of what an unattended agent may do
 * without asking, and the flow needs exactly these: one to learn its own session id,
 * one to open the page.
 */
const ONBOARDING_TOOLS = [
  'mcp__deepsteve__get_my_session_id',
  'mcp__deepsteve__create_display_tab',
];

// This text is typed into a TUI composer on a machine whose agent may still be cold,
// so it is short on purpose — the same budget argument issue-prompt.js makes for
// WORKFLOW_STAGES. It also does not explain what the two tools do: their descriptions
// already do that, at no prompt cost.
const PROMPT_LIMIT = 1200;

/**
 * The prompt the first-run guide session receives.
 *
 * `tourPath` must be absolute — resolveHtml() in html-source.js rejects anything else,
 * and a relative path here would surface to the user as the guide apologising for a
 * missing file. server.js is the only caller and computes it from __dirname.
 *
 * The instruction to pass `file_path` rather than `html` is load-bearing twice over:
 * the model emits a path instead of a whole document (#599's whole point), and the
 * page every new user sees is the reviewed one in the repo rather than whatever the
 * model would improvise that run.
 */
function renderOnboardingPrompt({ tourPath } = {}) {
  return [
    'You are the guide for someone opening Deep Steve for the first time. Greet them in one line.',
    '',
    'Then, before anything else, open the tour page:',
    '1. Call `mcp__deepsteve__get_my_session_id`.',
    `2. Call \`mcp__deepsteve__create_display_tab\` with that session id, file_path "${tourPath}", and name "Welcome to Deep Steve". The page already exists on disk — write no HTML of your own and do not pass an html argument.`,
    '',
    'Then say, in two or three sentences, what just happened: you are an agent running in a tab, you took one instruction and painted a page into a second tab, and that is what Deep Steve is for.',
    '',
    'Stop there. Offer to answer questions about anything on that page, or to open their first project. Do not edit files, run builds, or explore the directory you are in unless they ask.',
  ].join('\n');
}

module.exports = { renderOnboardingPrompt, ONBOARDING_TOOLS, TOUR_PAGE_REL, PROMPT_LIMIT };
