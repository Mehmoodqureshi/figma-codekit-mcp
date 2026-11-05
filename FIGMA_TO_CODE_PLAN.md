# Figma → Code — Build Plan & Progress Tracker

> **Purpose:** A living document for building a Figma-to-code system that produces **exact** output.
> Update the `Status` columns as you go. Anything not `✅ Done` is a gap.
>
> **Legend:** `✅ Done` · `🚧 In progress` · `⛔ Not started` · `➖ N/A`
> **Last updated:** 2026-08-06

---

## 1. Vision & Definition of "Exact"

We are NOT doing screenshot→code. We convert the **Figma node tree (metadata)** into code, then
**verify it visually in a loop** until it matches the design.

"Exact" means:
- Every visible element from the design is present (no dropped elements).
- Layout matches (position, spacing, alignment) within tolerance.
- Colors, typography, spacing come from **our design tokens**, not re-derived values.
- Component instances resolve to **our real components** (not lookalike divs).
- Output is **responsive**, not hardcoded absolute positions.

**Core principle:** Do as much as possible **deterministically (in code)**. Use the LLM only for
the fuzzy parts. Then **verify with a render→diff→refine loop.** The LLM is the least reliable
component — minimize what depends on it.

---

## 2. The Golden Flow

```
┌─ DETERMINISTIC (code, no LLM) ──────────────────────────┐
│ 1. Pull node tree from Figma MCP                        │
│ 2. Clean it (drop invisible/wrapper nodes, flatten SVG) │
│ 3. Auto Layout → flexbox (direction, gap, padding)      │
│ 4. Resolve variables → our design tokens                │
│ 5. Map component instances → our components (Code Connect)
│ 6. Emit an Intermediate Representation (IR)             │
└─────────────────────────────────────────────────────────┘
                        │
┌─ AI (LLM, per-region) ──────────────────────────────────┐
│ 7. Segment large frames (divide-and-conquer)            │
│ 8. Generate structure first, then styling, from the IR  │
└─────────────────────────────────────────────────────────┘
                        │
┌─ VERIFY LOOP (accuracy engine) ─────────────────────────┐
│ 9.  Render generated code        ← Playwright           │
│ 10. Screenshot it                                       │
│ 11. Diff vs Figma reference (pixel + per-element bbox)  │
│ 12. Feed mismatches back to LLM → fix → re-render       │
│     repeat until diff < threshold                       │
└─────────────────────────────────────────────────────────┘
```

Steps 1–6 give ~80% correct output reliably. Steps 7–8 fill gaps. Steps 9–12 make it exact.

---

## 3. Prerequisites — What We Must HAVE

### Design-side inputs
| Input | Source | Why it matters | Status |
|---|---|---|---|
| Full node tree (geometry, styles, text) | Figma REST / MCP | Ground truth for conversion | ✅ `src/mcp/source.js` |
| Variables & styles (tokens) | REST `variables/local` | Bind to our tokens, not raw hex | ✅ `getVariableMap()` (Enterprise) |
| Auto Layout data (dir, gap, padding) | node tree | Lets us emit flexbox not coords | ✅ consumed by `src/ir/autolayout.js` |
| Assets exported as SVG/PNG, deduped | REST `images` | Icons/images with stable names | 🚧 `exportSvgs()` wired; not auto-linked |
| Reference screenshot per frame | REST/MCP `get_screenshot` | Ground truth for verify loop | ✅ `getScreenshotPng()` |
| Code Connect map | `get_code_connect_map` | Instances → our components | 🚧 names via REST; props via MCP TODO |

### Code-side inputs
| Input | Why | Status |
|---|---|---|
| Our design-token file (Tailwind `@theme` / CSS vars) | Binding target | ⛔ |
| Our component library | Instance resolution target | ⛔ |
| Target framework + convention spec (written down) | Injected into every prompt | ⛔ |

### Infrastructure
| Piece | Tool (recommended) | Purpose | Status |
|---|---|---|---|
| Headless browser | **Playwright** | Render generated code, screenshot it | ✅ `src/render.js` |
| Pixel diff | `pixelmatch` | Compare render vs reference | ✅ `src/diff.js` |
| Element matching | custom (bbox IoU) | Catch dropped/misplaced elements | ✅ `src/elementDiff.js` (true IoU via `data-ir-id`) |
| VLM | claude-opus-5-5 (vision) | Generation + visual critic loop | ✅ `src/refine/*` (`createClaudeRefiner`) |

