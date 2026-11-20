import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const filePath = resolve(root, `.${pathname}`);
      const relativePath = relative(root, filePath);
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) throw new Error('Invalid fixture path.');
      const contentTypes = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript' };
      const content = await readFile(filePath);
      response.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream' });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
  await new Promise(resolveListening => server.listen(0, '127.0.0.1', resolveListening));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function chromeExecutable() {
  const candidates = process.platform === 'win32'
    ? [
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue through the reviewed platform-specific candidates.
    }
  }
  throw new Error('Google Chrome or Chromium is required for responsive roster QA.');
}

async function rosterLayout(baseUrl, width, height) {
  const chrome = await chromeExecutable();
  const { stdout } = await execFileAsync(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--window-size=${width},${height}`,
    '--dump-dom',
    `${baseUrl}/test/fixtures/active-member-roster.html`,
  ], { maxBuffer: 2_000_000 });
  const serialized = /<pre id="qa-result">([^<]+)<\/pre>/.exec(stdout)?.[1];
  assert.ok(serialized, 'fixture must publish computed roster layout results');
  return JSON.parse(serialized.replaceAll('&amp;', '&'));
}

test('Active Members roster keeps responsive layout and restores filtered-card focus after inert releases', async () => {
  const { server, baseUrl } = await startFixtureServer();
  try {
    const desktop = await rosterLayout(baseUrl, 1264, 900);
    assert.ok(desktop.viewportWidth >= 1200, `desktop viewport was ${desktop.viewportWidth}px`);
    assert.equal(desktop.rosterColumns, 3);
    assert.equal(desktop.filterColumns, 3);
    assert.equal(desktop.maxHeight, '600px');
    assert.equal(desktop.overflowY, 'auto');
    assert.equal(desktop.horizontalOverflow, false);
    assert.equal(desktop.cardCount, 18);
    assert.equal(desktop.focusMovedBeforeFinalRelease, false);
    assert.equal(desktop.focusMovedAfterFinalRelease, true);

    const phone = await rosterLayout(baseUrl, 500, 844);
    assert.ok(phone.viewportWidth <= 500 && phone.viewportWidth >= 480, `phone-breakpoint viewport was ${phone.viewportWidth}px`);
    assert.equal(phone.rosterColumns, 1);
    assert.equal(phone.filterColumns, 1);
    assert.equal(phone.toolbarDirection, 'column');
    assert.equal(phone.maxHeight, '600px');
    assert.equal(phone.overflowY, 'auto');
    assert.equal(phone.horizontalOverflow, false);
    assert.equal(phone.cardCount, 18);
    assert.equal(phone.focusMovedBeforeFinalRelease, false);
    assert.equal(phone.focusMovedAfterFinalRelease, true);
  } finally {
    await new Promise(resolveClosed => server.close(resolveClosed));
  }
});
