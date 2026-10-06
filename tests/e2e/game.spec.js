import { test, expect } from '@playwright/test';

// Software-rendered CI browsers are slow: use the light preset and let the
// simulation take larger steps so scripted play finishes in reasonable time.
const GAME = '/?quality=low&dt=0.3';
const ready = page => page.waitForFunction(() => document.querySelector('#game-canvas')?.dataset.ready === 'true', null, { timeout: 120000 });

test.describe.configure({ timeout: 240000 });

test('the portfolio chapters open before the game is ready', async ({ page }) => {
  await page.goto(GAME);
  await page.getByRole('link', { name: 'Philosophy' }).click();
  await expect(page.locator('#portfolio-dialog')).toBeVisible();
  await expect(page.locator('#dialog-title')).toContainText('A constitution');
  await page.keyboard.press('Escape');
  await expect(page.locator('#portfolio-dialog')).toBeHidden();
});

test('launch, read the Origin, travel and use the panels without errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(GAME);
  await ready(page);
  await expect(page.locator('#launch-button')).toBeEnabled();
  await page.locator('#launch-button').click();
  await expect(page.locator('body')).toHaveClass(/is-playing/);
  await expect(page.locator('#u-objective-title')).toHaveText('Read The Origin', { timeout: 30000 });

  // Walk up to the main archive and read it.
  await page.evaluate(() => window.__unfolding.debug.place(0, -19, 0, -28));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__unfolding.debug.interact());
  await expect(page.locator('#u-card')).toBeVisible();
  await expect(page.locator('#u-card-title')).toHaveText('The Origin');
  await expect(page.locator('#u-progress-discoveries')).toHaveText('1 / 9 discoveries');

  // The full chapter opens from the card.
  await page.keyboard.press('e'); // the card's primary action (the mouse may be captured)
  await expect(page.locator('#dialog-title')).toContainText('A constitution');
  await page.keyboard.press('Escape');

  // Journal and map.
  await page.keyboard.press('j');
  await expect(page.locator('#dialog-title')).toContainText('What you');
  await page.keyboard.press('j');
  await page.keyboard.press('m');
  await expect(page.locator('#dialog-title')).toContainText('Chart your');
  await page.locator('[data-travel=experience]').click();
  await expect(page.locator('#u-world-name')).toHaveText('02 · EXPERIENCE', { timeout: 60000 });
  await expect(page.locator('#u-objective-title')).toHaveText('Read The Arc');
  expect(errors).toEqual([]);
});

test('links and settings inside panels respond to clicks', async ({ page, context }) => {
  await page.goto(GAME);
  await page.getByRole('link', { name: 'Philosophy' }).click();
  await expect(page.locator('#dialog-title')).toContainText('A constitution');
  // Essays open in a new tab (stubbed so the test stays offline), and the chapter stays put.
  await context.route('https://maxwellcalkin.netlify.app/essays/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Essay</title>' }));
  await page.locator('#portfolio-dialog').evaluate(d => { d.scrollTop = 500; });
  const [essay] = await Promise.all([context.waitForEvent('page'), page.locator('#portfolio-dialog a.reading-link').first().click()]);
  await essay.waitForLoadState();
  expect(essay.url()).toContain('/essays/the-unfolding');
  await essay.close();
  expect(await page.locator('#portfolio-dialog').evaluate(d => d.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open settings and controls' }).click();
  const reduced = page.locator('#setting-reducedMotion');
  await reduced.check(); // fails if the click is swallowed
  await expect(reduced).toBeChecked();
});

test('the journal remembers discoveries across visits', async ({ page }) => {
  await page.goto(GAME);
  await page.evaluate(() => localStorage.setItem('unfolding-journal-v2', JSON.stringify({ discovered: ['philosophy:origin', 'contact:signal'], shards: [], wardens: [], visited: [] })));
  await page.reload();
  await page.getByRole('button', { name: 'Open settings and controls' }).click();
  await page.locator('[data-panel=journal]').first().click();
  await expect(page.locator('.dialog-lede')).toContainText('2 of 37 discoveries');
});

test('deep space: silence a rift, earn Tone and engage a pedal', async ({ page }) => {
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(GAME);
  await ready(page);
  await page.locator('#launch-button').click();
  await expect(page.locator('body')).toHaveClass(/is-playing/);
  await page.evaluate(() => window.__unfolding.debug.space.toRift('hum', 600));
  await expect(page.locator('#u-objective-title')).toContainText('The Hum', { timeout: 30000 });
  await expect(page.locator('#u-shipbar')).toBeVisible();
  // Down every wave as it arrives (the fighting itself is covered by the unit tests).
  await page.waitForFunction(() => { const g = window.__unfolding; g.debug.space.killAll(); return g.journal.riftClears('hum') >= 1; }, null, { timeout: 90000, polling: 250 });
  const tone = await page.evaluate(() => window.__unfolding.journal.data.tone);
  expect(tone).toBeGreaterThanOrEqual(150);
  await expect(page.locator('#u-tone-value')).toHaveText(tone.toLocaleString('en-US'));
  await page.keyboard.press('u');
  await expect(page.locator('#dialog-title')).toContainText('pedalboard');
  await page.locator('[data-pedal=overdrive]').click();
  await expect(page.locator('.pedal.is-on')).toHaveCount(1);
  expect(await page.evaluate(() => window.__unfolding.journal.data.pedals.overdrive)).toBe(1);
  await page.keyboard.press('Escape');
  await page.keyboard.press('m');
  await expect(page.locator('.map-section')).toHaveText('Deep space');
  await expect(page.locator('[data-target=hum]').locator('..').locator('..')).toContainText('SILENCED');
  expect(errors).toEqual([]);
});

test('portfolio stays readable with JavaScript disabled', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${baseURL}/portfolio.html`);
  await expect(page.locator('#journey')).toBeVisible();
  await expect(page.locator('#long-form')).toBeVisible();
  await context.close();
});
