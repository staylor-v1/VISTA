const fs = require('fs');
const path = require('path');
const { defineConfig } = require('@playwright/test');

const localChromePath = path.resolve(__dirname, '.local/chrome/chrome-linux64/chrome');
const hasLocalChrome = fs.existsSync(localChromePath);
const chromiumExecutablePath = process.env.CHROMIUM_PATH || (hasLocalChrome ? localChromePath : undefined);

module.exports = defineConfig({
  testDir: './e2e/specs',
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'artifacts/playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3000',
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
    command: 'HOST=127.0.0.1 PORT=3000 npm start',
    url: 'http://127.0.0.1:3000',
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
