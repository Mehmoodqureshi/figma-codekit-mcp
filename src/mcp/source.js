// Stage 1 — Figma REST source (the primary adapter).
//
// Implements the Source interface the pipeline consumes:
//   getNode(nodeId)            → raw Figma node tree (the shape normalize/figmaToIR expect)
//   getVariableMap()           → { 'VariableID:...': 'token/name' }
//   getComponentMap(nodeId)    → { '<componentId>': { name, props } }
//   getScreenshotPng(nodeId)   → PNG Buffer (the verify loop's reference)
//   exportSvgs(nodeIds)        → { '<id>': '<svg string>' }
//
// Why REST and not the Dev Mode MCP server for structured data: the REST API
// returns the node tree with id-keyed `boundVariables` and an id-keyed `components`
// dict — which is exactly what the IR needs to bind tokens/components. The MCP
// server is oriented toward emitting code, so it's used here mainly for screenshots
// (see mcpSource.js).
//
// `fetch` is injectable so this is unit-testable without network access.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildVariableMap, buildComponentMap } from './transform.js';

/** Default ceiling on any single backoff sleep. See _getJson(). */
const MAX_RETRY_WAIT_MS = 60_000;

/** Project root — two levels up from src/mcp/. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Where the /nodes lockout is remembered between runs. See _isBlocked() for why
 * this has to survive process exit.
 */
const LOCKOUT_FILE = path.join(ROOT, '.figma-nodes-lockout.json');

/** How long to assume /nodes stays locked when Figma 403s without a Retry-After. */
const DEFAULT_LOCKOUT_SEC = 40 * 3600;

/**
 * Quiet period to observe after a blocked /nodes before touching the API again.
 *
 * Measured against the live API: probing during the cooldown RESETS it — attempts
 * at 2/7/18/39/69s all 403'd, while 60s of total silence followed by ONE request
 * returned 200. So this is a sleep, not a poll interval.
 */
const COOLDOWN_QUIET_MS = 60_000;

/** Ceiling on the whole cooldown-recovery dance. */
const RECOVERY_TIMEOUT_MS = 240_000;

/**
 * Thrown when Figma says "come back later" and later is further off than we're
 * willing to sleep. Carries the reset time so callers can tell the user WHEN,
 * rather than just failing.
 */
export class RateLimitError extends Error {
  constructor(path, retryAfterSec) {
    const hours = retryAfterSec / 3600;
    const readable =
      hours >= 1 ? `${hours.toFixed(1)} hours` : `${Math.round(retryAfterSec / 60)} minutes`;
    super(
      `Figma rate limit exhausted on ${path}. Retry-After is ${retryAfterSec}s (~${readable}) — ` +
        `refusing to sleep that long. Figma rate-limits by cost, so a heavy file fetched repeatedly ` +
        `can lock a token out for many hours. Use cached data until it resets.`
    );
    this.name = 'RateLimitError';
    this.retryAfterSec = retryAfterSec;
    this.resetAt = new Date(Date.now() + retryAfterSec * 1000);
  }
}

/**
 * Thrown in fail-fast mode when Figma has the token in a cooldown and waiting it
 * out would take minutes. Carries the remembered reset time (if any) so the
 * caller can say WHEN, and fall back to cached data instead of hanging.
 */
export class FigmaBlockedError extends Error {
  constructor(path, resetAt, cause) {
    super(
      `Figma refused ${path} (${cause?.message || 'blocked'}). ` +
        (resetAt
          ? `The /nodes budget is locked until ${new Date(resetAt).toISOString()}.`
          : `The token is in Figma's cost-based cooldown.`)
    );
    this.name = 'FigmaBlockedError';
    this.status = cause?.status;
    this.resetAt = resetAt ? new Date(resetAt) : null;
  }
}

