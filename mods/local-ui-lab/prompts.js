/**
 * Local UI Lab: the system prompts, the sampling settings, and the function that builds a
 * request.
 *
 * Written for a 4B model: short and imperative, with the edit format shown rather than
 * described. Both runtimes get these exact messages and these exact sampling settings, which
 * is what makes the Ollama and WebLLM numbers comparable.
 */

export const MODES = ['generate', 'patch', 'rewrite'];

// Low temperature because the output has to parse. presence_penalty is pinned to 0 because
// qwen3.5's Ollama Modelfile ships 1.5, which penalises repeating a token already used, and
// copying the page's own text back verbatim is exactly what a SEARCH block has to do.
export const SAMPLING = { temperature: 0.3, top_p: 0.9, presence_penalty: 0 };

// Where the CSS goes decides when anything appears. Nothing in <body> can render until a
// <style> written before it has closed, and that block is most of a small page's tokens: in the
// first smoke run, qwen3.5:4b's </style> arrived at 69% of its output, 11s into a 15s reply.
// Markup first puts the content on screen as it is written and styles it when the CSS lands.
export const ORDERS = ['style-first', 'markup-first'];
export const DEFAULT_ORDER = 'style-first';

const GENERATE_HEAD = `You build small, self-contained web pages.

Reply with ONE complete HTML document and nothing else. Your first characters are <!DOCTYPE html> and your last are </html>. No markdown, no code fences, no explanation.
`;

const ORDER_RULES = {
  'style-first': `- All CSS goes in one <style> element inside <head>, before the body.
- All JavaScript goes in one <script> element at the end of <body>.`,
  'markup-first': `- Keep <head> minimal: only <meta charset="utf-8"> and a <title>.
- Write the visible content first, straight after <body>.
- After the content, still inside <body>, put all CSS in one <style> element.
- Last in <body>, put all JavaScript in one <script> element.`,
};

const GENERATE_TAIL = `- No external files: no CDNs, web fonts, images or network requests. Draw icons with CSS, inline SVG or emoji.
- Use a system font stack, generous spacing and a restrained colour palette.
- Keep it compact: well under 200 lines.`;

export const GENERATE_PROMPTS = Object.fromEntries(
  ORDERS.map((order) => [order, `${GENERATE_HEAD}\n${ORDER_RULES[order]}\n${GENERATE_TAIL}`]),
);

export const REWRITE_PROMPT = `You change an existing web page.

You are given the CURRENT PAGE and a CHANGE. Reply with the complete updated HTML document and nothing else. Your first characters are <!DOCTYPE html> and your last are </html>. No markdown, no code fences, no explanation.

Keep everything the change does not mention exactly as it is. All CSS stays in the one <style> in <head>, and all JavaScript in the one <script> at the end of <body>. No external files.`;

export const PATCH_PROMPT = `You change an existing web page by replying with SEARCH/REPLACE blocks. Never reply with the whole page.

Each block looks exactly like this:

<<<<<<< SEARCH
    <h1>Old title</h1>
=======
    <h1>New title</h1>
>>>>>>> REPLACE

Rules:
- The SEARCH lines are copied character for character from the CURRENT PAGE, including indentation. If they do not match the page exactly, the edit fails.
- Use the smallest SEARCH that appears only once in the page: usually one to four lines.
- To ADD something, SEARCH for the line next to where it goes, and put that same line in REPLACE together with the new lines.
- To DELETE something, leave REPLACE empty.
- One block per separate change. A style change needs a block inside the <style>; new behaviour needs a block inside the <script>.
- Reply with the blocks only. No code fences, no explanation.`;

/**
 * The messages for one request. There is no conversation: an edit carries the current page,
 * so every request stands alone. That is also what keeps it inside WebLLM's 4096-token window.
 */
export function buildMessages(mode, html, request, { order = DEFAULT_ORDER } = {}) {
  const change = String(request ?? '').trim();
  if (mode === 'generate') {
    if (!ORDERS.includes(order)) throw new Error(`unknown order: ${order}`);
    return [
      { role: 'system', content: GENERATE_PROMPTS[order] },
      { role: 'user', content: change },
    ];
  }
  if (mode !== 'patch' && mode !== 'rewrite') throw new Error(`unknown mode: ${mode}`);
  return [
    { role: 'system', content: mode === 'patch' ? PATCH_PROMPT : REWRITE_PROMPT },
    { role: 'user', content: `CURRENT PAGE:\n${String(html ?? '')}\n\nCHANGE: ${change}` },
  ];
}
