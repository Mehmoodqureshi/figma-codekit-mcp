#!/usr/bin/env node
// MCP server — exposes the figma-to-code pipeline as tools an agent can call.
//
//   claude mcp add figma -- npx -y mcp-figma-to-code@latest
//
// Design notes:
//
// • This is the INVERSE of src/mcpSource.js. That file makes the pipeline a
//   *client* of Figma's Dev Mode MCP server. This file makes the pipeline a
//   *server* that an agent (Claude Code) drives.
//
// • The refine loop runs through the CALLING AGENT, not an internal LLM. The
//   agent calls figma_convert, edits the HTML, calls figma_verify, repeats.
//   No ANTHROPIC_API_KEY needed — src/refine/* stays for headless use.
//
// • Tools return FILE PATHS and NUMBERS, never large blobs. A generated frame
//   is often 100+ KB of HTML; pushing that through tool results would burn the
//   agent's context. The agent reads/edits the files directly instead.
//
// • STDIO TRANSPORT: stdout is the protocol channel. Never console.log here —
//   diagnostics go to stderr via note(). The library code we call uses
//   console.warn (stderr), which is safe.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { FigmaRestSource, loadFrame, parseFigmaUrl } from './index.js';
import { figmaToIR, validateNode, ROLES } from '../ir/index.js';
import {
  generateHtml,
  generateReact,
  generateNext,
  generateComponentModules,
} from '../codegen/index.js';
import { renderHtml, renderHtmlWithBoxes, closeBrowser } from '../render.js';
import { diffImages } from '../diff.js';
import { buildCorrectionPrompt } from '../correction.js';
import {
  flattenExpectedBoxes,
  computeElementDiffs,
  buildElementCorrection,
} from '../elementDiff.js';
import {
  expectedPaintOrder,
  computePaintDiffs,
  buildPaintCorrection,
} from '../paintOrder.js';
import { loadCredentials } from '../config/credentials.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Cache and credentials live next to the USER's project, not next to this
// package. Installed via npx the package root is a throwaway directory inside
// node_modules — writing a 100 MB frame cache there means it is silently lost on
// the next install, and a `.figma-token` there could never be found at all.
// An MCP host launches the server with the project as cwd, so cwd is the right
// anchor; FIGMA_MCP_CACHE_DIR overrides it for anyone who wants it elsewhere.
const CACHE_ROOT = process.env.FIGMA_MCP_CACHE_DIR
  ? path.resolve(process.env.FIGMA_MCP_CACHE_DIR)
  : path.join(process.cwd(), '.figma-cache');

// cwd first, then the package root (a git checkout run in place). An env var
// already set always wins, so the second call only fills what the first missed.
// Remember WHERE the token came from (never its value) for `--check`.
const tokenFromEnv = Boolean(process.env.FIGMA_TOKEN || process.env.FIGMA_API_KEY);
const tokenFromCwd = loadCredentials(process.cwd()).includes('FIGMA_TOKEN'); // .figma-token → FIGMA_TOKEN
const tokenFromRoot = loadCredentials(ROOT).includes('FIGMA_TOKEN');
const tokenSource = tokenFromEnv
  ? 'environment'
  : tokenFromCwd
    ? path.join(process.cwd(), '.figma-token')
    : tokenFromRoot
      ? path.join(ROOT, '.figma-token')
      : null;

// `--check` / `--install-browser` are one-shot setup commands, not a server:
// they run before the stdio transport exists, so stdout is free for the report.
if (process.argv.includes('--check')) {
  const { runCheck } = await import('./doctor.js');
  process.exit((await runCheck({ tokenSource, cacheRoot: CACHE_ROOT })) ? 0 : 1);
}
if (process.argv.includes('--install-browser')) {
  const { installBrowser } = await import('./doctor.js');
  installBrowser();
  process.exit(0);
}

/** Diagnostics to stderr — stdout belongs to the MCP protocol. */
const note = (msg) => process.stderr.write(`[mcp-figma-to-code] ${msg}\n`);

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

