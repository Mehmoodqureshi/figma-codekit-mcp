#!/usr/bin/env node
// site/server.js — the local web front end for figma-codekit-mcp.
//
//   npm run site        then open http://localhost:5173
//
// It is the same pipeline the MCP server exposes to an agent, driven by a text
// box instead. Nothing here talks to Figma or Chromium directly; site/pipeline.js
// does that by calling src/.
//
// Two rules shape the routing:
//
//  • Generated artifacts never travel through the JSON API. A converted frame is
//    routinely 20+ MB of inlined data URIs and a reference render can be 30 MB;
//    both are streamed from disk by URL so the browser can cache them and the
//    progress stream stays small.
//  • Frame ids are directory names under .figma-cache, so every one that arrives
//    from the client is pattern-checked and re-resolved against the cache root
//    before it reaches the filesystem.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { loadCredentials } from '../src/config/credentials.js';
import { closeBrowser } from '../src/render.js';
import { run, listCachedFrames, Cancelled, CACHE_ROOT, ROOT } from './pipeline.js';
import { scaledPng, pngSize } from './images.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const PORT = Number(process.env.PORT) || 5173;

// .figma-token at the repo root -> FIGMA_TOKEN, unless the environment set it.
loadCredentials(ROOT);
loadCredentials(process.cwd());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jsx': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};

const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': MIME['.json'], 'content-length': buf.length });
  res.end(buf);
};

const notFound = (res, msg = 'Not found') => json(res, 404, { error: msg });

/** Stream a file, with the length up front so the browser can show progress. */
function sendFile(res, filePath, { download = null, mime = null, head = false } = {}) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return notFound(res, `Missing file: ${path.basename(filePath)}`);
  }
  const headers = {
    'content-type': mime || MIME[path.extname(filePath)] || 'application/octet-stream',
    'content-length': stat.size,
    // Artifacts are rewritten in place on every run, so they must be revalidated.
    'cache-control': 'no-cache',
  };
  if (download) headers['content-disposition'] = `attachment; filename="${download}"`;
  res.writeHead(200, headers);
  if (head) return res.end();
  fs.createReadStream(filePath).pipe(res);
}

/**
 * Resolve a client-supplied frame id to a directory inside the cache root.
 * Returns null for anything that escapes it — id goes straight into a path.
 */
/**
 * Relative paths the pipeline actually writes. Anything the client asks to read
 * has to match this before it is resolved against the frame directory.
 */
const ARTIFACT_PATH =
  /^(generated\.html|responsive\.html|generated\.jsx|ir\.json|next\/(app\/)?[A-Za-z0-9_.-]+)$/;

