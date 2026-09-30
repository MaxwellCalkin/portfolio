import {test,expect} from '@playwright/test';
test('launch, map warp, recall and singularity work without runtime errors',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#launch-button')).toBeEnabled();
  await page.locator('#launch-button').click();
  await expect(page.locator('body')).toHaveClass(/is-playing/);
  await page.getByRole('button',{name:'Warp to Philosophy',exact:true}).first().click();
  await expect(page.locator('#mode-label')).toContainText(/SURFACE|ON FOOT|EXPLORER/i);
  await page.keyboard.press('q');
  await expect(page.locator('#recall-state')).toContainText(/RECALL|RETURN/i);
  await page.keyboard.press('q');
  await page.keyboard.press('r');
  await expect(page.locator('#score-value')).not.toHaveText('000000');
  expect(errors).toEqual([]);
});
test('portfolio stays readable with JavaScript disabled',async({browser})=>{
  const context=await browser.newContext({javaScriptEnabled:false});const page=await context.newPage();
  await page.goto('http://127.0.0.1:4173/portfolio.html');
  await expect(page.locator('#journey')).toBeVisible();
  await expect(page.locator('#long-form')).toBeVisible();
  await context.close();
});
