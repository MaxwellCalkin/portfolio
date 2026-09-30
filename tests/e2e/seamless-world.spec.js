import {test,expect} from '@playwright/test';
import {Vector3,Quaternion} from 'three';

const sample=page=>page.locator('#game-canvas').evaluate(e=>({position:JSON.parse(e.dataset.position),quaternion:JSON.parse(e.dataset.shipQuaternion),speed:+e.dataset.speed,altitude:+e.dataset.altitude,planet:e.dataset.planetId,vehicle:e.dataset.vehicle==='true',landed:e.dataset.landed==='true',time:+e.dataset.simTime,settling:e.dataset.settling==='true',scene:e.dataset.worldScene}));
async function launch(page){await page.goto('/');test.skip(!await page.evaluate(()=>!!document.createElement('canvas').getContext('webgl2')),'Requires an actual WebGL2 browser');await expect(page.locator('#launch-button')).toBeEnabled();await page.locator('#launch-button').click();}

test('reverse thrust passes through zero and brakes retain the same world',async({page})=>{
 await launch(page);await page.keyboard.down('w');await expect.poll(async()=>(await sample(page)).speed).toBeGreaterThan(25);await page.keyboard.up('w');await page.keyboard.down('s');await expect.poll(async()=>(await sample(page)).speed,{timeout:15000}).toBeLessThan(-25);await page.keyboard.up('s');await page.keyboard.down('x');await expect.poll(async()=>Math.abs((await sample(page)).speed)).toBeLessThan(.1);await page.keyboard.up('x');expect((await sample(page)).scene).toBe('persistent-solar-system');
});

test('take off from a physical globe, fly to another and land without a scene reset',async({page})=>{
 test.setTimeout(300000);const errors=[],samples=[],held=new Set();page.on('pageerror',e=>errors.push(e.message));await launch(page);
 const key=async(k,on)=>{if(on&&!held.has(k)){held.add(k);await page.keyboard.down(k);}else if(!on&&held.has(k)){held.delete(k);await page.keyboard.up(k);}};
 const release=async()=>{for(const k of [...held])await key(k,false);};
 // Explicit optional warp establishes a reproducible starting surface. Subsequent travel uses keys only.
 await page.locator('.map-dot[data-planet="philosophy"]').click();await page.keyboard.press('e');await expect.poll(async()=>(await sample(page)).vehicle).toBe(true);
 await key('w',true);await key('ArrowUp',true);await expect.poll(async()=>(await sample(page)).landed).toBe(false);await page.waitForTimeout(600);await release();
 let arrived=false;for(let i=0;i<700;i++){
  const state=await sample(page);samples.push(state);if(state.planet==='experience'&&state.altitude<90){arrived=true;break;}
  const delta=new Vector3(770,210,-1750).sub(new Vector3(state.position.x,state.position.y,state.position.z)).normalize().applyQuaternion(new Quaternion(...state.quaternion).invert());
  const yaw=Math.atan2(-delta.x,-delta.z),pitch=Math.atan2(delta.y,Math.hypot(delta.x,delta.z));
  await key('a',yaw>.025);await key('d',yaw<-.025);await key('ArrowUp',pitch>.023);await key('ArrowDown',pitch<-.023);await key('w',true);await page.waitForTimeout(90);
 }
 await release();expect(arrived).toBe(true);await key('x',true);await expect.poll(async()=>Math.abs((await sample(page)).speed),{timeout:20000}).toBeLessThan(.1);await key('c',true);await expect.poll(async()=>(await sample(page)).landed,{timeout:60000}).toBe(true);await release();await expect.poll(async()=>(await sample(page)).settling,{timeout:15000}).toBe(false);
 for(let i=1;i<samples.length;i++){const a=samples[i-1],b=samples[i],dt=b.time-a.time;if(dt<=0)continue;const d=Math.hypot(b.position.x-a.position.x,b.position.y-a.position.y,b.position.z-a.position.z);expect(d).toBeLessThanOrEqual(Math.max(Math.abs(a.speed),Math.abs(b.speed))*dt+4);expect(b.scene).toBe('persistent-solar-system');}
 await page.keyboard.press('e');await expect.poll(async()=>(await sample(page)).vehicle).toBe(false);expect(errors).toEqual([]);
});