/**
 * Depth-first search for a node id in a whole-file document tree.
 * Iterative — design files nest deeply enough to make recursion a gamble.
 *
 * @param {Object} root   The `document` from /v1/files/:key.
 * @param {string} nodeId Colon-form id, e.g. "1:2".
 * @returns {Object|null} The node, or null if absent.
 */
export function findNodeById(root, nodeId) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node?.id === nodeId) return node;
    if (node?.children) stack.push(...node.children);
  }
  return null;
}

export class FigmaRestSource {
  /**
   * @param {Object} opts
   * @param {string} opts.token     Figma personal access token (X-Figma-Token).
   * @param {string} opts.fileKey   File key (from the URL).
   * @param {Function} [opts.fetch] fetch implementation (defaults to global fetch).
   * @param {string} [opts.baseUrl] API base (default https://api.figma.com).
   * @param {number} [opts.maxRetryWaitMs=60000]  Ceiling on any single backoff sleep.
   *   A Retry-After longer than this throws RateLimitError instead of sleeping.
   */
  constructor({
    token,
    fileKey,
    fetch = globalThis.fetch,
    baseUrl = 'https://api.figma.com',
    maxRetryWaitMs = MAX_RETRY_WAIT_MS,
    lockoutFile = LOCKOUT_FILE,
    recoveryTimeoutMs = RECOVERY_TIMEOUT_MS,
    cooldownQuietMs = COOLDOWN_QUIET_MS,
    failFast = false,
    fileTimeoutMs = 90_000,
  }) {
    if (!token) throw new Error('FigmaRestSource: token is required');
    if (!fileKey) throw new Error('FigmaRestSource: fileKey is required');
    this.token = token;
    this.fileKey = fileKey;
    this.fetch = fetch;
    this.baseUrl = baseUrl;
    this.maxRetryWaitMs = maxRetryWaitMs;
    this.lockoutFile = lockoutFile; // null disables cross-run memory (tests)
    this.recoveryTimeoutMs = recoveryTimeoutMs;
    this.cooldownQuietMs = cooldownQuietMs;
    // failFast: never sleep through a cooldown — throw FigmaBlockedError so an
    // interactive caller (the MCP server) can answer from cache in seconds
    // instead of holding the agent for minutes.
    this.failFast = failFast;
    this.fileTimeoutMs = fileTimeoutMs;
    this._components = {}; // cached from the last getNode() call
    this._document = null; // whole-file tree, cached by the getNode() fallback
    this._fileComponents = {};
  }

