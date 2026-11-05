# Stage 6/7 — Refine LLM (Claude)

The last external piece. `verifyLoop` renders, diffs, and builds a correction prompt; the refiner is
the `generate` callback that actually **fixes** the code — and because it's a vision model, it does so
by *seeing* the target, the current render, and exactly where they differ.

```
verifyLoop → render → diff → [ Claude sees target + render + diff ] → corrected code → re-render → …
```

Isolated in its own module so the core pipeline doesn't pull in the Anthropic SDK unless you use it.

## Usage

```js
import { verifyLoop } from './src/index.js';
import { createClaudeRefiner } from './src/refine/index.js';

const result = await verifyLoop({
  initialCode: html,           // from Stage 6 codegen
  referencePng,                // from the Figma MCP adapter
  threshold: 0.02,
  maxIterations: 5,
  generate: createClaudeRefiner(),   // ← wires Claude into the loop
});
```

Run the live demo: `ANTHROPIC_API_KEY=sk-... node example/refine-example.js`
(or `ant auth login` first — the SDK resolves the profile automatically).

## What it sends each iteration

Request shape:

- **Model:** `claude-opus-5-5` (the current Opus; override via `model`), adaptive thinking at effort `high`, with the server-side refusal fallback on (`fallbacks: false` to turn it off, e.g. on Bedrock or Vertex).
- **Adaptive thinking** (`thinking: {type: "adaptive"}`) — matching a render against a design is real visual reasoning.
- **Streaming** with `max_tokens: 64000` — a full HTML document can be large; streaming avoids HTTP timeouts.
- **Three images** as base64 blocks: the Figma **target**, the **current render**, and the **pixel diff**
  (highlighted = differs) — plus the current code and the text correction prompt.

## Options

| Option | Default | Purpose |
|---|---|---|
| `model` | `claude-opus-5-5` | Any vision-capable Claude model. |
| `effort` | `high` | `low` / `medium` / `high` / `xhigh` / `max`. |
| `fallbacks` | `true` | Server-side refusal fallback (Claude API only). |
| `maxTokens` | `64000` | Output cap (streamed). |
| `conventions` | self-contained HTML + flexbox rules | Injected into the system prompt — set your framework/style rules here. |
| `client` | `new Anthropic()` | Inject a pre-built SDK client (or a mock for tests). |

## Auth

`createClaudeRefiner()` constructs a zero-arg `Anthropic()` client, which resolves credentials in order:
`ANTHROPIC_API_KEY` → `ANTHROPIC_AUTH_TOKEN` → an `ant auth login` profile. No key is hardcoded.

## Notes

- **Refusals** are surfaced as a thrown error (rare for this benign task). The loop keeps the best
  iteration seen, so a single failed pass never makes the result worse.
- **Returns HTML by default.** For React/Vue, set `conventions` accordingly and adapt `initialCode` —
  the loop renders whatever `render`/`renderUrl` you configure.
- The refiner is provider-specific (Claude). To use a different provider, implement the same
  `generate({ code, correction, referencePng, renderPng, diffPng })` contract.