const pct = (n) => `${(n * 100).toFixed(2)}%`;

/**
 * Was this raw tree fetched with `geometry=paths`?
 *
 * Only then does Figma include `relativeTransform`, and only that matrix
 * distinguishes a rotated node from a mirrored one. A cache without it predates
 * the fix and has to be refetched rather than trusted.
 */
function hasTransforms(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.relativeTransform)) return true;
  return (node.children || []).some(hasTransforms);
}

function requireToken() {
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new Error(
      'No Figma token. Set FIGMA_TOKEN, or put one in .figma-token in your project directory. ' +
        'Get it from Figma → Settings → Personal access tokens (scope: File content read).'
    );
  }
  return token;
}

/** Stable, collision-free cache dir per frame. */
function cacheDirFor(fileKey, nodeId, override) {
  if (override) return path.resolve(override);
  return path.join(CACHE_ROOT, `${fileKey}-${nodeId.replace(':', '-')}`);
}

/**
 * Nodes needing a real asset: image fills → the original bitmap, vector
 * clusters → SVG. `style.imageFill` carries the Figma imageRef, which lets the
 * photo be fetched from the image-fill endpoint rather than re-rendered.
 */
function collectAssets(node, acc = { imageFills: [], imageNodes: [], vectors: [] }) {
  const fill = node.style?.imageFill;
  // A string is a real imageRef (look the bitmap up); `true` means the paint had
  // none, so the node itself has to be rendered.
  if (typeof fill === 'string') acc.imageFills.push({ id: node.id, ref: fill });
  else if (fill) acc.imageNodes.push(node.id);
  if (node.role === ROLES.VECTOR) acc.vectors.push(node.id);
  (node.children || []).forEach((c) => collectAssets(c, acc));
  return acc;
}

/** Count IR nodes by role, for the convert summary. */
/** Count IR warnings by their WARN code, so the summary can flag whole classes. */
function warningCounts(node, acc = {}) {
  for (const w of node.warnings || []) {
    const code = String(w).split(':')[0];
    acc[code] = (acc[code] || 0) + 1;
  }
  (node.children || []).forEach((c) => warningCounts(c, acc));
  return acc;
}

