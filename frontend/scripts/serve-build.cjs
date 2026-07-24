#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const path = require('path');

const DEFAULT_BUILD_DIR = path.resolve(__dirname, '..', 'build');
const CONTENT_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

class RequestError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function isInsideRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function decodedPathname(requestTarget) {
  const rawPathname = requestTarget.split(/[?#]/, 1)[0] || '/';
  let decoded;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    throw new RequestError(400, 'Malformed URL encoding');
  }

  if (decoded.includes('\0')) {
    throw new RequestError(400, 'NUL bytes are not allowed');
  }

  const slashPath = decoded.replace(/\\/g, '/');
  if (slashPath.split('/').includes('..')) {
    throw new RequestError(403, 'Path traversal is not allowed');
  }
  return slashPath;
}

async function regularFileWithinRoot(root, candidate) {
  let realCandidate;
  try {
    realCandidate = await fs.promises.realpath(candidate);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }

  if (!isInsideRoot(root, realCandidate)) {
    throw new RequestError(403, 'Path traversal is not allowed');
  }

  const stats = await fs.promises.stat(realCandidate);
  if (stats.isDirectory()) {
    return regularFileWithinRoot(root, path.join(realCandidate, 'index.html'));
  }
  return stats.isFile() ? { filePath: realCandidate, stats } : null;
}

function sendText(response, statusCode, message, method = 'GET') {
  const body = Buffer.from(`${message}\n`);
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(method === 'HEAD' ? undefined : body);
}

function shouldUseSpaFallback(pathname, request) {
  if (path.extname(pathname)) {
    return false;
  }
  const accept = request.headers.accept || '';
  return accept === '' || accept.includes('*/*') || accept.includes('text/html');
}

function createRequestHandler(buildDirectory = DEFAULT_BUILD_DIR) {
  const root = fs.realpathSync(buildDirectory);
  const indexPath = fs.realpathSync(path.join(root, 'index.html'));
  if (!isInsideRoot(root, indexPath)) {
    throw new Error(`Build index resolves outside the build directory: ${indexPath}`);
  }
  const indexStats = fs.statSync(indexPath);
  if (!indexStats.isFile()) {
    throw new Error(`Build index is not a file: ${indexPath}`);
  }

  return async function serveBuild(request, response) {
    const method = request.method || 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      sendText(response, 405, 'Method not allowed', method);
      return;
    }

    try {
      const pathname = decodedPathname(request.url || '/');
      const relativePath = pathname.replace(/^\/+/, '');
      const requestedPath = path.resolve(root, relativePath || 'index.html');
      if (!isInsideRoot(root, requestedPath)) {
        throw new RequestError(403, 'Path traversal is not allowed');
      }

      let result = await regularFileWithinRoot(root, requestedPath);
      let spaFallback = false;
      if (!result && shouldUseSpaFallback(pathname, request)) {
        result = { filePath: indexPath, stats: indexStats };
        spaFallback = true;
      }
      if (!result) {
        sendText(response, 404, 'Not found', method);
        return;
      }

      const extension = path.extname(result.filePath).toLowerCase();
      const headers = {
        'Content-Type': CONTENT_TYPES.get(extension) || 'application/octet-stream',
        'Content-Length': result.stats.size,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': spaFallback || extension === '.html'
          ? 'no-cache'
          : pathname.startsWith('/static/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
      };
      response.writeHead(200, headers);
      if (method === 'HEAD') {
        response.end();
        return;
      }

      const stream = fs.createReadStream(result.filePath);
      stream.on('error', (error) => {
        if (!response.headersSent) {
          sendText(response, 500, 'Internal server error');
        } else {
          response.destroy(error);
        }
      });
      stream.pipe(response);
    } catch (error) {
      if (error instanceof RequestError) {
        sendText(response, error.statusCode, error.message, method);
        return;
      }
      sendText(response, 500, 'Internal server error', method);
    }
  };
}

function serverAddress(environment = process.env) {
  const configuredBaseURL = environment.PLAYWRIGHT_BASE_URL;
  let baseURL;
  if (configuredBaseURL) {
    try {
      baseURL = new URL(configuredBaseURL);
    } catch {
      throw new Error(`PLAYWRIGHT_BASE_URL must be a valid URL, received ${JSON.stringify(configuredBaseURL)}`);
    }
    if (baseURL.protocol !== 'http:') {
      throw new Error('PLAYWRIGHT_BASE_URL must use http:// for the local static server');
    }
  }

  const rawHost = environment.HOST
    || (baseURL && baseURL.hostname.replace(/^\[(.*)\]$/, '$1'))
    || '127.0.0.1';
  const rawPort = environment.PLAYWRIGHT_PORT
    || environment.PORT
    || (baseURL && (baseURL.port || '80'))
    || '3000';
  if (!/^[1-9][0-9]{0,4}$/.test(rawPort) || Number(rawPort) > 65_535) {
    throw new Error(`PLAYWRIGHT_PORT/PORT must be an integer from 1 to 65535, received ${JSON.stringify(rawPort)}`);
  }
  return { host: rawHost, port: Number(rawPort) };
}

async function main() {
  const buildDirectory = path.resolve(
    process.env.PLAYWRIGHT_BUILD_DIR || process.env.BUILD_DIR || DEFAULT_BUILD_DIR,
  );
  const handler = createRequestHandler(buildDirectory);
  const server = http.createServer((request, response) => {
    handler(request, response);
  });
  const { host, port } = serverAddress();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  process.stdout.write(`Serving ${buildDirectory} at http://${host}:${port}\n`);

  const shutdown = () => {
    server.close((error) => {
      process.exitCode = error ? 1 : 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

module.exports = {
  RequestError,
  createRequestHandler,
  decodedPathname,
  serverAddress,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