  async _getJson(path, attempt = 0, timeoutMs = 0) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        headers: { 'X-Figma-Token': this.token },
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        const e = new Error(`Figma API ${path} → no complete answer within ${Math.round(timeoutMs / 1000)}s`);
        e.status = 0;
        e.timeout = true;
        throw e;
      }
      throw err;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 7) {
      const retryAfter = Number(res.headers?.get?.('retry-after'));

      // NEVER sleep for an unbounded retry-after. Figma's rate limiting is
      // cost-based, not a per-minute window: once a token exhausts its budget
      // it returns retry-after values in the TENS OF HOURS (142666s ≈ 40h has
      // been observed on this endpoint). Honoring that literally turns into a
      // 40-hour setTimeout — the process just hangs, silently, forever.
      // Anything past the cap is a wall, not a blip: fail loudly instead.
      if (retryAfter * 1000 > this.maxRetryWaitMs) {
        throw new RateLimitError(path, retryAfter);
      }

      const waitMs = retryAfter
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** attempt, this.maxRetryWaitMs);
      await new Promise((r) => setTimeout(r, waitMs));
      return this._getJson(path, attempt + 1, timeoutMs);
    }
    if (!res.ok) {
      const err = new Error(`Figma API ${path} → ${res.status} ${res.statusText || ''}`.trim());
      err.status = res.status;
      throw err;
    }
    try {
      return await res.json();
    } catch (err) {
      // A huge whole-file body can be cut off mid-download ("terminated").
      const e = new Error(`Figma API ${path} → the response was cut off before it finished (${err.message})`);
      e.status = 0;
      e.truncated = true;
      throw e;
    }
  }

  /**
   * Is the token itself valid? /v1/me is cheap and outside the file budgets, so
   * it tells a dead token apart from a file Figma will not serve right now.
   * @returns {Promise<{ok:boolean, status:number, handle?:string}>}
   */
  async checkToken() {
    try {
      const res = await this.fetch(`${this.baseUrl}/v1/me`, {
        headers: { 'X-Figma-Token': this.token },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) return { ok: false, status: res.status };
      const me = await res.json();
      return { ok: true, status: res.status, handle: me.handle || me.email };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  /**
   * Whole-file document, fetched once and cached for the process lifetime.
   *
   * /v1/files/:key and /v1/files/:key/nodes draw on SEPARATE cost budgets, so
   * this still answers when /nodes is locked out. It is a much bigger payload —
   * only reach for it via the getNode() fallback, never as the default.
   */
  async _getDocument() {
    if (!this._document) {
      const data = await this._getJson(
        `/v1/files/${this.fileKey}?geometry=paths`,
        0,
        this.failFast ? this.fileTimeoutMs : 0
      );
      this._document = data.document;
      // File-wide components dict — a superset of what /nodes returns per entry.
      this._fileComponents = data.components || {};
    }
    return this._document;
  }

  /**
   * Figma answers a spent cost budget with 429 — and, observed on /nodes, with a
   * bare 403 that is indistinguishable from a real auth failure. Treat both as
   * "this endpoint is blocked, try another way" rather than fatal.
   */
  static _isBlocked(err) {
    return err instanceof RateLimitError || err.status === 403 || err.status === 429;
  }

  /** Remembered lockout, or null. Unreadable/!corrupt file == no lockout. */
  _readLockout() {
    if (!this.lockoutFile) return null;
    try {
      const rec = JSON.parse(fs.readFileSync(this.lockoutFile, 'utf8'));
      return rec.resetAt > Date.now() ? rec : null;
    } catch {
      return null;
    }
  }

  _recordLockout(retryAfterSec) {
    if (!this.lockoutFile) return;
    const sec = retryAfterSec > 0 ? retryAfterSec : DEFAULT_LOCKOUT_SEC;
    const rec = { endpoint: 'nodes', resetAt: Date.now() + sec * 1000 };
    try {
      fs.writeFileSync(this.lockoutFile, JSON.stringify(rec, null, 2));
    } catch {
      // Best-effort memory; a read-only FS just costs us one wasted probe per run.
    }
  }

  /**
   * Whole-file document, tolerating the token cooldown a blocked /nodes leaves behind.
   *
   * Touching an exhausted endpoint doesn't just fail that request — it locks the
   * TOKEN out of the sibling file endpoints. Two things about that window, both
   * measured against the live API rather than assumed:
   *
   *   1. Probing it RESETS it. Retrying at 2/7/18/39/69s stayed 403 the whole way;
   *      60s of silence then a single request returned 200. Hence: sleep first,
   *      then probe once, then sleep again. Never tight-loop.
   *   2. /v1/me is a useless canary — it leaves the cooldown immediately while
   *      /v1/files is still refusing, so it reports "recovered" far too early.
   *
   * @param {boolean} afterBlock  True when a /nodes block just poisoned the token,
   *   meaning we must serve the quiet period before the first attempt.
   */
  async _getDocumentResilient(afterBlock) {
    if (this.failFast) {
      // One attempt, no cooldown sleeps. If /nodes just poisoned the token the
      // whole-file call would 403 too, so do not even try — report it.
      if (afterBlock) {
        throw new FigmaBlockedError(`/v1/files/${this.fileKey}`, this._readLockout()?.resetAt, {
          message: '/nodes was just rate-limited, which puts the token in a cooldown',
          status: 429,
        });
      }
      try {
        return await this._getDocument();
      } catch (err) {
        if (!FigmaRestSource._isBlocked(err)) throw err;
        throw new FigmaBlockedError(`/v1/files/${this.fileKey}`, this._readLockout()?.resetAt, err);
      }
    }
    const deadline = Date.now() + this.recoveryTimeoutMs;
    if (afterBlock) {
      console.warn(
        `[FigmaRestSource] waiting ${this.cooldownQuietMs / 1000}s for the token cooldown ` +
          `(probing early only restarts it)...`
      );
      await new Promise((r) => setTimeout(r, this.cooldownQuietMs));
    }
    for (;;) {
      try {
        return await this._getDocument();
      } catch (err) {
        if (!FigmaRestSource._isBlocked(err)) throw err;
        if (Date.now() + this.cooldownQuietMs > deadline) throw err;
        await new Promise((r) => setTimeout(r, this.cooldownQuietMs));
      }
    }
  }

  /**
   * The cheap, precise path: ask for exactly the node we want.
   *
   * `geometry=paths` is not about vector paths here — without it Figma omits
   * `size` and `relativeTransform` from every node, and those two are the only
   * record of a rotation or a mirror. What comes back instead is the
   * axis-aligned bounding box, which for a tilted node is both bigger than the
   * node and silent about the angle, so the conversion lands an oversized,
   * upright copy in roughly the right place. Cheap to ask for, and the whole
   * difference between a prop sitting where the designer put it and one
   * sprawling over the section below.
   */
  async _getNodeDirect(nodeId) {
    const data = await this._getJson(
      `/v1/files/${this.fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&geometry=paths`
    );
    const entry = data.nodes?.[nodeId];
    if (!entry?.document) {
      throw new Error(`Figma node "${nodeId}" not found in file ${this.fileKey}`);
    }
    this._components = entry.components || {};
    return entry.document;
  }

  /**
   * Raw node tree for a node id. Also caches its `components` dict.
   *
   * Tries /nodes first — it's a fraction of the payload. Falls back to the
   * whole-file endpoint, which draws on a SEPARATE cost budget, when /nodes is
   * locked out. The lockout is remembered across runs: re-probing an exhausted
   * /nodes costs nothing but another token-wide 403 cooldown.
   */
  async getNode(nodeId) {
    const lockout = this._readLockout();
    let poisoned = false;

    if (!lockout) {
      try {
        return await this._getNodeDirect(nodeId);
      } catch (err) {
        if (!FigmaRestSource._isBlocked(err)) throw err;
        this._recordLockout(err.retryAfterSec);
        poisoned = true; // That attempt just started a token-wide cooldown.
        console.warn(
          `[FigmaRestSource] /nodes blocked (${err.message}); ` +
            `using the whole-file endpoint, which has its own budget.`
        );
      }
    } else {
      // Skipping /nodes is the whole point of remembering the lockout: the token
      // is never poisoned, so the whole-file call goes through immediately.
      console.warn(
        `[FigmaRestSource] /nodes still rate-limited until ${new Date(lockout.resetAt).toISOString()}; ` +
          `going straight to the whole-file endpoint.`
      );
    }

    const doc = await this._getDocumentResilient(poisoned);
    const found = findNodeById(doc, nodeId);
    if (!found) {
      throw new Error(
        `Figma node "${nodeId}" not found in file ${this.fileKey} (via whole-file fallback)`
      );
    }
    this._components = this._fileComponents;
    return found;
  }

  /** id → token name. Variables API is Enterprise-only; degrade gracefully. */
  async getVariableMap() {
    try {
      const data = await this._getJson(`/v1/files/${this.fileKey}/variables/local`);
      return buildVariableMap(data.meta);
    } catch (err) {
      console.warn(`[FigmaRestSource] variables unavailable (${err.message}); continuing without tokens.`);
      return {};
    }
  }

  /** id → { name, props }. Uses the components dict cached by getNode(). */
  async getComponentMap(nodeId) {
    if (nodeId && Object.keys(this._components).length === 0) await this.getNode(nodeId);
    return buildComponentMap(this._components);
  }

  /** Rendered PNG for a node (the verify loop's reference screenshot). */
  async getScreenshotPng(nodeId, scale = 2) {
    const data = await this._getJson(
      `/v1/images/${this.fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`
    );
    const url = data.images?.[nodeId];
    if (!url) throw new Error(`Figma render URL missing for node "${nodeId}"`);
    const res = await this.fetch(url);
    if (!res.ok) throw new Error(`Figma image download → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * imageRef → download URL for every image FILL in the file.
   *
   * This is /v1/files/:key/images, NOT /v1/images/:key — different endpoint,
   * different cost budget. It hands back the original uploaded bitmap instead of
   * re-rendering the node, so it is both cheaper and unaffected when node
   * rendering is locked out. Prefer it for photos; /v1/images is only needed
   * when a node must be rasterised (vectors, effects, whole-frame references).
   */
  async getImageFillUrls() {
    const data = await this._getJson(`/v1/files/${this.fileKey}/images`);
    return data.meta?.images || {};
  }

  /**
   * Export image FILLS as embeddable data URIs, keyed by node id.
   * @param {Array<{id:string, ref:string}>} entries  node id → its fill's imageRef
   * @returns {Promise<Object<string,string|null>>}
   */
  async exportImageFills(entries) {
    if (!entries.length) return {};
    const urls = await this.getImageFillUrls();
    const byRef = new Map(); // one download per distinct bitmap, not per node
    const out = {};
    for (const { id, ref } of entries) {
      const url = urls[ref];
      if (!url) {
        out[id] = null;
        continue;
      }
      if (!byRef.has(ref)) {
        const res = await this.fetch(url);
        if (!res.ok) {
          byRef.set(ref, null);
        } else {
          const buf = Buffer.from(await res.arrayBuffer());
          const mime = res.headers?.get?.('content-type') || 'image/png';
          byRef.set(ref, `data:${mime};base64,${buf.toString('base64')}`);
        }
      }
      out[id] = byRef.get(ref);
    }
    return out;
  }

  /** Export nodes as SVG strings (for vector clusters → asset files). */
  async exportSvgs(nodeIds, scale = 1) {
    if (!nodeIds.length) return {};
    const ids = nodeIds.map(encodeURIComponent).join(',');
    const data = await this._getJson(
      `/v1/images/${this.fileKey}?ids=${ids}&format=svg&scale=${scale}`
    );
    const out = {};
    for (const [id, url] of Object.entries(data.images || {})) {
      if (!url) continue;
      const res = await this.fetch(url);
      out[id] = await res.text();
    }
    return out;
  }

  /**
   * Export nodes as embeddable data URIs (self-contained — no external files).
   * @param {string[]} nodeIds
   * @param {'png'|'svg'} [format='png']
   * @param {number} [scale=2]
   * @param {number} [batch=40]   Figma caps ids per request; batch to be safe.
   * @returns {Promise<Object<string,string|null>>}  id → "data:...;base64,..." (or null)
   */
  async exportNodes(nodeIds, format = 'png', scale = 2, batch = 40) {
    const out = {};
    for (let i = 0; i < nodeIds.length; i += batch) {
      const chunk = nodeIds.slice(i, i + batch);
      const ids = chunk.map(encodeURIComponent).join(',');
      const data = await this._getJson(
        `/v1/images/${this.fileKey}?ids=${ids}&format=${format}&scale=${scale}`
      );
      const mime = format === 'svg' ? 'image/svg+xml' : 'image/png';
      for (const [id, url] of Object.entries(data.images || {})) {
        if (!url) {
          out[id] = null;
          continue;
        }
        const res = await this.fetch(url);
        const buf = Buffer.from(await res.arrayBuffer());
        out[id] = `data:${mime};base64,${buf.toString('base64')}`;
      }
    }
    return out;
  }
}
