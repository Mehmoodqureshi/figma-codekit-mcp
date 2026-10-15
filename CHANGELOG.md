## 0.2.4 - 2026-10-15

- Validate trusted npm publishing from GitHub Actions for the canonical package.

## 0.2.3 - 2026-10-15

- Rename the npm package and CLI to `figma-codekit-mcp`.
- Update install commands, setup checks and the local site branding.
- Align repository links and the MCP registry identifier with `figma-codekit-mcp`.

## 0.2.2 - 2026-10-15

- Refresh runtime dependencies and require the patched MCP SDK.
- Align GitHub repository links with `mcp-figma-to-code`.
- Rename the npm package and command to `mcp-figma-to-code`. Install with
  `npx -y mcp-figma-to-code@latest`.
- Update setup examples and the server identity to the canonical package name.
- Read the MCP handshake name and version from package.json instead of the
  old hardcoded identity.
- Keep existing tool names, settings and stored data compatible.
- Publish future approved version tags through npm trusted publishing.

## 0.2.1 - 2026-09-25

Setup can now be checked in one command, and the React and Next.js output
compiles when a frame uses components.

- feat: **`--check` tells you whether figma-mcp will work before an agent
  tries.** The server has nothing to say until an MCP host connects, so a fresh
  install gave no way to tell a missing token from a broken browser.
  `npx -y @mehmoodqureshi/figma-mcp --check` reports the Node version, whether a
  token was found and where (`environment`, or the `.figma-token` path, never
  the value), whether Figma accepts it (`/v1/me`), and whether the Chromium that
  `figma_verify` renders in is on disk, then prints `READY` or the fix for each
  problem, exiting 0 or 1. `--install-browser` redoes a skipped or failed
  Chromium download with the Playwright version this package pins. Both run
  before the stdio transport starts, so stdout carries the report.
- 28 new checks in `example/doctor-test.js`, now part of `npm test`: every
  `/v1/me` answer (200, 401/403, 429, 5xx, offline, timeout), the report, and
  the real binary in a scratch directory, including that the token value never
  appears in the output.
- fix: **the React and Next.js output did not compile whenever a frame used a
  bound component.** `generateReact` emitted `import { Badge } from
  './components/Badge'` for every Code Connect instance, and nothing anywhere
  wrote that file — not the MCP server, not `generateNext`'s file map. Two of the
  three frames in the local cache hit it, so `npm run dev` died on the first
  import. `generateComponentModules(ir)` (`src/codegen/react.js`) now emits one
  module per binding, and both callers write them.
- fix: a bound instance rendered as a self-closing `<Badge />`, so everything
  Figma had *inside* it was dropped from the React tree. The HTML emitter keeps
  that content (`html.js`, `ROLES.COMPONENT`) and React silently did not — the
  two emitters disagreed about what the design contains, and since only the HTML
  is ever rendered, nothing caught it. The instance's content is now passed to
  the component as children, which is where it has to live: a binding is
  instantiated many times per frame with different copy, so content held in the
  module is content every instance shares. Building a real page with it in the
  module rendered every nav link with the first one's label and lost 53 of 69
  strings; as children, the page carries 63 and the render is pixel-identical to
  the HTML.
- feat: `figma_convert` takes `next: true` and writes the runnable App Router
  project to `<dir>/next/`. `generateNext` has existed since 0.2.0 but was
  reachable only through `site/` — the MCP server imported just `generateHtml`
  and `generateReact`, so the one interface most people use could not emit a
  Next.js project at all.
- fix: `generateReact` dropped the line breaks in multi-line copy. A break
  arrives from Figma as "\n" inside a text run, and the HTML emitter turns it
  into `<br>` (`html.js`, `br()`) while React interpolated it as raw whitespace.
  These elements carry `white-space:nowrap` from cssgen, so a two-line headline
  rendered as one long line overflowing its box, with the design's own breaks
  gone. Found by building the generated project and diffing the running page
  against the HTML: it accounted for the whole remaining 1.42% gap, which is now
  0.00%.

## 0.2.0 - 2026-09-03

- feat: `generateNext(ir, { assets })` (`src/codegen/next.js`) emits a runnable
  Next.js App Router project — `app/page.jsx`, `app/layout.jsx`, `app/globals.css`,
  `package.json`, `next.config.mjs`. The component file is byte-for-byte
  `generateReact`'s output, so the two can never drift apart in what they claim
  the design looks like; the rest is scaffolding. A canvas-fit design scales
  itself with `useState`/`useEffect`, so that variant — and only that variant —
  is marked `'use client'`. Fonts go through `@import` in `globals.css`, which is
  the one mechanism that behaves the same in `next dev`, `next build` and a
  copy-paste of the file elsewhere.
