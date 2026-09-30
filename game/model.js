export const WEAPONS = [
  {name:'PULSE I',at:0,damage:30,interval:0.25,bolts:1},
  {name:'PRISM II',at:120,damage:38,interval:0.19,bolts:2},
  {name:'NOVA III',at:320,damage:48,interval:0.15,bolts:3},
  {name:'SINGULARITY IV',at:680,damage:65,interval:0.11,bolts:3},
];
export function weaponForXP(xp) { return WEAPONS.filter(w=>xp >= w.at).at(-1) || WEAPONS[0]; }
export function levelForXP(xp) { return WEAPONS.indexOf(weaponForXP(xp))+1; }
export function clamp(value,min,max) { return Math.min(max,Math.max(min,value)); }
export function distance3(a,b) { return Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z); }
export function hitSegmentSphere(start,end,center,radius) {
  const dx=end.x-start.x,dy=end.y-start.y,dz=end.z-start.z;
  const length=dx*dx+dy*dy+dz*dz;
  const t=length ? clamp(((center.x-start.x)*dx+(center.y-start.y)*dy+(center.z-start.z)*dz)/length,0,1) : 0;
  return Math.hypot(start.x+dx*t-center.x,start.y+dy*t-center.y,start.z+dz*t-center.z)<=radius;
}
export function sanitizeName(name) { return String(name||'Explorer').normalize('NFKC').replace(/[^\p{L}\p{N} _-]/gu,'').trim().slice(0,20)||'Explorer'; }
export function validateScore(row) {
  return row && typeof row==='object' && Number.isFinite(row.score) && row.score>=0 && row.score<=1e9 && Number.isFinite(row.kills) && row.kills>=0 && Number.isInteger(row.level) && row.level>=1 && row.level<=4 && typeof row.date==='string';
}
export function sortedScores(rows) { return rows.filter(validateScore).map(r=>({...r,name:sanitizeName(r.name)})).sort((a,b)=>b.score-a.score).slice(0,10); }
export function loadScores(storage) { try { const value=JSON.parse(storage.getItem('unfolding-scores-v1')||'[]'); return Array.isArray(value)?sortedScores(value):[]; } catch { return []; } }
export function saveScore(storage,rows,row) { const next=sortedScores([...rows,row]); try { storage.setItem('unfolding-scores-v1',JSON.stringify(next));return {rows:next,persisted:true}; } catch { return {rows:next,persisted:false}; } }
export function applyDamage(state,amount) {
  const shieldDamage=Math.min(state.shield,amount);state.shield-=shieldDamage;state.health=Math.max(0,state.health-(amount-shieldDamage));return state.health<=0;
}
export const CAMPAIGN_WORLDS=['philosophy','experience','projects','mission','contact'];
export function registerBossDefeat(defeated,id){return CAMPAIGN_WORLDS.includes(id)?[...new Set([...defeated.filter(x=>CAMPAIGN_WORLDS.includes(x)),id])]:[...defeated];}
export function campaignComplete(defeated){return CAMPAIGN_WORLDS.every(id=>defeated.includes(id));}
