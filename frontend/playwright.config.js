const fs = require('fs');
const path = require('path');
const { defineConfig } = require('@playwright/test');

const localChromePath = path.resolve(__dirname, '.local/chrome/chrome-linux64/chrome');
const hasLocalChrome = fs.existsSync(localChromePath);
const chromiumExecutablePath = process.env.CHROMIUM_PATH || (hasLocalChrome ? localChromePath : undefined);

function booleanEnvironment(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`${name} must be "true" or "false", received ${JSON.stringify(value)}`);
}

function environmentValue(name, defaultValue) {
  const value = process.env[name];
  return value === undefined || value === '' ? defaultValue : value;
}

function staticBuildBaseURL() {
  const configuredBaseURL = process.env.PLAYWRIGHT_BASE_URL;
  if (configuredBaseURL) {
    return configuredBaseURL;
  }

  const port = environmentValue(
    'PLAYWRIGHT_PORT',
    environmentValue('PORT', '3000'),
  );
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535) {
    throw new Error(`PLAYWRIGHT_PORT/PORT must be an integer from 1 to 65535, received ${JSON.stringify(port)}`);
  }
  return `http://127.0.0.1:${port}`;
}

const ciParallel = booleanEnvironment('PLAYWRIGHT_CI_PARALLEL', false);
const staticBuild = booleanEnvironment('PLAYWRIGHT_STATIC_BUILD', false);
const baseURL = staticBuild
  ? staticBuildBaseURL()
  : environmentValue('PLAYWRIGHT_BASE_URL', 'http://127.0.0.1:3000');
const reporters = [
  ['list'],
  ['html', {
    outputFolder: environmentValue('PLAYWRIGHT_HTML_REPORT_DIR', 'artifacts/playwright-report'),
    open: 'never',
  }],
];

if (ciParallel) {
  reporters.push(
    ['blob', {
      outputDir: environmentValue('PLAYWRIGHT_BLOB_REPORT_DIR', 'artifacts/playwright-blob'),
    }],
    ['junit', {
      outputFile: environmentValue('PLAYWRIGHT_JUNIT_OUTPUT_FILE', 'artifacts/playwright-junit/results.xml'),
    }],
  );
}

module.exports = defineConfig({
  testDir: './e2e/specs',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: ciParallel,
  retries: 0,
  outputDir: environmentValue('PLAYWRIGHT_OUTPUT_DIR', 'test-results'),
  reporter: reporters,
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-local',
      use: {
        browserName: 'chromium',
        launchOptions: {
          executablePath: chromiumExecutablePath,
          args: ['--no-sandbox'],
        },
      },
    },
  ],
  webServer: {
    command: staticBuild
      ? 'node scripts/serve-build.cjs'
      : 'HOST=127.0.0.1 PORT=3000 npm start',
    url: baseURL,
    reuseExistingServer: booleanEnvironment('PLAYWRIGHT_REUSE_SERVER', true),
    timeout: 180_000,
  },
});
