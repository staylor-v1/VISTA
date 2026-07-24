const assert = require('assert/strict');
const path = require('path');
const { test } = require('node:test');

const configPath = path.resolve(__dirname, '..', 'playwright.config.js');
const managedEnvironment = [
  'CI',
  'PLAYWRIGHT_BASE_URL',
  'PLAYWRIGHT_BLOB_REPORT_DIR',
  'PLAYWRIGHT_CI_PARALLEL',
  'PLAYWRIGHT_HTML_REPORT_DIR',
  'PLAYWRIGHT_JUNIT_OUTPUT_FILE',
  'PLAYWRIGHT_OUTPUT_DIR',
  'PLAYWRIGHT_PORT',
  'PLAYWRIGHT_REUSE_SERVER',
  'PLAYWRIGHT_STATIC_BUILD',
  'PORT',
];

function loadConfig(environment = {}) {
  const previous = Object.fromEntries(
    managedEnvironment.map((name) => [name, process.env[name]]),
  );
  for (const name of managedEnvironment) {
    delete process.env[name];
  }
  Object.assign(process.env, environment);
  delete require.cache[configPath];

  try {
    return require(configPath);
  } finally {
    delete require.cache[configPath];
    for (const name of managedEnvironment) {
      if (previous[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  }
}

test('preserves the existing local and GitHub defaults when opt-ins are absent', () => {
  const config = loadConfig({ CI: 'true' });
  assert.equal(config.fullyParallel, false);
  assert.equal(config.outputDir, 'test-results');
  assert.deepEqual(config.reporter, [
    ['list'],
    ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }],
  ]);
  assert.equal(config.use.baseURL, 'http://127.0.0.1:3000');
  assert.deepEqual(config.webServer, {
    command: 'HOST=127.0.0.1 PORT=3000 npm start',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: true,
    timeout: 180_000,
  });
});

test('enables parallel CI, the static server, and caller-owned artifact paths explicitly', () => {
  const config = loadConfig({
    PLAYWRIGHT_BASE_URL: 'http://127.0.0.1:4312',
    PLAYWRIGHT_BLOB_REPORT_DIR: 'artifacts/shard-2/blob',
    PLAYWRIGHT_CI_PARALLEL: 'true',
    PLAYWRIGHT_HTML_REPORT_DIR: 'artifacts/shard-2/html',
    PLAYWRIGHT_JUNIT_OUTPUT_FILE: 'artifacts/shard-2/junit.xml',
    PLAYWRIGHT_OUTPUT_DIR: 'artifacts/shard-2/results',
    PLAYWRIGHT_REUSE_SERVER: 'false',
    PLAYWRIGHT_STATIC_BUILD: 'true',
  });

  assert.equal(config.fullyParallel, true);
  assert.equal(config.outputDir, 'artifacts/shard-2/results');
  assert.deepEqual(config.reporter, [
    ['list'],
    ['html', { outputFolder: 'artifacts/shard-2/html', open: 'never' }],
    ['blob', { outputDir: 'artifacts/shard-2/blob' }],
    ['junit', { outputFile: 'artifacts/shard-2/junit.xml' }],
  ]);
  assert.equal(config.use.baseURL, 'http://127.0.0.1:4312');
  assert.deepEqual(config.webServer, {
    command: 'node scripts/serve-build.cjs',
    url: 'http://127.0.0.1:4312',
    reuseExistingServer: false,
    timeout: 180_000,
  });
});

test('uses an explicit static-server port when no base URL is supplied', () => {
  const config = loadConfig({
    PLAYWRIGHT_PORT: '4314',
    PLAYWRIGHT_STATIC_BUILD: 'true',
  });
  assert.equal(config.use.baseURL, 'http://127.0.0.1:4314');
  assert.equal(config.webServer.url, 'http://127.0.0.1:4314');
});

test('rejects ambiguous boolean and port configuration', () => {
  assert.throws(
    () => loadConfig({ PLAYWRIGHT_CI_PARALLEL: '1' }),
    /PLAYWRIGHT_CI_PARALLEL must be "true" or "false"/,
  );
  assert.throws(
    () => loadConfig({
      PLAYWRIGHT_PORT: '70000',
      PLAYWRIGHT_STATIC_BUILD: 'true',
    }),
    /integer from 1 to 65535/,
  );
});
