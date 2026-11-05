// Stage 7 — Render: turn generated code into a screenshot with Playwright.
//
// Two entry points:
//   renderHtml(html, opts)  → for a self-contained HTML string (incl. inline CSS)
//   renderUrl(url, opts)    → for a running dev server (e.g. a React component route)
//
// Both return a PNG Buffer of the rendered viewport, so the diff step can compare
// it against the Figma reference screenshot.

import { chromium } from 'playwright';
import { measurePaint } from './paintOrder.js';

/**
 * @typedef {Object} RenderOptions
 * @property {number} [width=1440]              Viewport width in CSS px.
 * @property {number} [height=900]              Viewport height in CSS px.
 * @property {number} [deviceScaleFactor=2]     Match Figma's 2x export by default.
 * @property {boolean} [fullPage=false]         Capture the full scroll height, not just viewport.
 * @property {number} [settleMs=250]            Wait after load for fonts/images to settle.
 * @property {number} [fontTimeoutMs=5000]      Max wait for webfonts before rendering with fallbacks.
 */

/** Shared browser instance so we don't relaunch per iteration. */
let _browser = null;
async function getBrowser() {
  if (!_browser) _browser = await chromium.launch();
  return _browser;
}

/** Call once when the whole loop is finished. */
export async function closeBrowser() {
  if (_browser) {
    await _browser.close();
    _browser = null;
  }
}

/**
 * Wait for webfonts, but never longer than `fontTimeoutMs`.
 *
 * Fonts are the one remote dependency left in an otherwise self-contained
 * document (assets are embedded as data URIs), and they are fetched from Google
 * Fonts. `document.fonts.ready` alone can hang indefinitely behind a slow or
 * unreachable CDN — which, in a loop that renders on every refine iteration,
 * turns one bad network moment into a dead run rather than a slightly-off
 * screenshot. Bounding the wait degrades to fallback metrics instead of failing.
 */
async function waitForFonts(page, fontTimeoutMs) {
  if (fontTimeoutMs <= 0) return;
  try {
    await page.evaluate(
      (ms) =>
        Promise.race([
          document.fonts ? document.fonts.ready : Promise.resolve(),
          new Promise((r) => setTimeout(r, ms)),
        ]),
      fontTimeoutMs
    );
  } catch {
    /* document.fonts may be unavailable; ignore */
  }
}

/** Wait for every <img> to finish decoding — they're data URIs, so this is quick. */
async function waitForImages(page, timeoutMs = 5000) {
  try {
    await page.evaluate(
      (ms) =>
        Promise.race([
          Promise.all(
            [...document.images]
              .filter((img) => !img.complete)
              .map((img) => new Promise((r) => { img.onload = img.onerror = r; }))
          ),
          new Promise((r) => setTimeout(r, ms)),
        ]),
      timeoutMs
    );
  } catch {
    /* ignore */
  }
}

async function screenshotPage(page, { fullPage = false, settleMs = 250, fontTimeoutMs = 5000 } = {}) {
  // Give web fonts + images a moment; avoids diffing a half-rendered frame.
  await waitForFonts(page, fontTimeoutMs);
  await waitForImages(page, fontTimeoutMs);
  if (settleMs > 0) await page.waitForTimeout(settleMs);
  return page.screenshot({ type: 'png', fullPage });
}

/**
 * Render a self-contained HTML string and return a PNG buffer.
 * @param {string} html
 * @param {RenderOptions} [opts]
 * @returns {Promise<Buffer>}
 */
export async function renderHtml(html, opts = {}) {
  const {
    width = 1440,
    height = 900,
    deviceScaleFactor = 2,
    fullPage = false,
    settleMs = 250,
    fontTimeoutMs = 5000,
  } = opts;

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor,
  });
  const page = await context.newPage();
  try {
    // From a file URL when given, so relative assets (assets/<hash>.png) load;
    // otherwise the self-contained string as before.
    if (opts.url) await page.goto(opts.url, { waitUntil: 'load' });
    else await page.setContent(html, { waitUntil: 'load' });
    // A small document (assets as files) is laid out before its @import-ed
    // webfont CSS has even arrived, and document.fonts.ready resolves early
    // when no font has been requested yet — so wait for the network to go
    // quiet first. Bounded: a dead font CDN degrades, it never hangs the loop.
    await page.waitForLoadState('networkidle', { timeout: fontTimeoutMs }).catch(() => {});
    return await screenshotPage(page, { fullPage, settleMs, fontTimeoutMs });
  } finally {
    await context.close();
  }
}

