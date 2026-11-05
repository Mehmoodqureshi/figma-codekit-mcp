// Stage 6 helper — write exported assets to real files instead of data URIs.
//
// Inlining every bitmap as base64 keeps the output self-contained, but a
// photo-heavy frame then produces a 20 MB HTML file that editors choke on, that
// diffs badly in git and that no one would ship. Writing each distinct asset
// once to assets/<hash>.<ext> and pointing the code at it keeps generated.html
// small and the images reusable.
//
// The asset map the emitters consume stays `node id → URL`; only the URL
// changes (data: URI → "assets/ab12cd34ef56.png"), so html.js / react.js /
// next.js need no special casing.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

/** "data:image/png;base64,AAAA" → { mime, buf } (or null if not a data URI). */
export function decodeDataUri(uri) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(String(uri || ''));
  if (!m) return null;
  const [, mime, b64, body] = m;
  const buf = b64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8');
  return { mime: mime.toLowerCase(), buf };
}

/**
 * Write every data-URI asset to `<dir>/<subdir>/<sha1-12>.<ext>` (deduplicated by
 * content) and return a new map whose values are `<urlPrefix><file>`.
 *
 * Values that are not data URIs (already a URL, or null) pass through as-is.
 *
 * @param {Object<string,string|null>} assets   node id → data URI
 * @param {string} dir                           Output root.
 * @param {Object} [opts]
 * @param {string} [opts.subdir='assets']
 * @param {string} [opts.urlPrefix='assets/']    What the code should reference.
 * @returns {{ map: Object<string,string|null>, files: string[], bytes: number }}
 */
export function externalizeAssets(assets, dir, opts = {}) {
  const { subdir = 'assets', urlPrefix = 'assets/' } = opts;
  const outDir = path.join(dir, subdir);
  const map = {};
  const written = new Map(); // hash.ext → true
  let bytes = 0;
  for (const [id, value] of Object.entries(assets || {})) {
    const decoded = decodeDataUri(value);
    if (!decoded) {
      map[id] = value;
      continue;
    }
    const ext = EXT[decoded.mime] || 'bin';
    const name = `${crypto.createHash('sha1').update(decoded.buf).digest('hex').slice(0, 12)}.${ext}`;
    if (!written.has(name)) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, name), decoded.buf);
      written.set(name, true);
      bytes += decoded.buf.length;
    }
    map[id] = `${urlPrefix}${name}`;
  }
  return { map, files: [...written.keys()], bytes };
}

/** Copy previously written asset files into another directory (e.g. next/public/assets). */
export function copyAssetFiles(files, fromDir, toDir) {
  if (!files.length) return;
  fs.mkdirSync(toDir, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f));
}