function roleCounts(node, acc = {}) {
  acc[node.role] = (acc[node.role] || 0) + 1;
  (node.children || []).forEach((c) => roleCounts(c, acc));
  return acc;
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const { name, version } = readJson(path.join(ROOT, 'package.json'));
const server = new McpServer({ name, version });

// ---------------------------------------------------------------------------
// figma_convert — Figma URL → IR + assets + HTML on disk. The deterministic pass.
// ---------------------------------------------------------------------------
server.registerTool(
  'figma_convert',
  {
    title: 'Convert a Figma frame to code',
    description:
      'Fetch a Figma frame and deterministically convert it to self-contained HTML (no LLM). ' +
      'Writes generated.html, reference.png, ir.json and assets.json to a cache dir and returns ' +
      'the paths plus a summary. Pass react=true for a component file, or next=true for a ' +
      'runnable Next.js App Router project you can npm install && npm run dev. Figma responses are cached, so re-running is offline and free ' +
      'unless refresh=true. Follow with figma_verify to see how close the render is.',
    inputSchema: {
      url: z
        .string()
        .describe('Figma frame URL, e.g. https://www.figma.com/design/KEY/Name?node-id=1-2'),
      outDir: z
        .string()
        .optional()
        .describe('Where to write output. Defaults to .figma-cache/<fileKey>-<nodeId>/'),
      responsive: z
        .boolean()
        .default(false)
        .describe(
          'Emit the responsive variant (Figma FILL→flex/100%, HUG→fit-content, FIXED→px kept) ' +
            'instead of the exact-sizing variant. A frame with NO Auto Layout has no sizing ' +
            'intent to relax, so it keeps its exact CSS and is scaled to fit the viewport ' +
            'instead — otherwise its absolutely-placed children stay pinned to the design ' +
            'canvas and get clipped rather than reflowed. Exact is still the right starting ' +
            'point for verify.'
        ),
      react: z
        .boolean()
        .default(false)
        .describe(
          'Also emit generated.jsx (React with inline styles) alongside the HTML, plus ' +
            'components/<Name>.jsx for every Code Connect binding it imports.'
        ),
      next: z
        .boolean()
        .default(false)
        .describe(
          'Also emit next/ — a runnable Next.js App Router project (package.json, ' +
            'next.config.mjs, app/layout.jsx, app/page.jsx, app/globals.css and the ' +
            'component) that you can npm install && npm run dev as it stands.'
        ),
      refresh: z
        .boolean()
        .default(false)
        .describe('Ignore the cache and re-fetch from the Figma API.'),
    },
  },
  async ({ url, outDir, responsive, react, next: nextApp, refresh }) => {
    try {
      const token = requireToken();
      const { fileKey, nodeId } = parseFigmaUrl(url);
      if (!fileKey || !nodeId) {
        return fail(
          `Could not parse a fileKey and node-id from that URL.\n` +
            `Expected something like https://www.figma.com/design/KEY/Name?node-id=1-2\n` +
            `Make sure you copied the link to a specific frame (right-click frame → Copy link).`
        );
      }

      const dir = cacheDirFor(fileKey, nodeId, outDir);
      fs.mkdirSync(dir, { recursive: true });
      const p = (f) => path.join(dir, f);
      const source = new FigmaRestSource({ token, fileKey });

      // --- 1. Figma data (cached) ---
      let raw, variableMap, componentMap, referencePng;
      const rawPath = p('raw.json');
      const refPath = p('reference.png');
      let cachedRaw = !refresh && fs.existsSync(rawPath);

      if (cachedRaw) {
        ({ raw, variableMap, componentMap } = readJson(rawPath));
        // Entries written before the fetch asked for geometry=paths carry no
        // relativeTransform, so every rotation and every mirror in them was
        // silently dropped. Serving that cache would keep handing back the same
        // wrong frame forever, so re-fetch it — but keep the stale copy if
        // Figma is rate-limited, since a stale frame still beats no frame.
        if (!hasTransforms(raw)) {
          note(`cache is pre-transform (no relativeTransform); re-fetching ${rawPath}`);
          cachedRaw = false;
        } else {
          note(`cache hit: ${rawPath}`);
        }
      }

      if (!cachedRaw) {
        note(`fetching ${fileKey} node ${nodeId} from Figma...`);
        const haveRef = !refresh && fs.existsSync(refPath);
        try {
          ({ raw, variableMap, componentMap, referencePng } = await loadFrame(source, nodeId, {
            screenshot: !haveRef,
          }));
          fs.writeFileSync(rawPath, JSON.stringify({ raw, variableMap, componentMap }));
          if (referencePng) fs.writeFileSync(refPath, referencePng);
        } catch (err) {
          if (!raw) throw err; // nothing cached to fall back to
          note(
            `re-fetch failed (${err.message}); using the pre-transform cache. ` +
              `Rotations survive via the bounding box, but mirrored nodes cannot be ` +
              `recovered from it — re-run once Figma answers again.`
          );
        }
      }

      // --- 2. IR ---
      const ir = figmaToIR(raw, { variableMap, componentMap });
      const problems = validateNode(ir);
      fs.writeFileSync(p('ir.json'), JSON.stringify(ir));

      // --- 3. Assets (cached; a failed batch degrades to placeholders) ---
      const assetsPath = p('assets.json');
      const { imageFills, imageNodes, vectors } = collectAssets(ir);
      let assets = {};
      if (!refresh && fs.existsSync(assetsPath)) {
        assets = readJson(assetsPath);
      } else {
        const tryExport = async (label, fn) => {
          try {
            Object.assign(assets, await fn());
          } catch (e) {
            note(`${label} export partially failed: ${e.message}`);
          }
        };
        // Photos come from the image-fill endpoint (own cost budget, original
        // bitmap). Only vectors need node rendering.
        if (imageFills.length) {
          await tryExport('image-fill', () => source.exportImageFills(imageFills));
        }
        // Anything the lookup couldn't serve, plus paints that never had a ref.
        const render = [...imageNodes, ...imageFills.filter((e) => !assets[e.id]).map((e) => e.id)];
        if (render.length) {
          note(`${render.length} image(s) need node rendering (no usable imageRef).`);
          await tryExport('png', () => source.exportNodes(render, 'png', 2, 300));
        }
        if (vectors.length) {
          await tryExport('svg', () => source.exportNodes(vectors, 'svg', 1, 300));
        }
        if (Object.values(assets).filter(Boolean).length > 0) {
          fs.writeFileSync(assetsPath, JSON.stringify(assets));
        }
      }
      const embedded = Object.values(assets).filter(Boolean).length;

      // --- 4. Codegen ---
      const html = generateHtml(ir, { title: raw.name, assets, responsive });
      fs.writeFileSync(p('generated.html'), html);
      // A bound instance imports './components/<X>' — those modules have to be
      // written too or neither the JSX nor the Next.js project compiles.
      let modules = {};
      if (react) {
        fs.writeFileSync(p('generated.jsx'), generateReact(ir, { assets, responsive }));
        modules = generateComponentModules(ir);
        if (Object.keys(modules).length) {
          fs.mkdirSync(p('components'), { recursive: true });
          for (const [file, src] of Object.entries(modules)) {
            fs.writeFileSync(path.join(p('components'), file), src);
          }
        }
      }

      let nextApp_ = null;
      if (nextApp) {
        nextApp_ = generateNext(ir, { assets, responsive, title: raw.name });
        // Everything under next/ so the directory is a project you can copy out
        // whole rather than pick files apart.
        for (const [rel, contents] of Object.entries(nextApp_.files)) {
          const dest = p(path.join('next', rel));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, contents);
        }
      }
      // Reported below so the agent knows WHICH responsive strategy it got.
      const canvasFit = responsive && ir.layout?.mode === 'absolute';

      const counts = roleCounts(ir);
      const warnCounts = warningCounts(ir);
      const mirrorUnknown = warnCounts.MIRROR_UNKNOWN || 0;
      const countLine = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([r, n]) => `${n} ${r}`)
        .join(', ');
      const tokenCount = Object.keys(variableMap).length;

      const lines = [
        `Converted "${raw.name}" (${raw.type}) — ${ir.box.width}x${ir.box.height}`,
        ``,
        `  ${p('generated.html')}   ${(html.length / 1024).toFixed(0)} KB${
          responsive ? (canvasFit ? ' (responsive — scaled canvas)' : ' (responsive — fluid)') : ' (exact sizing)'
        }`,
        `  ${p('reference.png')}    the Figma render — the target`,
        `  ${p('ir.json')}          ${Object.values(counts).reduce((a, b) => a + b, 0)} nodes: ${countLine}`,
        react ? `  ${p('generated.jsx')}   React variant` : null,
        react && Object.keys(modules).length
          ? `  ${p('components')}/       ${Object.keys(modules).length} bound component(s): ` +
            `${Object.keys(modules)
              .map((f) => f.replace(/\.jsx$/, ''))
              .join(', ')}`
          : null,
        nextApp_
          ? `  ${p('next')}/             Next.js project (${
              Object.keys(nextApp_.files).length
            } files) — cd there, npm install && npm run dev`
          : null,
        ``,
        `Assets: ${imageFills.length} image-fill + ${vectors.length} vector requested, ${embedded} embedded as data URIs.`,
        `Tokens: ${tokenCount} Figma variables resolved${tokenCount === 0 ? ' (none — the Variables API is Enterprise-only, so colors are exact literals)' : ''}.`,
        `Components: ${Object.keys(componentMap).length} bound by name (prop bindings need Code Connect).`,
        mirrorUnknown
          ? `\nDEGRADED GEOMETRY: ${mirrorUnknown} rotated node(s) arrived with \`rotation\` but no ` +
            `\`relativeTransform\` — the whole-file endpoint, which getNode() falls back to when ` +
            `/nodes is rate-limited, omits it. A mirrored node is indistinguishable from a rotated ` +
            `one in that payload, so those nodes render flipped about their own centre. Re-run with ` +
            `refresh=true once the /nodes budget has reset to get the real transform.`
          : null,
        canvasFit
          ? `\nThis frame has no Auto Layout on the root, so there is no sizing intent to turn into ` +
            `flex/%. The exact ${ir.box.width}x${ir.box.height} canvas is kept and scaled to the ` +
            `viewport instead (floor 0.5x, then the page scrolls). Add Auto Layout in Figma if you ` +
            `want real reflow rather than proportional scaling.`
          : null,
        cachedRaw ? `\n(Served from cache. Pass refresh=true to re-fetch.)` : null,
        problems.length
          ? `\nIR validation warnings (${problems.length}): ${problems.slice(0, 3).join('; ')}`
          : null,
        ``,
        `Next: figma_verify with dir="${dir}" to render it and diff against the reference.`,
      ].filter(Boolean);

      return text(lines.join('\n'));
    } catch (err) {
      if (err.name === 'RateLimitError') {
        return fail(
          `figma_convert failed: ${err.message}\n\n` +
            `Rate limit resets around ${err.resetAt.toLocaleString()}.\n` +
            `Until then: any frame already in .figma-cache/ still works offline — ` +
            `figma_verify and figma_inspect need no network at all.`
        );
      }
      const m = String(err.message);
      const hint = m.includes('403')
        ? '\n→ The token lacks access to this file, or the file is not shared with that account.'
        : m.includes('404')
          ? '\n→ File key or node id not found. Check the URL points at a frame that still exists.'
          : '';
      return fail(`figma_convert failed: ${m}${hint}`);
    }
  }
);

