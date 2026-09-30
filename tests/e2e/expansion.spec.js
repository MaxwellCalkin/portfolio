import {test,expect} from '@playwright/test';

async function start(page){
 await page.goto('/');
 const supported=await page.evaluate(()=>!!document.createElement('canvas').getContext('webgl2'));
 test.skip(!supported,'Gameplay verification requires a WebGL2-capable browser');
 await expect(page.locator('#launch-button')).toBeEnabled();
 await page.locator('#launch-button').click();
}
const state=page=>page.locator('#game-canvas').evaluate(e=>({position:JSON.parse(e.dataset.position),heading:Number(e.dataset.heading),speed:Number(e.dataset.speed),vehicle:e.dataset.vehicle==='true',landed:e.dataset.landed==='true',loop:e.dataset.loopActive==='true'}));

test('ground clicks fire, mouse aims, collision blocks ship, and modals close',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));await start(page);
 await page.locator('.map-dot[data-planet="philosophy"]').click();
 const canvas=page.locator('#game-canvas');await page.mouse.move(620,380);await page.waitForTimeout(120);const heading=(await state(page)).heading;await page.mouse.move(680,390,{steps:4});await expect.poll(async()=>(await state(page)).heading).not.toBe(heading);
 await page.mouse.click(680,390);await expect.poll(async()=>Number(await canvas.getAttribute('data-shots-fired'))).toBeGreaterThan(0);
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'Resume expedition'}).click();await page.locator('.map-dot[data-planet="philosophy"]').click();
 await page.keyboard.down('s');await page.waitForTimeout(1800);await page.keyboard.up('s');const position=(await state(page)).position;const hull=JSON.parse(await canvas.getAttribute('data-ship-position'));expect(Math.hypot(position.x-hull[0],position.y-hull[1],position.z-hull[2])).toBeGreaterThan(3.5);
 await page.getByRole('link',{name:'Projects',exact:true}).click();await expect(page.locator('#dialog-content')).toContainText('BEACN');await expect(page.locator('#dialog-content')).toContainText('Heard Us');
 await expect(page.getByRole('button',{name:'Close panel'})).not.toContainText('CLOSE');await page.getByRole('button',{name:'Close panel'}).click();await expect(page.locator('#portfolio-dialog')).not.toBeVisible();expect(errors).toEqual([]);
});

test('the evasive loop keeps entry speed and restores the flight heading',async({page})=>{
 await start(page);await page.keyboard.down('w');await expect.poll(async()=>(await state(page)).speed).toBeGreaterThan(100);await page.keyboard.up('w');const before=await state(page);
 await page.keyboard.press('q');await expect.poll(async()=>(await state(page)).loop).toBe(true);await expect.poll(async()=>(await state(page)).loop).toBe(false);const after=await state(page);
 expect(after.speed).toBeGreaterThanOrEqual(before.speed-1);expect(Math.abs(after.heading-before.heading)).toBeLessThan(.08);
});

test('five distinct world bosses unlock the actual campaign reward',async({page})=>{
 test.slow();const errors=[];page.on('pageerror',e=>errors.push(e.message));await start(page);
 let count=0;for(const id of ['philosophy','experience','projects','mission','contact']){
  await page.locator(`.map-dot[data-planet="${id}"]`).click();await page.keyboard.press('q');if((await page.locator('#ultimate-state').innerText()).includes('READY'))await page.keyboard.press('r');
  await page.keyboard.down('w');await page.keyboard.down(' ');await expect.poll(async()=>Number(await page.locator('#game-canvas').getAttribute('data-wardens')),{timeout:25000}).toBe(++count);await page.keyboard.up('w');await page.keyboard.up(' ');
 }
 await expect(page.locator('#dialog-title')).toContainText('Starforged');expect(await page.evaluate(()=>localStorage.getItem('unfolding-starforged-v1'))).toBe('earned');expect(errors).toEqual([]);
});
