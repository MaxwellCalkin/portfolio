// Scripted play-through for visual QA.
// node dev/play.mjs "/?quality=high" outDir "wait:ready" "shot:attract" "click:#launch-button" "hold:KeyW:2000" "shot:walk" ...
// Steps: wait:ms | wait:ready | click:selector | press:Code | hold:Code:ms | mouse:dx:dy | eval:js | shot:name | size:WxH
import { chromium } from 'playwright';
import fs from 'node:fs';
const [path = '/', outDir = 'shots', ...steps] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const size = (steps.find(s => s.startsWith('size:')) || 'size:1280x720').slice(5).split('x').map(Number);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
const mobile = steps.includes('mobile');
const page = await browser.newPage({ viewport: { width: size[0], height: size[1] }, hasTouch: mobile || steps.includes('touch'), isMobile: mobile, deviceScaleFactor: mobile ? 2 : 1 });
const log = [];
page.on('pageerror', e => log.push('pageerror: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
page.on('console', m => { if (['error', 'warning'].includes(m.type())) log.push(`${m.type()}: ${m.text()}`); });
const t0 = Date.now();
await page.goto(`${process.env.BASE || "http://127.0.0.1:4173"}${path}`);
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
for (const step of steps) {
  const [kind, a, b] = step.split(':');
  try {
    if (kind === 'wait' && a === 'ready') { await page.waitForFunction(() => document.querySelector('#game-canvas')?.dataset.ready === 'true', null, { timeout: 240000 }); }
    else if (kind === 'wait') await page.waitForTimeout(Number(a));
    else if (kind === 'click') await page.click(step.slice(6));
    else if (kind === 'press') await page.keyboard.press(a);
    else if (kind === 'hold') { await page.keyboard.down(a); await page.waitForTimeout(Number(b)); await page.keyboard.up(a); }
    else if (kind === 'mouse') await page.evaluate(([dx, dy]) => { const g = window.__unfolding; if (g?.input) { g.input.look.x += dx; g.input.look.y += dy; } }, [Number(a), Number(b)]);
    else if (kind === 'eval') console.log(stamp(), 'eval', JSON.stringify(await page.evaluate(step.slice(5))));
    else if (kind === 'shot') { await page.screenshot({ path: `${outDir}/${a}.png` }); console.log(stamp(), 'shot', a); }
  } catch (e) { log.push(`step ${step} failed: ${e.message.split('\n')[0]}`); }
}
console.log(stamp(), 'done');
if (log.length) console.log([...new Set(log)].slice(0, 30).join('\n'));
await browser.close();