// ---------------------------------------------------------------------------
// figma_verify — render HTML, diff vs the Figma reference, say what to fix.
// This is the loop: the CALLING AGENT reads the correction, edits the HTML,
// and calls this again. No internal LLM.
// ---------------------------------------------------------------------------
server.registerTool(
  'figma_verify',
  {
    title: 'Verify rendered code against the Figma design',
    description:
      'Render an HTML file in Chromium, pixel-diff it against the Figma reference, and check each ' +
      'element position with bounding-box IoU, paint order (z-index) and clipping. Returns the diff ' +
      'ratio plus specific instructions on what to fix (MISSING / MISPLACED / WRONG STACKING / ' +
      'OVER-CLIPPED elements, worst regions). Writes render.png and diff.png. ' +
      'Edit the HTML based on the correction and call this again to iterate toward pixel-exact. ' +
      'Read the returned diff.png to see the mismatches highlighted.',
    inputSchema: {
      dir: z
        .string()
        .describe('Cache dir from figma_convert. Supplies reference.png and ir.json.'),
      htmlPath: z
        .string()
        .optional()
        .describe('HTML file to verify. Defaults to <dir>/generated.html.'),
      threshold: z
        .number()
        .default(0.02)
        .describe('Diff ratio considered "exact enough". Anti-aliasing puts a floor near 0.005-0.015.'),
      width: z
        .number()
        .optional()
        .describe('Viewport width. Defaults to the design frame width from the IR.'),
      height: z
        .number()
        .optional()
        .describe('Viewport height. Defaults to the design frame height from the IR.'),
      fullPage: z
        .boolean()
        .default(false)
        .describe('Capture full scroll height rather than just the viewport.'),
      includeImages: z
        .boolean()
        .default(false)
        .describe(
          'Attach reference/render/diff PNGs to the response. Costs a lot of context — prefer ' +
            'reading diff.png from disk only when the numbers alone are not enough.'
        ),
    },
  },
  async ({ dir, htmlPath, threshold, width, height, fullPage, includeImages }) => {
    try {
      const d = path.resolve(dir);
      const htmlFile = htmlPath ? path.resolve(htmlPath) : path.join(d, 'generated.html');
      const refFile = path.join(d, 'reference.png');
      const irFile = path.join(d, 'ir.json');

      for (const [label, f] of [
        ['HTML', htmlFile],
        ['reference PNG', refFile],
      ]) {
        if (!fs.existsSync(f)) {
          return fail(`Missing ${label}: ${f}\nRun figma_convert first.`);
        }
      }

      const html = fs.readFileSync(htmlFile, 'utf8');
      const referencePng = fs.readFileSync(refFile);
      const ir = fs.existsSync(irFile) ? readJson(irFile) : null;

      // Match the design frame unless told otherwise — a mismatched viewport
      // makes every element look misplaced and the diff meaningless.
      const vw = width ?? ir?.box?.width ?? 1440;
      const vh = height ?? ir?.box?.height ?? 900;
      const renderOpts = { width: Math.round(vw), height: Math.round(vh), fullPage };

      // One render, both signals: screenshot + measured element boxes.
      let renderPng;
      let elementCorrection = '';
      let elementSummary = 'skipped (no ir.json)';
      let paintCorrection = '';
      let paintSummary = 'skipped (no ir.json)';

      if (ir) {
        const expected = flattenExpectedBoxes(ir);
        const ids = expected.map((e) => e.id);
        const { png, boxes, paint } = await renderHtmlWithBoxes(html, ids, ir.id, renderOpts);
        renderPng = png;
        const findings = computeElementDiffs(expected, boxes);
        elementCorrection = buildElementCorrection(findings, { rootId: ir.id });
        const missing = findings.filter((f) => f.status === 'missing').length;
        const misplaced = findings.filter((f) => f.status === 'misplaced').length;
        const ok = findings.filter((f) => f.status === 'ok').length;
        elementSummary = `${ok}/${findings.length} elements match (IoU >= 0.6) — ${missing} missing, ${misplaced} misplaced`;

        // Right box, wrong layer: a z-order or clipping mistake moves nothing
        // and barely shifts the diff ratio, so it needs its own check.
        const paintFindings = computePaintDiffs(expectedPaintOrder(ir), paint);
        paintCorrection = buildPaintCorrection(paintFindings);
        paintSummary =
          paintFindings.stacking.length || paintFindings.clipping.length
            ? `${paintFindings.stacking.length} wrong stacking, ${paintFindings.clipping.length} over-clipped`
            : 'paint order and clipping match the design';
      } else {
        renderPng = await renderHtml(html, renderOpts);
      }

      const diff = diffImages(renderPng, referencePng);
      const renderFile = path.join(d, 'render.png');
      const diffFile = path.join(d, 'diff.png');
      fs.writeFileSync(renderFile, renderPng);
      fs.writeFileSync(diffFile, diff.diffPng);

      const converged = diff.diffRatio <= threshold;
      const correction = buildCorrectionPrompt(diff, { iteration: 1 });

      const lines = [
        converged && paintCorrection
          ? `NOT CONVERGED — pixels are within threshold (${pct(diff.diffRatio)}) but the layering is wrong.`
          : converged
            ? `CONVERGED — ${pct(diff.diffRatio)} of pixels differ (threshold ${pct(threshold)}).`
            : `NOT CONVERGED — ${pct(diff.diffRatio)} of pixels differ (threshold ${pct(threshold)}).`,
        `Elements: ${elementSummary}`,
        `Layering: ${paintSummary}`,
        `Rendered at ${renderOpts.width}x${renderOpts.height}, compared at ${diff.width}x${diff.height} (2x).`,
        ``,
        `  ${renderFile}  what your HTML looks like`,
        `  ${diffFile}    highlighted = differs (read this image to see where)`,
        ``,
      ];

      // Layering problems are reported even when the pixel diff converges: a
      // decorative overlay on the wrong side of a card can shift too few pixels
      // to clear the threshold while still being the first thing a human sees.
      if (!converged) {
        if (elementCorrection) lines.push(elementCorrection, '');
        if (paintCorrection) lines.push(paintCorrection, '');
        lines.push(correction);
        lines.push('', `Edit ${htmlFile} and call figma_verify again.`);
      } else if (paintCorrection) {
        lines.push(
          `Pixel difference is at the anti-aliasing floor, but the layering is wrong:`,
          ''
        );
        lines.push(paintCorrection);
        lines.push('', `Edit ${htmlFile} and call figma_verify again.`);
      } else {
        lines.push(`Remaining difference is at the anti-aliasing floor. Nothing to fix.`);
      }

      const result = text(lines.join('\n'));

      if (includeImages) {
        const img = (buf) => ({
          type: 'image',
          data: buf.toString('base64'),
          mimeType: 'image/png',
        });
        result.content.push(
          { type: 'text', text: 'Figma reference (the target):' },
          img(referencePng),
          { type: 'text', text: 'Your render:' },
          img(renderPng),
          { type: 'text', text: 'Pixel diff (highlighted = differs):' },
          img(diff.diffPng)
        );
      }

      return result;
    } catch (err) {
      return fail(`figma_verify failed: ${err.message}`);
    }
  }
);