/**
 * Render a self-contained HTML string and return the screenshot, the rendered
 * bounding boxes of the given element ids (frame-relative to `rootId`), and the
 * paint-order / clipping measurements. One render, every signal — the IoU check
 * wants the boxes, the paint check wants the stacking, and rendering twice for
 * them would double the slowest step in the loop.
 * @param {string} html
 * @param {string[]} ids       data-ir-id values to measure.
 * @param {string} rootId      data-ir-id of the frame root (origin for coords).
 * @param {RenderOptions & {paintGrid?: number, paintMaxPoints?: number}} [opts]
 * @returns {Promise<{
 *   png: Buffer,
 *   boxes: Object<string,{x,y,w,h}|null>,
 *   paint: {pairs: Array<{front:string,back:string,samples:number}>, clip: Object<string,number|null>}
 * }>}
 */
export async function renderHtmlWithBoxes(html, ids, rootId, opts = {}) {
  const {
    width = 1440,
    height = 900,
    deviceScaleFactor = 2,
    fullPage = false,
    settleMs = 250,
    fontTimeoutMs = 5000,
    paintGrid = 48,
    paintMaxPoints = 40000,
  } = opts;

  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor });
  const page = await context.newPage();
  try {
    // From a file URL when given, so relative assets (assets/<hash>.png) load;
    // otherwise the self-contained string as before.
    if (opts.url) await page.goto(opts.url, { waitUntil: 'load' });
    else await page.setContent(html, { waitUntil: 'load' });
    // A small document (assets as files) is laid out before its @import-ed
    // webfont CSS has even arrived, and document.fonts.ready resolves early
    // when no font has been requested yet — so wait for the network to go
    // quiet first. Bounded: a dead font CDN degrades, it never hangs the loop.
    await page.waitForLoadState('networkidle', { timeout: fontTimeoutMs }).catch(() => {});
    const png = await screenshotPage(page, { fullPage, settleMs, fontTimeoutMs });
    const boxes = await page.evaluate(
      ({ ids, rootId }) => {
        const root = document.querySelector(`[data-ir-id=${JSON.stringify(rootId)}]`);
        const rb = root ? root.getBoundingClientRect() : { left: 0, top: 0 };
        const out = {};
        for (const id of ids) {
          const el = document.querySelector(`[data-ir-id=${JSON.stringify(id)}]`);
          out[id] = el
            ? (() => {
                const r = el.getBoundingClientRect();
                return { x: r.left - rb.left, y: r.top - rb.top, w: r.width, h: r.height };
              })()
            : null;
        }
        return out;
      },
      { ids, rootId }
    );
    // Paint order is measured after the screenshot: it briefly overrides
    // pointer-events so hit-testing can see decorative overlays, and that must
    // not be in effect while the frame is captured.
    const paint = await page.evaluate(measurePaint, {
      ids,
      rootId,
      grid: paintGrid,
      maxPoints: paintMaxPoints,
    });
    return { png, boxes, paint };
  } finally {
    await context.close();
  }
}

/**
 * Render a running URL (dev server) and return a PNG buffer.
 * @param {string} url
 * @param {RenderOptions} [opts]
 * @returns {Promise<Buffer>}
 */
export async function renderUrl(url, opts = {}) {
  const {
    width = 1440,
    height = 900,
    deviceScaleFactor = 2,
    fullPage = false,
    settleMs = 250,
    fontTimeoutMs = 5000,
  } = opts;

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor,
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle', { timeout: fontTimeoutMs }).catch(() => {});
    if (opts.selector) {
      // Compare one element of a real app (a card, a section) with its frame.
      const el = page.locator(opts.selector).first();
      await el.waitFor({ state: 'visible', timeout: opts.selectorTimeoutMs ?? 10_000 });
      await waitForFonts(page, fontTimeoutMs);
      await waitForImages(page, fontTimeoutMs);
      if (settleMs > 0) await page.waitForTimeout(settleMs);
      return await el.screenshot({ type: 'png' });
    }
    return await screenshotPage(page, { fullPage, settleMs, fontTimeoutMs });
  } finally {
    await context.close();
  }
}
