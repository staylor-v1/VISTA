const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { after, before, test } = require('node:test');

const {
  createRequestHandler,
  decodedPathname,
  serverAddress,
} = require('./serve-build.cjs');

let buildDirectory;
let handler;
let outsideFile;

function request(pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const headers = {};
    const response = new PassThrough();
    response.headersSent = false;
    response.setHeader = (name, value) => {
      headers[name.toLowerCase()] = value;
    };
    response.writeHead = (statusCode, responseHeaders = {}) => {
      response.statusCode = statusCode;
      response.headersSent = true;
      for (const [name, value] of Object.entries(responseHeaders)) {
        headers[name.toLowerCase()] = value;
      }
      return response;
    };
    response.on('data', (chunk) => chunks.push(chunk));
    response.once('error', reject);
    response.once('finish', () => {
      resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        headers,
        statusCode: response.statusCode,
      });
    });

    handler({
      headers: Object.fromEntries(
        Object.entries(options.headers || {}).map(([name, value]) => [name.toLowerCase(), value]),
      ),
      method: options.method || 'GET',
      url: pathname,
    }, response).catch(reject);
  });
}

before(async () => {
  buildDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'vista-serve-build-'));
  outsideFile = `${buildDirectory}-outside.txt`;
  await fs.promises.mkdir(path.join(buildDirectory, 'static', 'js'), { recursive: true });
  await Promise.all([
    fs.promises.writeFile(path.join(buildDirectory, 'index.html'), '<main>VISTA build</main>'),
    fs.promises.writeFile(path.join(buildDirectory, 'static', 'js', 'main.js'), 'globalThis.vista = true;'),
    fs.promises.writeFile(outsideFile, 'outside'),
  ]);
  await fs.promises.symlink(outsideFile, path.join(buildDirectory, 'outside-link.txt'));
  handler = createRequestHandler(buildDirectory);
});

after(async () => {
  await fs.promises.rm(buildDirectory, { recursive: true, force: true });
  await fs.promises.rm(outsideFile, { force: true });
});

test('serves build assets with immutable caching and supports HEAD', async () => {
  const asset = await request('/static/js/main.js');
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.body, 'globalThis.vista = true;');
  assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');

  const head = await request('/static/js/main.js', { method: 'HEAD' });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], Buffer.byteLength(asset.body));
});

test('uses index.html for extensionless SPA routes but not missing assets', async () => {
  const route = await request('/projects/project-1/images/image-2', {
    headers: { Accept: 'text/html' },
  });
  assert.equal(route.statusCode, 200);
  assert.equal(route.body, '<main>VISTA build</main>');
  assert.equal(route.headers['cache-control'], 'no-cache');

  const asset = await request('/static/js/missing.js', {
    headers: { Accept: 'text/html' },
  });
  assert.equal(asset.statusCode, 404);
});

test('rejects path traversal, malformed encoding, and symlinks outside the build', async () => {
  assert.throws(
    () => decodedPathname('/%2e%2e/secret.txt'),
    (error) => error.statusCode === 403,
  );
  assert.throws(
    () => decodedPathname('/bad%E0%A4%A'),
    (error) => error.statusCode === 400,
  );

  const encodedBackslashTraversal = await request('/%2e%2e%5coutside.txt');
  assert.equal(encodedBackslashTraversal.statusCode, 403);

  const symlinkEscape = await request('/outside-link.txt');
  assert.equal(symlinkEscape.statusCode, 403);
  assert.doesNotMatch(symlinkEscape.body, /outside/);
});

test('rejects mutation methods', async () => {
  const response = await request('/', { method: 'POST' });
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.allow, 'GET, HEAD');
});

test('derives its listen address from explicit Playwright settings', () => {
  assert.deepEqual(serverAddress({
    PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:4312/projects',
  }), {
    host: '127.0.0.1',
    port: 4312,
  });
  assert.deepEqual(serverAddress({
    HOST: '0.0.0.0',
    PLAYWRIGHT_PORT: '4313',
  }), {
    host: '0.0.0.0',
    port: 4313,
  });
  assert.deepEqual(serverAddress({
    PLAYWRIGHT_BASE_URL: 'http://127.0.0.1',
  }), {
    host: '127.0.0.1',
    port: 80,
  });
  assert.throws(
    () => serverAddress({ PLAYWRIGHT_PORT: '0' }),
    /integer from 1 to 65535/,
  );
});
