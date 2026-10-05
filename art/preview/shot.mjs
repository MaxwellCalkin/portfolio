// Usage: node art/preview/shot.mjs "<query string>" out.png [width] [height]
// Example: node art/preview/shot.mjs "model=/models/flora.glb&palette=philosophy" /tmp/flora.png
// Needs the Vite dev server on http://127.0.0.1:4173 (npm run dev -- --host 127.0.0.1).
import { chromium } from 'playwright';

const [query = '', out = 'preview.png', width = '1400', height = '900'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:4173/art/preview/index.html?${query}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
await page.waitForTimeout(600);
await page.screenshot({ path: out });
const info = await page.evaluate(() => document.getElementById('info').textContent);
console.log(info);
if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
await browser.close();