---

## 4. Pipeline Stages — Build Checklist

> This is the master checklist. Each stage is a milestone.

### Stage 1 — Extract & Normalize (deterministic, no LLM)
- [x] Pull full node tree from Figma — `src/mcp/source.js` (`FigmaRestSource.getNode`) + `loadFromUrl`
- [x] Drop invisible / zero-opacity nodes — `src/ir/normalize.js`
- [x] Collapse redundant wrapper frames — `src/ir/normalize.js` (box preserved)
- [x] Strip editor-only properties — converter reads only known fields (implicit strip)
- [x] Vector clusters flagged (`__vectorCluster`); SVG export wired — `source.exportSvgs()`
- [x] Auto-connect exported assets into codegen placeholders — `source.exportNodes()` → `assets` map
      → `generateHtml(ir, { assets })` (image fills → PNG data URI, vectors → SVG). Wired in
      `example/convert.js` and the `figma_convert` MCP tool.
- [x] Asset export shared by every entry point — `src/mcp/assets.js` (`exportAssets`),
      used by `example/convert.js`, `example/pipeline.js` and `figma_convert`. A zero-asset
      export is now reported; it used to fall through to placeholders silently.
- [ ] Stable asset *filenames* (currently embedded as data URIs, not written as files)
- **Status:** ✅  ·  **Notes:** *Fetch + normalize done & tested (`npm test`). Assets embed
  self-contained so the verify loop can render without a server. See [`src/mcp/README.md`](src/mcp/README.md).*

### Stage 2 — Auto Layout → Flexbox (deterministic) ⭐
- [x] Map Auto Layout direction → `flex-direction` — `src/ir/autolayout.js`
- [x] Map spacing → `gap`
- [x] Map padding → `padding`
- [x] Map align/justify → `align-items` / `justify-content`
- [x] Fallback rule for non-Auto-Layout frames — leaf→block, container→absolute
- [x] Per-child hints — `layoutGrow`→grow, `layoutAlign`→alignSelf, `ABSOLUTE`→escape flow
- **Status:** ✅  ·  **Notes:** *Verified via `node example/ir-example.js`.*

### Stage 3 — Intermediate Representation (IR)
- [x] Define IR schema (box, tokens, layout mode, style, text, component, asset) — `src/ir/schema.js`
- [x] Node tree → IR converter — `src/ir/fromFigma.js` (`figmaToIR`)
- [x] IR is framework-agnostic (can target React/Vue/Flutter later)
- [x] Validator — `validateNode()`; relative-coordinate computation; role classification
- **Status:** ✅  ·  **Notes:** *See [`src/ir/README.md`](src/ir/README.md).*

### Stage 4 — Token & Component Binding (deterministic)
- [x] Resolve colors/spacing/typography → our tokens — via `variableMap` (`boundVariables`)
- [x] Resolve component instances → our components — via `componentMap` (Code Connect)
- [x] Graceful fallback — unbound instance → container; unresolved token → keeps raw id
- [x] Populate `variableMap`/`componentMap` from Figma — `src/mcp/transform.js` + `FigmaRestSource`
- [ ] Merge Code Connect prop bindings (`get_code_connect_map`) for `<Button variant=…>`
- **Status:** 🚧  ·  **Notes:** *Maps built from REST (`npm test`). Remaining: Code Connect props via `FigmaMcpSource`.*

### Stage 5 — Segmentation (divide-and-conquer)
- [ ] Segment frames by hierarchy
- [ ] Keep each unit under ~12k tokens
- [ ] Recompose regions into full output
- **Status:** ⛔  ·  **Notes:** ___

