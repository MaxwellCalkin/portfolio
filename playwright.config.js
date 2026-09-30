import { defineConfig, devices } from '@playwright/test';
export default defineConfig({testDir:'tests/e2e',timeout:45000,use:{baseURL:'http://127.0.0.1:4173',...devices['Desktop Chrome'],viewport:{width:1440,height:900}},webServer:{command:'npm run dev -- --host 127.0.0.1',url:'http://127.0.0.1:4173',reuseExistingServer:!process.env.CI}});
