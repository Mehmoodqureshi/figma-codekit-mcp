#!/usr/bin/env node
// MCP server — exposes the figma-to-code pipeline as tools an agent can call.
//
//   claude mcp add figma -- npx -y figma-codekit-mcp@latest
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
  externalizeAssets,
  copyAssetFiles,
  generateTokenFiles,
} from '../codegen/index.js';
import { pathToFileURL } from 'node:url';
import { renderHtml, renderHtmlWithBoxes, renderUrl, closeBrowser } from '../render.js';
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
const note = (msg) => process.stderr.write(`[figma-codekit-mcp] ${msg}\n`);

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

/** First dir holding a usable cached frame (raw.json), or null. */
function findCachedFrame(dirs) {
  for (const d of [...new Set(dirs)]) {
    if (d && fs.existsSync(path.join(d, 'raw.json'))) return d;
  }
  return null;
}

/**
 * Turn a convert failure into a message that says what happened and what to do.
 * A bare 403 from Figma can mean a dead token, no access to the file, or a
 * spent cost budget; /v1/me (cheap, outside the file budgets) tells them apart.
 */
async function explainConvertFailure(err, url) {
  const m = String(err?.message || err);
  const cacheHint =
    `Frames already in ${CACHE_ROOT} still work offline: figma_convert without refresh, ` +
    `figma_verify and figma_inspect need no network.`;
  if (err?.name === 'RateLimitError' || err?.name === 'FigmaBlockedError') {
    const when = err.resetAt ? ` Try again after ${err.resetAt.toISOString().replace('T', ' ').slice(0, 16)} UTC.` : '';
    return `figma_convert failed: Figma is rate-limiting this token. ${m}${when}\n${cacheHint}`;
  }
  if (err?.truncated || err?.timeout) {
    return (
      `figma_convert failed: ${m}\n→ This happens on very large files when Figma's faster per-node ` +
      `endpoint is rate-limited and the whole file has to be downloaded instead. Try again later, ` +
      `or link a smaller frame.\n${cacheHint}`
    );
  }
  if (/\b40[13]\b/.test(m)) {
    let who = null;
    try {
      const { fileKey } = parseFigmaUrl(url);
      who = await new FigmaRestSource({ token: process.env.FIGMA_TOKEN, fileKey }).checkToken();
    } catch {
      /* fall through to the generic hint */
    }
    if (who && !who.ok && (who.status === 401 || who.status === 403)) {
      return (
        `figma_convert failed: Figma rejected the token itself (HTTP ${who.status} on /v1/me).\n` +
        `→ Generate a new one in Figma → Settings → Security → Personal access tokens ` +
        `(scope: File content, read-only) and replace it where it is stored. Run --check to confirm.`
      );
    }
    if (who?.ok) {
      return (
        `figma_convert failed: ${m}\n→ The token works (signed in as ${who.handle}), but Figma refused ` +
        `this file. Either the file is not shared with that account, or Figma's cost limit for this ` +
        `file is spent (it lifts after a cooldown — often hours). Open the link in Figma while signed ` +
        `in as ${who.handle} to check access.\n${cacheHint}`
      );
    }
  }
  const hint = m.includes('404')
    ? '\n→ File key or node id not found. Check the URL points at a frame that still exists.'
    : '';
  return `figma_convert failed: ${m}${hint}`;
}


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
      inlineAssets: z
        .boolean()
        .default(false)
        .describe(
          'Embed images and vectors as data URIs (one self-contained file). Default false: they ' +
            'are written once to assets/<hash>.<ext> and referenced, which keeps generated.html small.'
        ),
      tailwind: z
        .boolean()
        .default(false)
        .describe(
          'Emit the React / Next.js output with Tailwind v4 classes instead of inline style objects ' +
            '(colours and fonts use the generated @theme tokens). The HTML stays plain CSS for verify.'
        ),
    },
  },
  async ({ url, outDir, responsive, react, next: nextApp, refresh, inlineAssets, tailwind }) => {
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
      // failFast: an interactive call answers from cache or fails in seconds,
      // never sleeps through a multi-minute Figma cooldown.
      const source = new FigmaRestSource({
        token,
        fileKey,
        failFast: true,
        fileTimeoutMs: Number(process.env.FIGMA_FILE_TIMEOUT_MS) || 90_000,
      });

      // --- 1. Figma data (cached) ---
      let raw, variableMap, componentMap, referencePng;
      const rawPath = p('raw.json');
      const refPath = p('reference.png');
      let cachedRaw = !refresh && fs.existsSync(rawPath);
      let servedStale = null;

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
          if (!raw) {
            // Nothing in this dir — but the same frame may be cached in the
            // default cache dir (outDir differs, or refresh=true). A stale frame
            // beats no frame; say clearly that it is stale and why.
            const fallback = findCachedFrame([dir, cacheDirFor(fileKey, nodeId)]);
            if (!fallback) throw err;
            ({ raw, variableMap, componentMap } = readJson(path.join(fallback, 'raw.json')));
            for (const f of ['reference.png', 'assets.json']) {
              const from = path.join(fallback, f);
              if (fallback !== dir && fs.existsSync(from) && !fs.existsSync(p(f))) fs.copyFileSync(from, p(f));
            }
            servedStale = `Figma did not answer (${err.message}), so this was built from the cached copy in ` +
              `${fallback} (fetched ${fs.statSync(path.join(fallback, 'raw.json')).mtime.toISOString().slice(0, 16).replace('T', ' ')}). ` +
              `Re-run with refresh=true later to pick up design changes.`;
            note(servedStale);
          } else note(
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
      // A stale (cached) frame keeps its cached assets too: re-exporting would hit
      // the same Figma refusal and leave every image as a placeholder.
      if ((!refresh || servedStale) && fs.existsSync(assetsPath)) {
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

      // --- 4. Design tokens (always; cheap and useful even without Tailwind) ---
      const tokenSet = generateTokenFiles(ir);
      for (const [f, contents] of Object.entries(tokenSet.files)) fs.writeFileSync(p(f), contents);

      // --- 5. Assets as files (default) or data URIs ---
      let htmlAssets = assets;
      let webAssets = assets; // what JSX / Next.js reference: /assets/<file> from public/
      let assetFiles = [];
      let assetBytes = 0;
      if (!inlineAssets) {
        const ext = externalizeAssets(assets, dir, { urlPrefix: 'assets/' });
        htmlAssets = ext.map;
        assetFiles = ext.files;
        assetBytes = ext.bytes;
        webAssets = Object.fromEntries(
          Object.entries(ext.map).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('assets/') ? `/${v}` : v])
        );
      }

      // --- 6. Codegen ---
      const html = generateHtml(ir, { title: raw.name, assets: htmlAssets, responsive });
      fs.writeFileSync(p('generated.html'), html);
      // A bound instance imports './components/<X>' — those modules have to be
      // written too or neither the JSX nor the Next.js project compiles.
      let modules = {};
      if (react) {
        fs.writeFileSync(
          p('generated.jsx'),
          generateReact(ir, { assets: webAssets, responsive, tailwind, tokenNames: tokenSet.names })
        );
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
        nextApp_ = generateNext(ir, {
          assets: webAssets,
          responsive,
          title: raw.name,
          tailwind,
          tokenNames: tokenSet.names,
          themeCss: tokenSet.files['tailwind.theme.css'],
          externalAssets: !inlineAssets,
        });
        copyAssetFiles(assetFiles, p('assets'), p(path.join('next', 'public', 'assets')));
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
        inlineAssets
          ? `Assets: ${imageFills.length} image-fill + ${vectors.length} vector requested, ${embedded} embedded as data URIs.`
          : `Assets: ${imageFills.length} image-fill + ${vectors.length} vector requested, ${embedded} exported as ` +
            `${assetFiles.length} file(s) in ${p('assets')}/ (${(assetBytes / 1024).toFixed(0)} KB)` +
            `${nextApp_ ? ' and copied to next/public/assets/' : ''}. Pass inlineAssets=true for one self-contained file.`,
        `Design tokens: ${tokenSet.counts.colors} colours, ${tokenSet.counts.fonts} fonts, ${tokenSet.counts.fontSizes} font sizes, ` +
          `${tokenSet.counts.radii} radii, ${tokenSet.counts.spacing} spacing values → ${p('tokens.json')} (DTCG), tokens.css, tailwind.theme.css.`,
        tailwind && (react || nextApp_) ? `Tailwind: React/Next.js output uses Tailwind v4 classes.` : null,
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
        servedStale ? `\nSTALE CACHE: ${servedStale}` : null,
        problems.length
          ? `\nIR validation warnings (${problems.length}): ${problems.slice(0, 3).join('; ')}`
          : null,
        ``,
        `Next: figma_verify with dir="${dir}" to render it and diff against the reference.`,
      ].filter(Boolean);

      return text(lines.join('\n'));
    } catch (err) {
      return fail(await explainConvertFailure(err, url));
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
      url: z
        .string()
        .optional()
        .describe(
          'Verify a RUNNING page instead of the generated HTML — e.g. your own app at ' +
            'http://localhost:3000/pricing, built in any framework. The page is screenshotted at the ' +
            'frame size and pixel-diffed against the Figma reference. Element/layering checks need the ' +
            "converter's data-ir-id markers, so for a URL only the pixel diff runs."
        ),
      selector: z
        .string()
        .optional()
        .describe('With url: CSS selector of the element to compare (e.g. "#pricing-card"). Default: the viewport.'),
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
  async ({ dir, htmlPath, url, selector, threshold, width, height, fullPage, includeImages }) => {
    try {
      const d = path.resolve(dir);
      const htmlFile = htmlPath ? path.resolve(htmlPath) : path.join(d, 'generated.html');
      const refFile = path.join(d, 'reference.png');
      const irFile = path.join(d, 'ir.json');

      if (url && !/^https?:\/\//i.test(url)) {
        return fail(`url must start with http:// or https:// (got ${url}). For a file, use htmlPath.`);
      }
      for (const [label, f] of [
        ...(url ? [] : [['HTML', htmlFile]]),
        ['reference PNG', refFile],
      ]) {
        if (!fs.existsSync(f)) {
          return fail(`Missing ${label}: ${f}\nRun figma_convert first.`);
        }
      }

      const html = url ? '' : fs.readFileSync(htmlFile, 'utf8');
      const referencePng = fs.readFileSync(refFile);
      const ir = fs.existsSync(irFile) ? readJson(irFile) : null;

      // Match the design frame unless told otherwise — a mismatched viewport
      // makes every element look misplaced and the diff meaningless.
      const vw = width ?? ir?.box?.width ?? 1440;
      const vh = height ?? ir?.box?.height ?? 900;
      // Figma renders references at 2x — unless the frame is too big for its
      // export limit, in which case it quietly sends a smaller image (a
      // 1440x10490 frame came back at ~1.49x). Rendering at 2x against that
      // makes every pixel "differ". Match the reference's actual scale.
      const refW = referencePng.readUInt32BE(16); // PNG IHDR width
      const scale = vw && refW ? refW / vw : 2;
      const deviceScaleFactor = Math.abs(scale - 2) < 0.01 ? 2 : Math.round(scale * 1000) / 1000;
      const renderOpts = { width: Math.round(vw), height: Math.round(vh), fullPage, deviceScaleFactor };

      // One render, both signals: screenshot + measured element boxes.
      let renderPng;
      let elementCorrection = '';
      let elementSummary = 'skipped (no ir.json)';
      let paintCorrection = '';
      let paintSummary = 'skipped (no ir.json)';

      if (url) {
        renderPng = await renderUrl(url, { ...renderOpts, selector });
        elementSummary = 'skipped (a URL has no data-ir-id markers; pixel diff only)';
        paintSummary = 'skipped (URL mode)';
      } else if (ir) {
        const expected = flattenExpectedBoxes(ir);
        const ids = expected.map((e) => e.id);
        const { png, boxes, paint } = await renderHtmlWithBoxes(html, ids, ir.id, {
          ...renderOpts,
          url: pathToFileURL(htmlFile).href,
        });
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
        renderPng = await renderHtml(html, { ...renderOpts, url: pathToFileURL(htmlFile).href });
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
        `Rendered at ${renderOpts.width}x${renderOpts.height}, compared at ${diff.width}x${diff.height} (${deviceScaleFactor}x)` +
          (deviceScaleFactor !== 2 ? ` — Figma downscaled this frame's reference (too large for a 2x export), so the render matches it.` : '.'),
        ``,
        url ? `Source: ${url}${selector ? ` → ${selector}` : ''}` : null,
        `  ${renderFile}  what your ${url ? 'page' : 'HTML'} looks like`,
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
        lines.push('', url ? `Fix the page at ${url} and call figma_verify again.` : `Edit ${htmlFile} and call figma_verify again.`);
      } else if (paintCorrection) {
        lines.push(
          `Pixel difference is at the anti-aliasing floor, but the layering is wrong:`,
          ''
        );
        lines.push(paintCorrection);
        lines.push('', url ? `Fix the page at ${url} and call figma_verify again.` : `Edit ${htmlFile} and call figma_verify again.`);
      } else {
        lines.push(`Remaining difference is at the anti-aliasing floor. Nothing to fix.`);
      }

      const result = text(lines.filter((l) => l !== null).join('\n'));

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
