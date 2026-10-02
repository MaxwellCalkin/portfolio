import { defineConfig, devices } from '@playwright/test';

// CHROMIUM_PATH points at a system Chromium (e.g. in containers without the
// Playwright browser download); WebGL then runs on SwiftShader.
const chromium = process.env.CHROMIUM_PATH;
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  expect: { timeout: 20000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 720 },
    launchOptions: chromium ? { executablePath: chromium, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } : {},
  },
  webServer: { command: 'npm run dev -- --host 127.0.0.1', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
});
