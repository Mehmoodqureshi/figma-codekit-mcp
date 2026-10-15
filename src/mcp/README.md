# Stage 1/4 — Figma Adapter

> **Two directions live in this folder — don't confuse them.**
>
> - **Adapter (client)** — `source.js`, `mcpSource.js`, `loadFrame.js`: the pipeline *consumes*
>   Figma. Documented below.
> - **Server** — [`server.js`](#mcp-server): the pipeline *is consumed by* an agent, over MCP.
>   Jump to [MCP server](#mcp-server).

The bridge between a real Figma frame and the pipeline. Turns a URL (or file key +
node id) into the four inputs everything else consumes:

```
{ raw, variableMap, componentMap, referencePng }
   │        │             │            └─ verifyLoop({ referencePng })      (Stage 7)
   │        └─────────────┴────────────── figmaToIR(raw, { variableMap, componentMap })  (Stages 1–4)
   └───────────────────────────────────── figmaToIR(raw, ...)
```

## Modules

| File | Role |
|---|---|
| `source.js` | `FigmaRestSource` — the primary adapter (Figma REST API). Node tree, variables, components, screenshot, SVG export. |
| `mcpSource.js` | `FigmaMcpSource` — wraps a running Dev Mode MCP server for screenshots; delegates structured data to a REST fallback. |
| `transform.js` | Pure mappers: REST payloads → `variableMap` / `componentMap`; `parseFigmaUrl`. |
| `loadFrame.js` | `loadFrame(source, nodeId)` / `loadFromUrl(url, {token})` — one call, all inputs. |
| `index.js` | Public exports. |
| `server.js` | **MCP server** — exposes the pipeline as agent-callable tools. See [below](#mcp-server). |

## Usage — from URL to code

```js
import { loadFromUrl } from './src/mcp/index.js';
import { figmaToIR } from './src/ir/index.js';
import { generateHtml } from './src/codegen/index.js';
import { verifyLoop } from './src/index.js';

const { raw, variableMap, componentMap, referencePng } =
  await loadFromUrl(figmaUrl, { token: process.env.FIGMA_TOKEN });

const ir   = figmaToIR(raw, { variableMap, componentMap });
const html = generateHtml(ir);
const out  = await verifyLoop({ initialCode: html, referencePng, generate });
```

Run it live: `FIGMA_TOKEN=figd_xxx node example/pipeline.js "<figma-frame-url>"`
Offline test (mocked API, no token): `npm test`.

## Why REST is the primary source (not the MCP server)

The Figma **Dev Mode MCP server** is designed to hand an AI agent *code* and *context*, not the
raw node tree. Our IR binds tokens and components by **id** (from each node's `boundVariables` and
the file's `components` dict) — which the REST API exposes directly and the MCP tool outputs don't.
So:

- **Node tree, variables, components** → `FigmaRestSource` (needs a personal access token).
- **Screenshot** → either source (`FigmaMcpSource` uses the server's `get_screenshot`).

`FigmaMcpSource` therefore takes a `restFallback` for structured data and uses the MCP server for
the reference screenshot — the practical hybrid.

## Getting the inputs

- **Token:** Figma → Settings → *Personal access tokens*. Scopes: File content (read), and for
  `variableMap`, the **Variables** scope (Enterprise). Without it, tokens degrade gracefully to `{}`.
- **URL:** any frame URL — `parseFigmaUrl` extracts `fileKey` and converts `node-id=1-2` → `1:2`.

---

## MCP server

`server.js` turns the whole pipeline into an MCP server, so an agent (Claude Code) can drive
Figma-to-code directly instead of you running scripts by hand.

```
agent ──figma_convert──▶ [ REST → IR → assets → HTML ] ──▶ files on disk
agent ──figma_verify───▶ [ Playwright → pixel diff + element IoU ] ──▶ "the CTA is 12px low"
agent ──(edits the HTML)──▶ figma_verify again ──▶ converged
```

### Install

```bash
claude mcp add figma-to-code --scope user -- node /absolute/path/to/figma-codekit-mcp/src/mcp/server.js
claude mcp list   # → figma-to-code: ✔ Connected
```

The token is read from `.figma-token` at the project root via `src/config/credentials.js`
(or `FIGMA_TOKEN` in the env, which wins). No token is passed as a tool argument.

### Tools

| Tool | Does |
|---|---|
| `figma_convert` | Figma URL → `generated.html` + `reference.png` + `ir.json` + `assets.json` in a cache dir. Deterministic, no LLM. Figma responses are cached — re-runs are offline unless `refresh: true`. Options: `responsive`, `react`, `outDir`. |
| `figma_verify` | Renders an HTML file, pixel-diffs it against `reference.png`, and runs element-bbox IoU. Returns the diff ratio + MISSING/MISPLACED findings + worst regions. Writes `render.png` and `diff.png`. |
| `figma_inspect` | Prints the IR as an indented outline (role, name, box, layout, text, tokens) with an optional `filter` — find an element without reading `ir.json`. |

### The refine loop runs through the agent

`verifyLoop` + `createClaudeRefiner` (in `src/refine/`) call Claude *internally* and need an
`ANTHROPIC_API_KEY`. The MCP server deliberately **does not** use them. Instead `figma_verify`
hands the correction back to the calling agent, which already has vision and already has the file
open — it edits and re-verifies. No second API key, no nested billing, and you can watch each pass.

`src/refine/*` is still the right tool for headless/scripted runs (`example/pipeline.js`).

### Two design constraints worth knowing

- **stdout is the protocol.** Never `console.log` in the server path — it corrupts the stdio
  transport. Diagnostics go to stderr via `note()`. The library code we call uses `console.warn`
  (stderr), which is safe.
- **Tools return paths, not blobs.** A converted frame is often 100+ KB of HTML; returning it
  through a tool result would burn the agent's context for no benefit. The agent reads and edits
  the files itself. `figma_verify` takes `includeImages: true` if you *do* want the PNGs inline.

### Test

```bash
npm run test:server   # spawns the server over real stdio, speaks real MCP, no token needed
```

It seeds a cache dir offline (rendering the fixture to make its own `reference.png`), then asserts
that matching HTML converges, that deliberately broken HTML does *not* and names the missing
element, and that the error paths are actionable.

---

## Notes / next steps

- **Variables API is Enterprise-only.** `getVariableMap()` catches the error and returns `{}` so
  the pipeline still runs (codegen falls back to exact literal values).
- **Code Connect props:** REST gives component names but not prop bindings. Merge a real
  `get_code_connect_map` (via `FigmaMcpSource`) into `componentMap` to get `<Button variant=…>`.
- **SVG export** (`source.exportSvgs`) is wired but not yet auto-connected to the codegen vector
  placeholders — that's the remaining Stage 1 asset-export task.
