import {test,expect} from '@playwright/test';

const snapshot=page=>page.locator('#game-canvas').evaluate(e=>({speed:+e.dataset.speed,shots:+e.dataset.shotsFired||0,wardens:+e.dataset.wardens,mode:e.dataset.mode,vehicle:e.dataset.vehicle==='true'}));

test('real combat death cannot dismiss and both saved runs can restart into playable fresh expeditions',async({page})=>{
 test.setTimeout(260000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
 test.skip(!await page.evaluate(()=>!!document.createElement('canvas').getContext('webgl2')),'Requires an actual WebGL2 renderer');await expect(page.locator('#launch-button')).toBeEnabled();await page.locator('#launch-button').click();
 for(let cycle=1;cycle<=2;cycle++){
  await page.keyboard.press('m');await page.locator('.warp-button[data-warp="philosophy"]').click();await page.waitForTimeout(500);await page.keyboard.press('r');await page.keyboard.down('w');
  await expect.poll(async()=>Number(await page.locator('#health-value').innerText()),{timeout:100000,intervals:[300]}).toBe(0);await page.keyboard.up('w');
  const dialog=page.locator('#portfolio-dialog');await expect(dialog).toHaveAttribute('data-panel','death');await expect(page.locator('#close-dialog')).not.toBeVisible();await expect(dialog.locator('[data-close]')).toHaveCount(0);await expect(page.locator('#death-restart')).toBeVisible();
  for(const key of ['Escape','Escape','m']){await page.keyboard.press(key);await expect(dialog).toHaveAttribute('open','');await expect(dialog).toHaveAttribute('data-panel','death');}
  await page.mouse.click(5,250);await expect(dialog).toHaveAttribute('open','');
  // Never publish synthetic QA entries to a shared board. This suite is intended for local Vite.
  await expect(page.locator('#save-score-button')).toContainText('Save run');await page.locator('#pilot-name').fill(`QA Restart ${cycle}`);await page.locator('#save-score-button').click();await expect(page.locator('#leaderboard-results')).toContainText(`QA Restart ${cycle}`);await page.keyboard.press('Escape');await expect(dialog).toHaveAttribute('open','');
  await page.locator('#death-restart').click();await expect(dialog).not.toBeVisible();await expect(page.locator('#health-value')).toHaveText('100');await expect(page.locator('#shield-value')).toHaveText('100');await expect(page.locator('#score-value')).toHaveText('000000');await expect(page.locator('#level-value')).toHaveText('01');const fresh=await snapshot(page);expect(fresh).toMatchObject({wardens:0,mode:'space',vehicle:true,shots:0});
  await page.waitForTimeout(300);await page.keyboard.down('w');await expect.poll(async()=>(await snapshot(page)).speed).toBeGreaterThan(10);await page.keyboard.up('w');await page.keyboard.press(' ');await expect.poll(async()=>(await snapshot(page)).shots).toBeGreaterThan(0);
 }
 await page.keyboard.press('Escape');await expect(page.locator('#portfolio-dialog')).toHaveAttribute('data-panel','pause');await expect(page.locator('#close-dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.locator('#portfolio-dialog')).not.toBeVisible();expect(errors).toEqual([]);
});
