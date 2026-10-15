// Setup checks — what `npx -y mcp-figma-to-code@latest --check` runs.
//
// The MCP server has nothing to say until a host connects to it, so a fresh
// install gives an agent (or a person) no way to tell whether it will work.
// `--check` answers that in one command, on the same code path the server uses:
// Node version, whether a token was found (and where — never its value),
// whether Figma accepts that token, and whether the Chromium that figma_verify
// renders in is actually on disk. Exit 0 means every tool will work; exit 1
// names what is missing and how to fix it.
//
// This writes to stdout on purpose: it never runs alongside the stdio
// transport, so stdout is free here.

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const MIN_NODE_MAJOR = 20;

export function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

/** Absolute path Playwright expects Chromium at, and whether it is there. */
export function chromiumStatus() {
  let executable = null;
  try {
    executable = chromium.executablePath();
  } catch {
    /* no registry entry at all */
  }
  return { executable, installed: Boolean(executable && fs.existsSync(executable)) };
}

/**
 * Install the Chromium build this package's Playwright wants — the same call
 * postinstall makes, exposed so a skipped or failed download can be redone
 * without guessing at a matching `npx playwright` version.
 */
export function installBrowser() {
  const { execFileSync } = require('node:child_process');
  const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
  execFileSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
}

/**
 * Ask Figma whether the token in the environment is accepted. Returns a short
 * status word; never returns or logs the token, and reads nothing from the
 * account beyond whether the request was authorised.
 */
export async function probeToken(token, { fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  if (!token) return { ok: false, status: 'missing' };
  if (typeof fetchImpl !== 'function') return { ok: false, status: 'unchecked (no fetch)' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://api.figma.com/v1/me', {
      headers: { 'X-Figma-Token': token },
      signal: ctrl.signal,
    });
    if (res.status === 200) return { ok: true, status: 'accepted by Figma' };
    if (res.status === 403 || res.status === 401) return { ok: false, status: `rejected by Figma (HTTP ${res.status})` };
    if (res.status === 429) return { ok: true, status: 'rate-limited (HTTP 429) — token reached Figma, retry later' };
    return { ok: false, status: `unexpected HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: `unchecked — could not reach api.figma.com (${err?.name === 'AbortError' ? 'timeout' : err?.message || err})` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every check and print a report. `tokenSource` is where the token was
 * loaded from ("environment", a file path, or null); the value itself is read
 * from process.env and never printed.
 *
 * @returns {Promise<boolean>} true when everything a tool needs is in place.
 */
export async function runCheck({ tokenSource, cacheRoot, out = process.stdout } = {}) {
  const lines = [];
  const problems = [];

  lines.push(`mcp-figma-to-code ${packageVersion()}`);

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const nodeOk = nodeMajor >= MIN_NODE_MAJOR;
  lines.push(`node      ${process.version}${nodeOk ? '' : `  (needs ${MIN_NODE_MAJOR} or newer)`}`);
  if (!nodeOk) problems.push(`Upgrade Node to ${MIN_NODE_MAJOR} or newer.`);

  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    lines.push('token     missing');
    problems.push(
      'No Figma token. Set FIGMA_TOKEN in the MCP server config, or put the token in ' +
        '.figma-token in the project directory. Figma → Settings → Security → Personal access ' +
        'tokens, scope "File content: read".'
    );
  } else {
    const probe = await probeToken(token);
    lines.push(`token     found (${tokenSource || 'environment'}) — ${probe.status}`);
    if (!probe.ok && probe.status.startsWith('rejected')) {
      problems.push('Figma rejected the token. Generate a new one and replace it where it is stored.');
    }
  }

  const chrome = chromiumStatus();
  if (chrome.installed) {
    lines.push(`chromium  installed (${chrome.executable})`);
  } else {
    lines.push('chromium  missing — figma_convert and figma_inspect work, figma_verify will not');
    problems.push('Run: npx -y mcp-figma-to-code@latest --install-browser');
  }

  if (cacheRoot) lines.push(`cache     ${cacheRoot}`);

  const ready = problems.length === 0;
  lines.push('');
  lines.push(ready ? 'READY — all three tools will work.' : 'NOT READY');
  for (const p of problems) lines.push(`  - ${p}`);
  out.write(lines.join('\n') + '\n');
  return ready;
}
