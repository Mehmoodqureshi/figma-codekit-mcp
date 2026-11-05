// Stage 6/7 — the refine LLM: a `generate` callback for verifyLoop backed by Claude.
//
// This closes the loop. The verify loop hands it the current code, a correction
// prompt, and three images (the Figma target, the current render, and the pixel
// diff). Claude — a vision model — SEES where the render diverges from the design
// and returns corrected code. The loop re-renders and repeats until it converges.
//
// Model + params:
//   • claude-opus-5-5 (default; the current Opus)
//   • adaptive thinking at effort "high" (Opus 5.5 defaults to "medium";
//     visual reasoning is non-trivial, so it is set explicitly)
//   • server-side refusal fallback (fallbacks: "default"), so a policy decline
//     is retried on another model inside the same call instead of failing
//   • streaming with a large max_tokens (a full HTML document can be big)
//
// Auth: constructs a zero-arg Anthropic() client — it resolves ANTHROPIC_API_KEY,
// ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile automatically.

import Anthropic from '@anthropic-ai/sdk';

const DEFAULT_CONVENTIONS =
  'Output a single self-contained HTML document with an inline <style> block (no external ' +
  'assets, no CDN links). Use flexbox for layout (not absolute positioning) wherever the ' +
  'design allows. Keep exact spacing, font-size, line-height, and colors.';

/** PNG Buffer → an Anthropic image content block. */
function imageBlock(png) {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') },
  };
}

/** Pull the code out of Claude's reply: strip a ```html fence if present. */
function extractCode(message) {
  const text = (message.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Build a `generate` function for verifyLoop, backed by Claude.
 *
 * @param {Object} [options]
 * @param {string} [options.model='claude-opus-5-5']
 * @param {'low'|'medium'|'high'|'xhigh'|'max'} [options.effort='high']
 * @param {boolean} [options.fallbacks=true]  Server-side refusal fallback (Claude API only).
 * @param {number} [options.maxTokens=64000]
 * @param {string} [options.conventions]   Framework/style rules injected into the system prompt.
 * @param {Anthropic} [options.client]     Pre-constructed SDK client (else a zero-arg one).
 * @returns {(args: {code, correction, iteration, referencePng, renderPng, diffPng}) => Promise<string>}
 */
export function createClaudeRefiner(options = {}) {
  const {
    model = 'claude-opus-5-5',
    maxTokens = 64000,
    effort = 'high',
    fallbacks = true,
    conventions = DEFAULT_CONVENTIONS,
    client = new Anthropic(),
  } = options;

  const system =
    'You are a pixel-perfect UI engineer. You receive: (1) the TARGET design image, ' +
    '(2) the CURRENT rendered output of the code, (3) a pixel-diff image where highlighted ' +
    'regions mark where the two differ, and (4) the current code. Correct the code so its ' +
    'render matches the target exactly. Change only what reduces the differences. ' +
    conventions +
    ' Respond with ONLY the corrected, complete code — no explanation, no commentary.';

  return async function generate({ code, correction, referencePng, renderPng, diffPng }) {
    const content = [];
    if (referencePng) {
      content.push({ type: 'text', text: 'TARGET design (match this):' }, imageBlock(referencePng));
    }
    if (renderPng) {
      content.push({ type: 'text', text: 'CURRENT render of your code:' }, imageBlock(renderPng));
    }
    if (diffPng) {
      content.push(
        { type: 'text', text: 'PIXEL DIFF (highlighted = differs from target):' },
        imageBlock(diffPng)
      );
    }
    content.push({
      type: 'text',
      text:
        `Current code:\n\n\`\`\`html\n${code}\n\`\`\`\n\n${correction}\n\n` +
        'Return ONLY the corrected, complete HTML document.',
    });

    // Stream (large max_tokens would otherwise risk an HTTP timeout); collect the
    // full message with the SDK helper.
    const params = {
      model,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort },
      system,
      messages: [{ role: 'user', content }],
    };
    // The fallback rides on the beta namespace; without it a refused request
    // simply stops. Pass fallbacks:false for Bedrock/Vertex/Foundry clients.
    const stream = fallbacks
      ? client.beta.messages.stream({
          ...params,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        })
      : client.messages.stream(params);
    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      throw new Error(
        `Claude refused the refinement request${
          message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : '.'
        }`
      );
    }
    return extractCode(message);
  };
}