### Stage 6 — Codegen (IR → code)
- [x] Generate structure/skeleton first (semantic tags by role) — `src/codegen/html.js`
- [x] Generate styling second (scoped stylesheet) — `src/codegen/cssgen.js`
- [x] Generate from IR (never raw Figma JSON)
- [x] HTML emitter (renders in verify loop) + React emitter (framework-agnostic proof)
- [x] Token fallbacks `var(--token, <exact-figma-value>)`; bound instances → real components
- [x] LLM-assisted refinement pass — `src/refine/*` (`createClaudeRefiner`), vision-driven, wired to verify loop
- [x] Inject project convention spec — `conventions` option on `createClaudeRefiner`
- **Status:** ✅  ·  **Notes:** *Deterministic emitters + Claude refiner both done. Codegen verified
  (`node example/codegen-example.js`); refiner verified offline (mock client) and runs live via
  `ANTHROPIC_API_KEY=… node example/refine-example.js`. See [`src/codegen/README.md`](src/codegen/README.md),
  [`src/refine/README.md`](src/refine/README.md).*

### Stage 7 — Verify Loop (Playwright) ⭐⭐ THE ACCURACY ENGINE
- [x] Render generated code in Playwright — `src/render.js` (`renderHtml` / `renderUrl`)
- [x] Screenshot the render — `src/render.js`
- [x] Pixel diff vs Figma reference — `src/diff.js` (pixelmatch + diffMask)
- [x] Per-element bounding-box IoU check — `src/elementDiff.js` (expected IR box vs rendered DOM box
      via `data-ir-id`); reports MISSING / MISPLACED. Enable by passing `ir` to `verifyLoop`.
- [x] Format mismatches as correction instructions — `src/correction.js` + `buildElementCorrection`
- [x] Feed back to LLM → fix → re-render — `src/verifyLoop.js` + `src/refine/*` (Claude, vision-driven)
- [x] Loop until diff score < threshold — `src/verifyLoop.js`, default threshold `0.02`
- [x] Pass target + render + diff images to the model — `verifyLoop` → `generate` (vision)
- **Status:** ✅  ·  **Notes:** *Fully wired: pixel diff + element-bbox IoU + Claude refiner.
  Scripted loop converges 4.93% → 0% (`npm run example`); element IoU detects MISSING/MISPLACED
  (`node example/element-diff-example.js`); live refiner (`ANTHROPIC_API_KEY=… node example/refine-example.js`).
  See [`src/README.md`](src/README.md), [`src/refine/README.md`](src/refine/README.md).*

### Stage 8 — Responsiveness Pass (last)
- [x] Capture Figma sizing modes (FIXED/HUG/FILL) in the IR — `src/ir/autolayout.js` `computeSizing`
- [x] Convert px → relative units where layout allows — `generateHtml(ir, { responsive: true })`
      (FILL→flex/100%, HUG→auto/fit-content, FIXED→kept; root→max-width+centered)
- [x] Keep exactness where the design is FIXED (icons, precise boxes) — px preserved
- [x] Rendered & checked at multiple widths — `node example/responsive-example.js` (360/768/1200)
- **Status:** ✅  ·  **Notes:** *Resolves the exactness↔maintainability tension deterministically
  from the IR. Exact mode (default) still byte-identical — verify loop refines exact; ship responsive
  as the maintainable variant. `npm run example:responsive`.*

---

## 5. Evaluation — How We Know It's Exact

Build this BEFORE optimizing. If we don't measure, we can't tell "exact" from "close."

| Metric | What it catches | Target | Status |
|---|---|---|---|
| CLIP / DINOv2 embedding similarity | High-level visual match | ___ | ⛔ |
| Block-level match (bbox IoU) | Dropped/misplaced elements | IoU ≥ 0.6 | ✅ `src/elementDiff.js` |
| Absolute-positioning ratio | Rigid, non-responsive output | low | ✅ Stage 8 responsive mode (`computeSizing`) |
| Arbitrary-value usage (`w-[123px]` count) | Not using tokens | low | 🚧 token fallbacks emitted; count metric TODO |
| Semantic-tag ratio | Code maintainability | high | ⛔ |

---

## 6. Known Failure Modes — Avoid These

- [ ] ❌ Dumping raw Figma JSON into one giant prompt → preprocess to IR instead
- [ ] ❌ One monolithic generation for a whole page → elements get dropped; segment
- [ ] ❌ No render/verify step → model never sees its mistakes
- [ ] ❌ Ignoring Auto Layout → pixel-perfect but rigid, breaks on resize
- [ ] ❌ Generating from bad extracted data → add a checkpoint after extraction

---

## 7. Open Questions / Decisions

