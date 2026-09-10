const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './tests/e2e',
    fullyParallel: false,
    workers: 1,
    timeout: 30000,
    outputDir: '/tmp/xcpc-tools-playwright',
    use: { channel: 'chromium', baseURL: 'http://127.0.0.1:15983', httpCredentials: { username: 'admin', password: 'test-view-password' }, viewport: { width: 1440, height: 1000 } },
    webServer: {
        command: 'node tests/start-server.cjs',
        url: 'http://127.0.0.1:15983/version',
        reuseExistingServer: false,
        timeout: 30000,
    },
});
