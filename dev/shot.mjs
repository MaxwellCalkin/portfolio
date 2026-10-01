// node dev/shot.mjs "/dev/world.html?planet=philosophy" out.png [width] [height] [timeoutMs]
import { chromium } from 'playwright';
const [path = '/dev/world.html', out = 'shot.png', width = '1280', height = '720', timeout = '240000'] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
const errors = [];
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
const t0 = Date.now();
await page.goto(`http://127.0.0.1:4173${path}`);
try { await page.waitForFunction(() => window.__ready === true, null, { timeout: Number(timeout) }); } catch { errors.push('timeout waiting for __ready'); }
await page.screenshot({ path: out });
const hud = await page.evaluate(() => document.getElementById('hud')?.textContent || '');
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s ${hud}`);
if (errors.length) console.log(errors.slice(0, 12).join('\n'));
await browser.close();
