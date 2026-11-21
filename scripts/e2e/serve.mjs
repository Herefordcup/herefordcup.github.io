import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDisposableSupabaseUrl, runtimeConfigSource } from './safety.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const supabaseUrl = assertDisposableSupabaseUrl(process.env.E2E_SUPABASE_URL);
const publishableKey = process.env.E2E_SUPABASE_PUBLISHABLE_KEY;
const configSource = runtimeConfigSource(supabaseUrl, publishableKey);
const port = Number(process.env.E2E_WEB_PORT || 4173);

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://127.0.0.1:${port}`);
    const pathname = decodeURIComponent(requestUrl.pathname === '/' ? '/index.html' : requestUrl.pathname);
    if (pathname === '/src/config.js') {
      response.writeHead(200, { 'Content-Type': contentTypes['.js'], 'Cache-Control': 'no-store' });
      response.end(configSource);
      return;
    }

    const filePath = resolve(root, `.${pathname}`);
    const relativePath = relative(root, filePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath) || relativePath.startsWith('.git')) {
      throw new Error('Invalid E2E asset path.');
    }
    if (!(await stat(filePath)).isFile()) throw new Error('E2E asset is not a file.');
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    response.end(content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Disposable E2E web server listening on http://127.0.0.1:${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