// ---------------------------------------------------------------------------
// figma_inspect — summarize the IR without dumping the whole tree into context.
// ---------------------------------------------------------------------------
server.registerTool(
  'figma_inspect',
  {
    title: 'Inspect the design structure',
    description:
      'Print the IR tree as an indented outline (role, name, box, layout, text, tokens) so you can ' +
      'understand the design structure and find a specific element without reading raw Figma JSON ' +
      'or the whole ir.json. Use after figma_convert.',
    inputSchema: {
      dir: z.string().describe('Cache dir from figma_convert.'),
      depth: z.number().default(4).describe('Max tree depth to print.'),
      filter: z
        .string()
        .optional()
        .describe('Only show nodes whose name or text matches this (case-insensitive substring).'),
    },
  },
  async ({ dir, depth, filter }) => {
    try {
      const irFile = path.join(path.resolve(dir), 'ir.json');
      if (!fs.existsSync(irFile)) return fail(`No ir.json in ${dir}. Run figma_convert first.`);
      const ir = readJson(irFile);
      const needle = filter?.toLowerCase();
      const out = [];

      const walk = (n, d = 0) => {
        if (d > depth) return;
        const box = `${Math.round(n.box.width)}x${Math.round(n.box.height)} @${Math.round(n.box.x)},${Math.round(n.box.y)}`;
        const layout = n.layout?.mode && n.layout.mode !== 'NONE'
          ? ` flex:${String(n.layout.mode).toLowerCase()}${n.layout.gap ? ` gap:${n.layout.gap}` : ''}`
          : '';
        const txt = n.text?.content ? ` "${n.text.content.slice(0, 40).replace(/\n/g, ' ')}"` : '';
        const comp = n.component?.name ? ` <${n.component.name}>` : '';
        const toks = n.tokens && Object.keys(n.tokens).length ? ` tokens:${Object.keys(n.tokens).length}` : '';
        const line = `${'  '.repeat(d)}${n.role} ${n.name} [${box}]${layout}${txt}${comp}${toks}`;
        if (!needle || line.toLowerCase().includes(needle)) out.push(line);
        (n.children || []).forEach((c) => walk(c, d + 1));
      };
      walk(ir);

      if (!out.length) return text(`No nodes matched "${filter}".`);
      const capped = out.slice(0, 300);
      if (out.length > capped.length) capped.push(`... ${out.length - capped.length} more (raise depth or use filter)`);
      return text(capped.join('\n'));
    } catch (err) {
      return fail(`figma_inspect failed: ${err.message}`);
    }
  }
);

// ---------------------------------------------------------------------------

async function shutdown() {
  try {
    await closeBrowser();
  } catch {
    /* already gone */
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
note(`ready — ${process.env.FIGMA_TOKEN ? 'token loaded' : 'NO TOKEN (set .figma-token)'}`);
