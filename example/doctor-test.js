// Tests for the setup check (`mcp-figma-to-code --check`, src/mcp/doctor.js).
//
// probeToken and runCheck run with a stubbed fetch, so no request reaches Figma
// and no real token is needed. The last block spawns the real server binary with
// `--check`, the way a user runs it, in a scratch directory: it must print the
// report on stdout, exit instead of waiting for an MCP host, report WHERE the
// token came from, and never print the token itself.
//
// Run: node example/doctor-test.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { probeToken, runCheck } from '../src/mcp/doctor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'mcp', 'server.js');

let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${msg}`);
  if (!cond) failures++;
};

const answer = (status) => async () => ({ status });

console.log('probeToken');
{
  assert((await probeToken('')).status === 'missing', 'no token -> missing, no request made');
  const ok = await probeToken('t', { fetchImpl: answer(200) });
  assert(ok.ok && ok.status === 'accepted by Figma', '200 -> accepted');
  const bad = await probeToken('t', { fetchImpl: answer(403) });
  assert(!bad.ok && bad.status.startsWith('rejected'), '403 -> rejected');
  const limited = await probeToken('t', { fetchImpl: answer(429) });
  assert(limited.ok && limited.status.includes('429'), '429 -> token reached Figma, counts as ok');
  const odd = await probeToken('t', { fetchImpl: answer(500) });
  assert(!odd.ok && odd.status === 'unexpected HTTP 500', '500 -> unexpected, not ok');
  const offline = await probeToken('t', {
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    },
  });
  assert(!offline.ok && offline.status.startsWith('unchecked') && offline.status.includes('ENOTFOUND'), 'network error -> unchecked, says why');
  const hung = await probeToken('t', {
    timeoutMs: 50,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))),
  });
  assert(!hung.ok && hung.status.includes('timeout'), 'no answer -> times out as unchecked');
  let sentHeader = null;
  await probeToken('secret-value', {
    fetchImpl: async (_url, opts) => {
      sentHeader = opts.headers['X-Figma-Token'];
      return { status: 200 };
    },
  });
  assert(sentHeader === 'secret-value', 'the token goes in the X-Figma-Token header');
}

/** Collect what runCheck writes. */
const sink = () => {
  let out = '';
  return { write: (s) => (out += s), text: () => out };
};

console.log('runCheck');
{
  const saved = { token: process.env.FIGMA_TOKEN, fetch: globalThis.fetch };

  delete process.env.FIGMA_TOKEN;
  let out = sink();
  const ready = await runCheck({ tokenSource: null, cacheRoot: '/tmp/cache', out });
  assert(ready === false, 'no token -> not ready');
  assert(/token\s+missing/.test(out.text()), 'report says the token is missing');
  assert(out.text().includes('NOT READY'), 'report ends NOT READY');
  assert(out.text().includes('.figma-token'), 'fix names a location the loader actually reads');
  assert(!out.text().includes('~/.figma-mcp/token'), 'fix does not point at a file nothing reads');
  assert(out.text().includes('cache     /tmp/cache'), 'report shows the cache dir');

  process.env.FIGMA_TOKEN = 'figd_do-not-print-me';
  globalThis.fetch = answer(403);
  out = sink();
  await runCheck({ tokenSource: '/work/.figma-token', out });
  assert(out.text().includes('found (/work/.figma-token)'), 'report says where the token came from');
  assert(out.text().includes('rejected by Figma'), 'a rejected token is reported');
  assert(out.text().includes('Generate a new one'), 'and the fix says to replace it');
  assert(!out.text().includes('figd_do-not-print-me'), 'the token value is never printed');

  globalThis.fetch = answer(200);
  out = sink();
  await runCheck({ tokenSource: 'environment', out });
  assert(out.text().includes('found (environment) — accepted by Figma'), 'an env token that Figma accepts');
  assert(!out.text().includes('figd_do-not-print-me'), 'still never printed');

  if (saved.token === undefined) delete process.env.FIGMA_TOKEN;
  else process.env.FIGMA_TOKEN = saved.token;
  globalThis.fetch = saved.fetch;
}

console.log('mcp-figma-to-code --check (real binary)');
{
  // realpath: macOS tmp is a symlink (/var -> /private/var) and the child reports its real cwd.
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'figma-mcp-check-')));
  // Only PATH/HOME carry over, so no token leaks in from the caller's
  // environment, and the scratch cwd starts with no .figma-token. The package
  // root may hold a developer's own .figma-token (a checkout run in place), so
  // the first run accepts either "missing" or that file being reported.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, FIGMA_MCP_CACHE_DIR: path.join(scratch, 'cache') };
  const hasRootToken = fs.existsSync(path.join(ROOT, '.figma-token'));

  const run = (extraEnv = {}) =>
    spawnSync(process.execPath, [SERVER, '--check'], { cwd: scratch, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30_000 });

  const r = run();
  assert(r.error === undefined && r.signal === null, '--check exits on its own (does not wait for an MCP host)');
  assert(r.stdout.startsWith('mcp-figma-to-code '), 'report goes to stdout, starting with the version');
  assert(r.stdout.includes(`cache     ${path.join(scratch, 'cache')}`), 'honours FIGMA_MCP_CACHE_DIR');
  if (!hasRootToken) {
    assert(r.status === 1, 'no token anywhere -> exit 1');
    assert(/token\s+missing/.test(r.stdout), 'and says the token is missing');
  } else {
    assert(r.stdout.includes(`found (${path.join(ROOT, '.figma-token')})`), 'package-root token is reported with its path');
  }

  fs.writeFileSync(path.join(scratch, '.figma-token'), 'figd_scratch-token-value\n');
  const withFile = run();
  assert(withFile.stdout.includes(`found (${path.join(scratch, '.figma-token')})`), 'project .figma-token is found and its path reported');
  assert(!withFile.stdout.includes('figd_scratch-token-value') && !withFile.stderr.includes('figd_scratch-token-value'), 'the token value never appears in the output');

  const fromEnv = run({ FIGMA_API_KEY: 'figd_alias-token-value' });
  assert(fromEnv.stdout.includes('found (environment)'), 'an env var beats the file, and the alias counts');
  assert(!fromEnv.stdout.includes('figd_alias-token-value'), 'env token value never printed either');

  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