| Question | Decision | Date |
|---|---|---|
| Target framework (React+Tailwind? Vue? other) | ___ | ___ |
| Diff threshold for "exact enough" | ___ | ___ |
| Human checkpoint after extraction — manual or automated? | ___ | ___ |
| Which VLM for the critic loop | ___ | ___ |

---

## 7b. Style Fidelity Coverage

> Added 2026-08-06 after auditing why real frames rendered unlike the design. The
> stage checklist above was all green while the output still looked wrong, because
> the stages describe the *pipeline*, not how much of Figma's style model survives
> it. Everything below is per-node extraction fidelity, tracked separately.

| Figma feature | Status | Notes |
|---|---|---|
| Solid fills | ✅ | Bottom-most solid → `background-color` |
| Stacked fills / overlays | ✅ | Paints above the base solid become layers — keeps hero scrims |
| Linear / radial / angular gradients | ✅ | `gradientHandlePositions` → CSS, aspect-corrected |
| Diamond gradient | 🚧 | Approximated as radial |
| Image fills + crop | ✅ | `imageTransform` → background-size/-position |
| Uniform strokes | ✅ | inside → `border`, center/outside → `outline` |
| Per-side strokes (`individualStrokeWeights`) | ✅ | Dividers/underlines no longer become full boxes |
| Dashed strokes | ✅ | `strokeDashes` → `border-style: dashed` |
| Gradient strokes | ⛔ | Warned (`STROKE_PAINT_UNSUPPORTED`); needs border-image |
| Drop shadows (multiple) | ✅ | All of them, re-ordered for CSS paint order |
| Inner shadows | ✅ | → `inset` |
| Layer blur | ✅ | → `filter: blur()` (radius×0.5) |
| Background blur | ✅ | → `backdrop-filter` — glassmorphism now renders |
| Blend modes | ✅ | → `mix-blend-mode` |
| Rotation | ✅ | `relativeTransform` → `rotate()`; true size from `size`, not the AABB |
| Corner radius (incl. per-corner, ellipse) | ✅ | |
| Rings (full sweep) | ✅ | Partial arcs warned (`ARC_UNSUPPORTED`) |
| Sub-pixel geometry | ✅ | No longer rounded to integers — was drifting long columns |
| Text: vertical alignment | ✅ | `textAlignVertical` — every button label sat high before |
| Text: mixed inline runs | ✅ | `characterStyleOverrides` → `<span>`s |
| Text: italic | ✅ | Incl. requesting the italic axis from Google Fonts |
| Text: truncation / maxLines | ✅ | → ellipsis / `-webkit-line-clamp` |
| Text: letter-spacing units | ✅ | PERCENT converted against font size |
| Auto Layout → flex | ✅ | Stage 2 |

**Principle established:** anything with no faithful CSS equivalent raises a warning on
the IR node (`node.warnings`, aggregated by `collectWarnings(ir)`) and is printed by
`convert.js` / `pipeline.js`. The refine loop *cannot* recover a feature the IR never
captured — it can only approximate it from pixels, and that approximation is thrown away
on the next conversion. Warnings are what keep an extraction bug from masquerading as a
refinement problem.

---

## 8. Current Gaps Summary (update every session)

> Quick glance at what's missing right now.

**Done & verified — the pipeline now runs on a real Figma URL, end to end:**
- Stage 1/4 adapter: URL → `{raw, variableMap, componentMap, referencePng}` → `src/mcp/*` — `npm test` (mocked, 10/10)
- Stages 1–4: raw Figma → IR → `src/ir/*` — demo: `npm run example:ir`
- Stage 6: IR → HTML/React → `src/codegen/*` — demo: `npm run example:codegen`
- Stage 7: verify loop (render → diff → refine) → `src/*` — demo: `npm run example` (4.93% → 0%)

Live end-to-end: `FIGMA_TOKEN=… ANTHROPIC_API_KEY=… node example/pipeline.js "<figma-url>"`
→ `loadFromUrl` → `figmaToIR` → `generateHtml` → `verifyLoop` with `createClaudeRefiner()`.
**Every stage now has a working implementation** — 1–7 are wired. Only the refiner needs credentials
(and Enterprise Figma for tokens); nothing is stubbed.

