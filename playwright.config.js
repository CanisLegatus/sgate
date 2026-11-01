const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/browser', timeout: 90000, expect: { timeout: 15000 }, workers: 1,
  reporter: 'list', outputDir: 'test-results',
  use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.SGATE_CHROMIUM || '/usr/bin/chromium', args: ['--no-sandbox'] },
    acceptDownloads: true, trace: 'retain-on-failure' }
});