function frameDir(id) {
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || id === '.' || id === '..') return null;
  const dir = path.resolve(CACHE_ROOT, id);
  const root = path.resolve(CACHE_ROOT);
  if (dir !== root && !dir.startsWith(root + path.sep)) return null;
  return fs.existsSync(dir) ? dir : null;
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${e.message}`));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// POST /api/run — the pipeline, streamed as server-sent events.
// ---------------------------------------------------------------------------
async function handleRun(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, 400, { error: err.message });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Nothing here is proxied by default, but this is the header that stops a
    // proxy that IS in the way from buffering the whole stream to the end.
    'x-accel-buffering': 'no',
  });

  const send = (event) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // The client aborts its fetch when you press stop; the pipeline notices at the
  // next step boundary. Chromium and the Figma fetch cannot be torn out mid-call.
  let cancelled = false;
  req.on('close', () => {
    cancelled = true;
  });

  send({ type: 'start' });

  try {
    const result = await run({
      url: String(body.url || '').trim(),
      responsive: !!body.responsive,
      framework: ['html', 'react', 'next'].includes(body.framework) ? body.framework : 'html',
      refresh: !!body.refresh,
      verify: body.verify !== false,
      threshold: typeof body.threshold === 'number' ? body.threshold : 0.02,
      onStep: (e) => send({ type: 'step', ...e }),
      isCancelled: () => cancelled,
    });
    send({ type: 'done', result });
  } catch (err) {
    if (err instanceof Cancelled) {
      send({ type: 'cancelled' });
    } else {
      send({ type: 'error', message: err.message, name: err.name, hint: hintFor(err) });
    }
  }
  if (!res.writableEnded) res.end();
}

/** Turn the failures people actually hit into the next thing to try. */
function hintFor(err) {
  const m = String(err.message || '');
  if (err.name === 'RateLimitError') {
    const at = err.resetAt ? ` It resets around ${err.resetAt.toLocaleString()}.` : '';
    return (
      `Figma is rate-limiting this token.${at} Frames already in .figma-cache still work — ` +
      `re-run them with refresh off and the whole loop stays offline.`
    );
  }
  if (m.includes('403')) return 'The token cannot see this file. Check it is shared with that Figma account.';
  if (m.includes('404')) return 'No such file key or node id. Check the link still points at a frame that exists.';
  if (m.includes('browserType.launch') || m.includes('Executable doesn')) {
    return 'Chromium is missing. Run: npx playwright install chromium';
  }
  return '';
}

// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  // HEAD is GET without the body — curl -I and download managers ask for it
  // before committing to a 20 MB artifact.
  const head = req.method === 'HEAD';
  const isRead = req.method === 'GET' || head;

  try {
    if (req.method === 'POST' && pathname === '/api/run') return await handleRun(req, res);

    if (isRead && pathname === '/api/config') {
      return json(res, 200, {
        hasToken: !!process.env.FIGMA_TOKEN,
        cacheRoot: CACHE_ROOT,
        frames: listCachedFrames().slice(0, 12),
      });
    }

    // /f/<id>/<what>  — generated artifacts, streamed from the cache dir.
    const frameMatch = pathname.match(/^\/f\/([^/]+)\/(.+)$/);
    if (isRead && frameMatch) {
      const dir = frameDir(decodeURIComponent(frameMatch[1]));
      if (!dir) return notFound(res, 'Unknown frame id');
      const what = frameMatch[2];

      if (what === 'preview') {
        const file = url.searchParams.get('variant') === 'responsive' ? 'responsive.html' : 'generated.html';
        return sendFile(res, path.join(dir, file), { head });
      }

      const imageMatch = what.match(/^img\/(reference|render|diff)$/);
      if (imageMatch) {
        const src = path.join(dir, `${imageMatch[1]}.png`);
        if (!fs.existsSync(src)) return notFound(res, `No ${imageMatch[1]}.png for this frame yet`);
        if (url.searchParams.get('full') === '1') return sendFile(res, src, { head });
        const maxWidth = Math.min(2400, Math.max(200, Number(url.searchParams.get('w')) || 900));
        return sendFile(res, scaledPng(src, maxWidth), { mime: MIME['.png'], head });
      }

      const sizeMatch = what.match(/^size\/(reference|render|diff)$/);
      if (sizeMatch) {
        const size = pngSize(path.join(dir, `${sizeMatch[1]}.png`));
        return size ? json(res, 200, size) : notFound(res, 'No such image');
      }

      // Source text for the Code tab. Only files the pipeline itself writes are
      // reachable, matched by shape and then re-resolved under the frame dir —
      // `path` arrives from the client.
      if (what === 'code') {
        const rel = url.searchParams.get('path') || '';
        if (!ARTIFACT_PATH.test(rel) || rel.includes('..')) {
          return notFound(res, `Not a generated file: ${rel}`);
        }
        const file = path.resolve(dir, rel);
        if (file !== dir && !file.startsWith(dir + path.sep)) return notFound(res, 'Bad path');
        if (!fs.existsSync(file)) return notFound(res, `No ${rel} for this frame`);

        // A component with inlined assets is routinely 20 MB. Reading that into a
        // <pre> locks the tab up for no benefit, so send a head slice and say so.
        const size = fs.statSync(file).size;
        const max = Math.min(1 << 20, Math.max(4096, Number(url.searchParams.get('max')) || 262144));
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(Math.min(size, max));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        return json(res, 200, {
          path: rel,
          size,
          truncated: size > buf.length,
          text: buf.toString('utf8'),
        });
      }

      // Downloads are limited to the artifacts the pipeline writes, by name.
      const DOWNLOADS = {
        html: 'generated.html',
        responsive: 'responsive.html',
        jsx: 'generated.jsx',
        ir: 'ir.json',
      };
      const dlMatch = what.match(/^download\/(html|responsive|jsx|ir)$/);
      if (dlMatch) {
        const file = DOWNLOADS[dlMatch[1]];
        return sendFile(res, path.join(dir, file), { download: file, head });
      }

      if (what === 'download') {
        const rel = url.searchParams.get('path') || '';
        if (!ARTIFACT_PATH.test(rel) || rel.includes('..')) return notFound(res, 'Bad path');
        const file = path.resolve(dir, rel);
        if (file !== dir && !file.startsWith(dir + path.sep)) return notFound(res, 'Bad path');
        return sendFile(res, file, { download: path.basename(rel), head });
      }

      return notFound(res);
    }

    // Static assets. Only the three files in public/, resolved by extension.
    if (isRead) {
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const file = path.resolve(PUBLIC, rel);
      if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return sendFile(res, file, { head });
      }
      return notFound(res);
    }

    return json(res, 405, { error: `${req.method} not allowed` });
  } catch (err) {
    if (!res.headersSent) return json(res, 500, { error: err.message });
    if (!res.writableEnded) res.end();
  }
});

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

server.listen(PORT, () => {
  const at = `http://localhost:${PORT}`;
  console.log(`figma-codekit-mcp site  ${at}`);
  console.log(`  cache   ${CACHE_ROOT}`);
  console.log(`  token   ${process.env.FIGMA_TOKEN ? 'loaded' : 'MISSING - put one in .figma-token'}`);
  if (process.argv.includes('--open') && process.platform === 'darwin') spawn('open', [at]);
});