- fix: **`generateReact` never received `assets`**, so every image emitted
  `src={""}` and every vector emitted the "asset not exported" dashed outline —
  the React output was structurally correct and completely blank. It now takes
  the same `assets` map as the HTML emitter and follows the same rules: a cropped
  fill becomes a `role="img"` div carrying the background layer, everything else
  becomes an `<img>` with the data URI, and a missing export falls back to the
  same transparent placeholder. On a four-image frame that is the difference
  between 1.7 KB of markup and 5.7 MB of actual page.
- refactor: `fontStylesheetUrls(ir)` split out of `html.js`'s `fontLinks()` and
  exported, so emitters that cannot use a `<link>` tag can reach the same font
  list. `generateHtml` output is byte-identical across the change.

- feat: `figma_verify` now checks **paint order and clipping** alongside the
  pixel diff and the bounding-box IoU (`src/paintOrder.js`). Figma lists children
  back-to-front, so a node's pre-order index is its paint order; the render is
  probed with `elementsFromPoint` over a sample grid and the two orders compared
  wherever elements actually overlap. This closes a real blind spot: an overlay
  given a `z-index` that puts it in front of a card the design stacks it behind
  moves no bounding box, so IoU scores it a perfect match, and on a 1440x10490
  frame it swaps too few pixels to clear the diff threshold — yet it is one of
  the most obvious errors to a human. The same pass reports elements cut off by
  an ancestor's `overflow` where the design lets them overhang, which is what
  leaves a hard seam under a decorative element meant to bridge two sections.
  Findings are surfaced as `WRONG STACKING` / `OVER-CLIPPED` with the Figma paint
  indices, and are reported even when the pixel diff has converged — the headline
  now reads NOT CONVERGED when the layering is wrong. `npm run example:paint-order`
  demonstrates both against a three-element frame.
- fix: paint sampling scrolls the page and uses a square sample pitch, so the
  result no longer depends on viewport height. `elementsFromPoint` is
  viewport-relative: a 1440x10490 frame verified at a 900px viewport was sampled
  only across its first screen, found 13 overlapping pairs instead of 502, and
  reported a clean bill of health for a frame with 24 stacking errors in it —
  silently, since `figma_verify` accepts an explicit `height`. Both viewports now
  return identical findings.
- fix: hit-testing briefly forces `pointer-events: auto` while sampling. Without
  it `elementsFromPoint` skips exactly the decorative overlays this check exists
  to catch, since those routinely carry `pointer-events: none`. It has no layout
  effect and is reverted before the function returns; the screenshot is taken
  first, so the capture never sees it.

## 0.1.0 - 2026-09-01

First release.

- feat: three MCP tools over stdio — `figma_convert` (frame → self-contained HTML
  + IR + assets, deterministic, no LLM), `figma_verify` (render in Chromium,
  pixel-diff against the Figma reference, IoU-check every element box, return
  targeted fix instructions), and `figma_inspect` (IR as a filterable outline).
  Tools return file paths and numbers rather than blobs — a converted frame is
  often 100+ KB of HTML, and pushing that through a tool result would burn the
  agent's context for nothing.
- feat: the refine loop runs through the CALLING agent, not an LLM inside the
  server. No `ANTHROPIC_API_KEY`, no second model billing, and the agent keeps
  full context on what it already tried. `src/refine/` still offers a headless
  loop for library use.
- feat: Figma responses are cached per frame, so everything after the first
  `figma_convert` runs offline — including while rate-limited, where a stale
  frame still beats no frame.
- fix: the cache and `.figma-token` are now anchored to the directory the server
  is started from, not to the package root, with `FIGMA_MCP_CACHE_DIR` to
  override. Installed via `npx` the package root is a throwaway directory inside
  `node_modules`: a 100 MB frame cache written there is silently lost on the next
  install, and a `.figma-token` there could never be found at all.
- fix: `verifyLoop`'s `onIteration` event now carries `renderPng`. It previously
  exposed only the diff, and a diff of a blank page is indistinguishable from a
  converged one — which is exactly how `example/run-example.js` came to write its
  diff images out under `render-N.png`, making a converged run look like it had
  rendered nothing. Both are now written under their real names.
- chore: `postinstall` no longer fails the install when the Chromium download
  fails or is skipped. `figma_convert` and `figma_inspect` need no browser at
  all, so a CI install or a `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` install is a
  perfectly reasonable thing to want.