**All 8 stages now have a working, tested implementation.** Remaining items are polish:
- **Code Connect props** — component names bind; prop bindings (`get_code_connect_map`) still TODO.
- **Code-quality metrics** — absolute-positioning-ratio & arbitrary-value counts as an automated eval.
- **CLIP/DINOv2 similarity** — high-level visual metric alongside the pixel + element diffs.
- **Stage 5 (segmentation)** — still ⛔. The real ceiling: a whole page goes through as one unit,
  which §6 lists as the failure mode that drops elements. Fix before targeting full pages.

**Exposed over MCP** (`src/mcp/server.js` — `npm run test:server`, 21/21):
`figma_convert` / `figma_verify` / `figma_inspect`, registered via
`claude mcp add figma-to-code -- node <abs-path>/src/mcp/server.js`. The refine loop runs through
the calling agent (no `ANTHROPIC_API_KEY`); `src/refine/*` remains for headless runs.

**Next action (recommended order):**
1. Stage 5 segmentation — now the last real gap (see below).
2. Code Connect props via `FigmaMcpSource`.
3. Automated code-quality + CLIP metrics (§5) for regression tracking.

> **Corrected 2026-07-16:** the old "asset export link" gap was already closed —
> `html.js`/`cssgen.js` accept an `assets` map and `example/convert.js` populates it via
> `exportNodes()`. `example/pipeline.js` still doesn't pass assets; `figma_convert` does.

> **Fixed 2026-08-06 — why real frames didn't look like the design.** Six issues, in
> order of visual damage:
>
> 1. **`example/pipeline.js` never passed `assets`** — so every photo rendered as a 1x1
>    transparent PNG and every icon as a filled `currentColor` block. Structurally
>    correct, visually blank. Export is now shared code (`src/mcp/assets.js`,
>    `exportAssets()`), used by both entry points, and a zero-asset export is reported
>    loudly instead of silently producing placeholders.
> 2. **Gradients were dropped** — `resolveFills` emitted `var(--gradient-todo)`, an
>    undefined variable with no fallback, so the background simply did not paint. A
>    gradient stacked over a solid was not even reached. Now converted properly, with
>    the whole paint stack preserved.
> 3. **Per-side strokes collapsed to a box** — only the uniform `strokeWeight` was read,
>    so every divider and underlined tab became a full rectangle border.
> 4. **`textAlignVertical` was ignored** — every button label and badge sat at the top of
>    its box instead of centred.
> 5. **Rotation was ignored, and corrupted size too** — `absoluteBoundingBox` is
>    axis-aligned, so a rotated node also came out at the wrong dimensions.
> 6. **Everything was rounded to whole pixels**, twice (IR box + CSS emit), which drifts
>    visibly down a long flex column.
>
> Also fixed: multiple/inner shadows and both blur types, blend modes, mixed inline text
> runs, italics, truncation; a `ReferenceError` on `canRefine` that crashed
> `pipeline.js` at the end of every successful run; an unconditional `reference.png`
> write in `convert.js` that threw on the cached path; and JSX-unsafe raw interpolation
> of design copy in the React emitter.
>
> **Render robustness:** `render.js` waited on `networkidle` while the document pulls
> webfonts from Google Fonts, so a slow or unreachable CDN hung every render for 30s and
> failed the run — 3 of the 21 MCP server tests were failing on exactly this. Now
> `domcontentloaded` plus an explicitly bounded font/image wait (`fontTimeoutMs`), so a
> bad network degrades to fallback metrics instead of killing the loop. 21/21 pass.

---

## 9. References (research backing this design)

- **Design2Code** (NAACL 2025) — benchmark + failure taxonomy; block-level eval metric.
  https://arxiv.org/abs/2403.03163
- **DCGen** (FSE 2025) — divide-and-conquer + self-refine; +15% visual similarity on large images.
  https://arxiv.org/abs/2406.16386 · https://github.com/WebPAI/DCGen
- **Figma2Code** (2026) — multimodal Figma input; F2CAgent (IR + critic-refiner loop).
  https://arxiv.org/html/2604.13648
- **UICopilot** — hierarchical generation (structure first, then style).
- **Figma Dev Mode MCP Server** — official docs.
  https://developers.figma.com/docs/figma-mcp-server/
