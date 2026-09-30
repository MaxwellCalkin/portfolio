import * as THREE from 'three';
import { PLANETS,createSpaceWorld,createSurfaceWorld,createShip,createAstronaut,createEnemy,createGlow } from './world.js';
import {initUI} from './ui.js';
import {fetchGlobalScores,submitGlobalScore} from './leaderboard.js';
import {Soundscape} from './audio.js';
import {clamp,weaponForXP,levelForXP,hitSegmentSphere,loadScores,saveScore,sanitizeName,applyDamage} from './model.js';

const ui=initUI();
const canvas=document.querySelector('#game-canvas');
const sound=new Soundscape();
const keys=new Set();
const clock=new THREE.Clock();
const UP=new THREE.Vector3(0,1,0);
const forward=new THREE.Vector3(),right=new THREE.Vector3(),tmp=new THREE.Vector3();
let renderer,space,surface,ship,astronaut,animation;
let time=0,uiTick=0,spaceSpeed=0,yaw=0,pitch=0,footYaw=0,footPitch=0,fireHeld=false,dragging=false,lastPointer=null;
let shotTimer=0,waveTimer=0,invincible=0,damageTimer=0,dashTimer=0,transition=0,overlay=false,blurred=false;
let anchor=null,anchorMesh=null,ultimateEffect=null,lastSavedSignature='',frameCount=0;
let runDuration=0;
let reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
const projectiles=[],enemies=[],effects=[],props=[];
const labels=document.createElement('div');labels.id='world-labels';labels.className='world-labels';document.body.append(labels);
const planetLabels=PLANETS.map(p=>{const button=document.createElement('button');button.className='world-label';button.id=`world-label-${p.id}`;button.textContent=p.name;button.setAttribute('aria-label',`Warp to ${p.name}`);button.addEventListener('click',()=>landPlanet(p.id,true));labels.append(button);return {p,button};});
const scene=new THREE.Scene();
const camera=new THREE.PerspectiveCamera(56,innerWidth/innerHeight,.1,12000);
const player=new THREE.Vector3(0,8,120);
let board=[];try{board=loadScores(localStorage);}catch{}
const state={started:false,mode:'space',planetId:null,health:100,shield:100,speed:0,xp:0,level:1,score:0,kills:0,ultimate:100,dashCooldown:0,recallCooldown:0,recallActive:false,nearPlanet:null,nearestDistance:0,canLand:false,canInteract:false,paused:false,visited:[],weaponName:'PULSE I',leaderboard:board,leaderboardMode:'local',leaderboardLoading:false,leaderboardNotice:'Saved on this device only.',position:{x:0,z:120},targetPlanet:null,reducedMotion,sound:false,wave:1};
const aimRay=new THREE.Raycaster();
const boltGeo=new THREE.CylinderGeometry(.075,.11,3.2,6);
const enemyBoltGeo=new THREE.SphereGeometry(.23,6,6);
const boltMaterials=[new THREE.MeshBasicMaterial({color:0x9bf6ed}),new THREE.MeshBasicMaterial({color:0xff856c})];
const fragmentGeo=new THREE.IcosahedronGeometry(.23,0);
const ringGeo=new THREE.TorusGeometry(1,.018,5,100);
const effectMaterials=new Map();
function effectMaterial(color){if(!effectMaterials.has(color))effectMaterials.set(color,new THREE.MeshBasicMaterial({color,transparent:true,opacity:1,blending:THREE.AdditiveBlending,depthWrite:false}));return effectMaterials.get(color);}
function toast(text){ui.showToast(text);}
function getPlanet(id){return PLANETS.find(p=>p.id===id)||PLANETS[0];}
function setSceneColor(color){scene.background=new THREE.Color(color);}
function resetControls(){keys.clear();fireHeld=false;dragging=false;lastPointer=null;}
function releaseMouse(){if(document.pointerLockElement===canvas)document.exitPointerLock();}
function rotateView(dx,dy){if(state.mode==='space'){yaw-=dx*.003;pitch=clamp(pitch-dy*.0025,-1.15,1.15);}else{footYaw-=dx*.0028;footPitch=clamp(footPitch+dy*.0018,-.5,.65);}}
function flash(kind='warp'){document.body.dataset.effect=reducedMotion?'soft':kind;clearTimeout(flash.timer);flash.timer=setTimeout(()=>delete document.body.dataset.effect,kind==='ultimate'?1800:600);}
function direction(){return forward.set(-Math.sin(yaw)*Math.cos(pitch),Math.sin(pitch),-Math.cos(yaw)*Math.cos(pitch));}
function footDirection(){return forward.set(-Math.sin(footYaw),0,-Math.cos(footYaw));}
function isInputBlocked(){return !state.started||overlay||blurred||state.health<=0;}
function updateViewport(){if(!renderer)return;camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setPixelRatio(Math.min(devicePixelRatio,innerWidth<700?1.25:1.65));renderer.setSize(innerWidth,innerHeight);}
function addEffect(position,color,count=14,power=8){
  const mat=effectMaterial(color);
  for(let i=0;i<count;i++){const m=new THREE.Mesh(fragmentGeo,mat);m.position.copy(position);m.scale.setScalar(.7+Math.random()*1.7);scene.add(m);effects.push({mesh:m,velocity:new THREE.Vector3((Math.random()-.5)*power,(Math.random()-.2)*power,(Math.random()-.5)*power),life:.45+Math.random()*.65,max:1.1});}
}
function addRing(position,color,maxSize=15,life=.65){const mat=effectMaterial(color).clone();const m=new THREE.Mesh(ringGeo,mat);m.position.copy(position);m.rotation.x=Math.PI/2;scene.add(m);effects.push({mesh:m,life,max:life,ring:true,size:maxSize,ownMaterial:true});}
function clearDynamic(){const propMats=new Set(props.map(p=>p.mat));for(const prop of props)prop.mesh.geometry.dispose();for(const mat of propMats)mat.dispose();for(const list of [projectiles,enemies,effects,props]){for(const v of list){scene.remove(v.mesh);v.mesh.userData.dispose?.();if(v.ownMaterial)v.mesh.material.dispose();}list.length=0;}if(anchorMesh){scene.remove(anchorMesh);anchorMesh.material?.dispose();anchorMesh.geometry?.dispose();anchorMesh=null;}anchor=null;state.recallActive=false;if(ultimateEffect){scene.remove(ultimateEffect.group);ultimateEffect.group.traverse(o=>{if(!o.isSprite)o.geometry?.dispose();o.material?.dispose();});ultimateEffect=null;}}
function applyWorldVisibility(){space.group.visible=state.mode==='space';ship.visible=true;astronaut.visible=state.mode==='surface';}
function enterSpace(initial=false){
  releaseMouse();clearDynamic();if(surface){surface.dispose();surface=null;}
  state.mode='space';state.canInteract=false;state.canLand=false;state.canEmbark=false;
  scene.fog=new THREE.FogExp2(0x050810,.00008);setSceneColor(0x050810);
  if(!initial&&state.planetId){const planet=getPlanet(state.planetId),p=new THREE.Vector3(...planet.position);player.copy(p).add(new THREE.Vector3(0,planet.radius*.35,planet.radius+90));yaw=0;pitch=.12;spaceSpeed=25;}
  ship.position.copy(player);applyWorldVisibility();
  camera.position.copy(player).add(new THREE.Vector3(0,12,35));camera.lookAt(player);
  if(!initial){transition=1.2;flash('warp');sound.play('warp');toast('Orbit reached. Pick a signal, or chart your own course.');}
}
function landPlanet(id,warp=false){
  if(!state.started)start();const p=getPlanet(id);ui.closePanel();resetControls();
  clearDynamic();if(surface)surface.dispose();
  state.mode='surface';state.canEmbark=false;state.planetId=p.id;state.health=100;state.shield=100;state.canLand=false;state.nearPlanet=p.id;state.wave=1;waveTimer=4;spaceSpeed=0;footYaw=0;footPitch=0;
  surface=createSurfaceWorld(scene,p.id);player.fromArray(surface.spawn);ship.position.fromArray(surface.shipPosition);ship.rotation.set(0,Math.PI*.2,0);surface.setParkedShip?.(ship);astronaut.position.copy(player);
  scene.fog=new THREE.FogExp2(p.id==='experience'?0x4a2730:p.id==='contact'?0x1e263a:p.id==='projects'?0x241a42:0x102c36,.0042);
  setSceneColor(p.id==='experience'?0x211b2c:p.id==='projects'?0x151426:0x0d1b2b);
  applyWorldVisibility();camera.position.copy(player).add(new THREE.Vector3(0,6,12));camera.lookAt(player.clone().add(new THREE.Vector3(0,1.7,-10)));
  state.visited=[...new Set([...state.visited,id])];state.score+=warp?0:25;
  buildDestructibles(p);spawnWave();transition=1.4;invincible=3;flash('warp');sound.play('warp');
  toast(`${p.name} · Signal acquired. E at the archive. E near your ship to launch.`);pushUI();
}
function start(){if(state.started)return;state.started=true;ship.scale.setScalar(1);transition=.5;ui.closePanel();toast('W to fly · Drag to steer · E to land · M for instant travel');pushUI();}
function buildDestructibles(p){
  const mat=new THREE.MeshStandardMaterial({color:p.color,emissive:p.color,emissiveIntensity:.5,roughness:.55,metalness:.2});
  for(let i=0;i<22;i++){const a=i*2.39996,r=27+(i%6)*9;const x=Math.cos(a)*r,z=Math.sin(a)*r;const h=1.8+Math.random()*2;const m=new THREE.Mesh(new THREE.OctahedronGeometry(1,0),mat);m.scale.set(.7,h,.7);m.position.set(x,surface.heightAt(x,z)+h,z);m.rotation.y=a;scene.add(m);const colliderId=surface.addCollider?.({type:'circle',x,z,radius:.7,kind:'destructible'});props.push({mesh:m,hp:50,radius:1.8,type:'crystal',mat,colliderId});}
}
function spawnWave(){
  if(state.mode!=='surface')return;
  const n=Math.min(5+state.wave,12);
  for(let i=0;i<n;i++){const a=i/n*Math.PI*2+.4+Math.random()*.2,r=33+Math.random()*18;const m=createEnemy((i+state.wave)%3);const x=player.x+Math.cos(a)*r,z=player.z+Math.sin(a)*r;m.position.set(clamp(x,-140,140),0,clamp(z,-140,140));m.position.y=surface.heightAt(m.position.x,m.position.z)+1.8;scene.add(m);enemies.push({mesh:m,hp:65+state.wave*8,shoot:1.2+Math.random()*4,phase:Math.random()*10,speed:2.5+state.wave*.2});}
}
function shoot(){
  if(isInputBlocked()||shotTimer>0)return;const weapon=weaponForXP(state.xp);shotTimer=state.mode==='space'?.17:weapon.interval;sound.play('fire');state.shotsFired=(state.shotsFired||0)+1;canvas.dataset.shotsFired=String(state.shotsFired);
  let origin,dir;
  if(state.mode==='space'){dir=direction().clone();origin=player.clone().addScaledVector(dir,7);}
  else {origin=astronaut.localToWorld(astronaut.userData.muzzle.clone());const viewDirection=camera.getWorldDirection(new THREE.Vector3());aimRay.setFromCamera(new THREE.Vector2(0,0),camera);const targets=[...enemies.map(e=>e.mesh),...props.map(p=>p.mesh),surface.group.getObjectByName('terrain')].filter(Boolean);const intersection=aimRay.intersectObjects(targets,true)[0];const aimPoint=intersection?.point||camera.position.clone().addScaledVector(viewDirection,150);dir=aimPoint.clone().sub(origin).normalize();
    // Small, bounded aim assist makes mouse, keyboard, and touch equally playable.
    let best=null,bestDot=.94;for(const e of enemies){const to=e.mesh.position.clone().sub(origin);const distance=to.length();const dot=to.normalize().dot(dir);if(distance<65&&dot>bestDot){best=e;bestDot=dot;}}
    if(best)dir=best.mesh.position.clone().sub(origin).normalize();
  }
  for(let n=0;n<weapon.bolts;n++){const spread=(n-(weapon.bolts-1)/2)*.035;const d=dir.clone().applyAxisAngle(UP,spread).normalize();spawnBolt(origin,d,false,weapon.damage);}
  addEffect(origin,0x93fff3,2,1.5);
}
function spawnBolt(origin,dir,enemy=false,damage=15){const m=new THREE.Mesh(enemy?enemyBoltGeo:boltGeo,boltMaterials[enemy?1:0]);m.position.copy(origin);if(!enemy)m.quaternion.setFromUnitVectors(UP,dir);scene.add(m);projectiles.push({mesh:m,velocity:dir.clone().multiplyScalar(enemy?21:state.mode==='space'?240:120),life:enemy?4:2,enemy,damage});}
function killEnemy(e,ult=false){scene.remove(e.mesh);e.mesh.userData.dispose?.();enemies.splice(enemies.indexOf(e),1);addEffect(e.mesh.position,ult?0xccbbff:0xffa887,reducedMotion?6:18,ult?18:10);addRing(e.mesh.position,0xff9b78,4,.35);state.kills++;state.xp+=40;state.score+=100+state.wave*10;state.ultimate=clamp(state.ultimate+(ult?3:12),0,100);const level=levelForXP(state.xp);if(level>state.level){state.level=level;state.weaponName=weaponForXP(state.xp).name;toast(`WEAPON EVOLVED · ${state.weaponName} · ${weaponForXP(state.xp).bolts}-bolt burst`);sound.play('upgrade');flash('upgrade');state.shield=100;}sound.play('hit');}
function damagePlayer(amount){if(invincible>0||isInputBlocked())return;damageTimer=0;applyDamage(state,amount);flash('damage');sound.play('hit');if(state.health<=0){releaseMouse();resetControls();toast('Suit rebooted. Your score is safe. Save it in the flight log, then redeploy.');ui.openPanel('leaderboard');}}
function dash(){if(isInputBlocked()||state.dashCooldown>0)return;state.dashCooldown=4;dashTimer=.2;invincible=.45;addRing(player.clone().add(new THREE.Vector3(0,1,0)),0x7ff9e8,9,.4);sound.play('dash');if(!reducedMotion)flash('dash');}
function recall(){if(isInputBlocked()||state.mode!=='surface')return;if(anchor){addRing(player.clone().add(new THREE.Vector3(0,1,0)),0x89ffec,12,.6);player.copy(anchor.position);state.health=Math.max(state.health,anchor.health);state.shield=Math.max(state.shield,anchor.shield);state.recallCooldown=10;anchor=null;state.recallActive=false;scene.remove(anchorMesh);anchorMesh.material.dispose();anchorMesh.geometry.dispose();anchorMesh=null;invincible=1;flash('recall');sound.play('recall');toast('RECALLED · Position and vitality restored');}else if(state.recallCooldown<=0){anchor={position:player.clone(),health:state.health,shield:state.shield,life:8};const mat=new THREE.MeshBasicMaterial({color:0x85ffe7,transparent:true,opacity:.65,wireframe:true});anchorMesh=new THREE.Mesh(new THREE.CapsuleGeometry(.45,1.3,4,8),mat);anchorMesh.position.copy(player).add(new THREE.Vector3(0,1.2,0));scene.add(anchorMesh);state.recallActive=true;toast('ANCHOR SET · Q again to return within 8 seconds');sound.play('dash');}}
function ultimate(){
  if(isInputBlocked()||state.ultimate<100||ultimateEffect)return;if(state.mode!=='surface'){toast('Singularity requires a planet surface. Land with E or use the map.');return;}
  state.ultimate=0;invincible=4;const center=player.clone().addScaledVector(footDirection(),16);center.y=surface.heightAt(center.x,center.z)+4;
  const group=new THREE.Group();group.position.copy(center);
  const orbMaterial=new THREE.ShaderMaterial({transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,uniforms:{uTime:{value:0},uOpacity:{value:1}},vertexShader:`varying vec3 vNormal;varying vec3 vView;varying vec3 vPos;void main(){vPos=position;vNormal=normalize(normalMatrix*normal);vec4 p=modelViewMatrix*vec4(position,1.);vView=normalize(-p.xyz);gl_Position=projectionMatrix*p;}`,fragmentShader:`uniform float uTime,uOpacity;varying vec3 vNormal,vView,vPos;void main(){float rim=pow(1.-abs(dot(normalize(vNormal),normalize(vView))),2.2);float veins=pow(abs(sin(vPos.y*19.+sin(vPos.x*11.+uTime*8.)*2.+vPos.z*13.-uTime*5.)),18.);vec3 c=mix(vec3(.28,.035,.92),vec3(.45,.95,1.),veins*.7+rim*.5);gl_FragColor=vec4(c*(1.4+veins),(.06+rim*.65+veins*.18)*uOpacity);}`});
  const orb=new THREE.Mesh(new THREE.IcosahedronGeometry(1,4),orbMaterial);
  const halo=createGlow(0x9c76ff,12);group.add(orb,halo);
  const rings=[];for(let i=0;i<4;i++){const m=new THREE.Mesh(new THREE.TorusGeometry(2+i*.6,.04,6,100),new THREE.MeshBasicMaterial({color:i%2?0x93ffee:0xc5a4ff,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false}));m.rotation.set(i*.7,.3*i,i*.6);group.add(m);rings.push(m);}
  scene.add(group);ultimateEffect={group,orb,halo,rings,age:0,detonated:false};sound.play('ultimate');toast('SINGULARITY · COLLAPSE THE IMPOSSIBLE');
}
function updateUltimate(dt){if(!ultimateEffect)return;const e=ultimateEffect;e.age+=dt;const t=e.age;e.orb.material.uniforms.uTime.value=t;
  if(t<1){e.orb.scale.setScalar(.5+t*2.7);e.halo.scale.setScalar(10+t*18);e.rings.forEach((r,i)=>{r.rotation.x+=dt*(2+i);r.rotation.z+=dt*3;r.scale.setScalar(1+t);});if(!reducedMotion&&frameCount%2===0){const a=Math.random()*Math.PI*2,r=8+Math.random()*15;const pos=e.group.position.clone().add(new THREE.Vector3(Math.cos(a)*r,(Math.random()-.5)*12,Math.sin(a)*r));const m=new THREE.Mesh(fragmentGeo,effectMaterial(0xd0b7ff));m.position.copy(pos);scene.add(m);effects.push({mesh:m,velocity:e.group.position.clone().sub(pos).multiplyScalar(2.5),life:.4,max:.4});}}
  else {if(!e.detonated){e.detonated=true;flash('ultimate');addRing(e.group.position,0xc5a1ff,110,1.6);addRing(e.group.position,0x96fff0,85,1.2);addEffect(e.group.position,0xc7b1ff,reducedMotion?15:85,65);for(const enemy of [...enemies])if(enemy.mesh.position.distanceTo(e.group.position)<95)killEnemy(enemy,true);for(const prop of [...props])if(prop.mesh.position.distanceTo(e.group.position)<80)destroyProp(prop,true);}
    e.orb.scale.setScalar(3+Math.max(0,t-1)*35);e.orb.material.uniforms.uOpacity.value=Math.max(0,1-(t-1)*.7);e.halo.visible=false;e.rings.forEach((r,i)=>{r.scale.setScalar(2+(t-1)*(18+i*4));r.material.opacity=Math.max(0,1-(t-1)*.7);});}
  if(t>2.7){scene.remove(e.group);e.group.traverse(o=>{if(o.isMesh){o.geometry.dispose();o.material.dispose();}else if(o.isSprite)o.material.dispose();});ultimateEffect=null;}
}
function destroyProp(prop,ult=false){if(prop.colliderId)surface.removeCollider?.(prop.colliderId);scene.remove(prop.mesh);prop.mesh.geometry.dispose();props.splice(props.indexOf(prop),1);if(!props.some(p=>p.mat===prop.mat))prop.mat.dispose();addEffect(prop.mesh.position,ult?0xbca3ff:0x8aecd9,reducedMotion?4:10,ult?25:9);state.score+=20;state.xp+=5;state.ultimate=clamp(state.ultimate+2,0,100);const level=levelForXP(state.xp);if(level>state.level){state.level=level;state.weaponName=weaponForXP(state.xp).name;toast(`WEAPON EVOLVED · ${state.weaponName} · ${weaponForXP(state.xp).bolts}-bolt burst`);sound.play('upgrade');}}
function interact(){if(isInputBlocked())return;if(state.mode==='space'){if(state.canLand)landPlanet(state.nearPlanet);else toast('Approach a planet to land, or press M for instant warp.');}
  else {const beacon=new THREE.Vector3(...surface.beaconPosition);if(player.distanceTo(beacon)<13){ui.openPanel(state.planetId);return;}if(player.distanceTo(ship.position)<17){enterSpace();return;}toast('Find the archive beacon or return to your ship. M opens the system map.');}}
function restart(){ui.closePanel();resetControls();shotTimer=0;dashTimer=0;invincible=0;damageTimer=0;waveTimer=4;state.health=100;state.shield=100;state.xp=0;state.level=1;state.score=0;state.kills=0;state.ultimate=100;state.weaponName='PULSE I';state.wave=1;runDuration=0;state.dashCooldown=0;state.recallCooldown=0;lastSavedSignature='';if(state.mode==='surface')landPlanet(state.planetId,true);else enterSpace(true);pushUI();}
async function saveRun(name){
  const signature=`${state.score}:${state.kills}:${state.xp}`;
  if(state.leaderboardLoading)return;
  if(signature===lastSavedSignature){toast('This run is already in your flight log.');return;}
  if(!state.score){toast('Explore or clear anomalies to earn a score first.');return;}
  const row={name:sanitizeName(name),score:Math.round(state.score),kills:state.kills,level:levelForXP(state.xp),date:new Date().toISOString(),xp:state.xp,duration:Math.floor(runDuration)};
  if(state.leaderboardMode==='global'){
    state.leaderboardLoading=true;pushUI();
    try {const result=await submitGlobalScore(row);state.leaderboard=result.scores;lastSavedSignature=signature;toast(result.ranked===false?'Score submitted. The public board retains the top 100 runs.':'Score published to the community flight log.');}
    catch(error){state.leaderboardNotice=error.status===429?'Too many requests. Wait a minute before publishing again.':'Publishing failed. Your run is still here; try again shortly.';toast(state.leaderboardNotice);}
    finally {state.leaderboardLoading=false;pushUI();}
  } else {
    let result;try{result=saveScore(localStorage,state.leaderboard,row);}catch{result={rows:[...state.leaderboard,row],persisted:false};}
    state.leaderboard=result.rows;lastSavedSignature=signature;pushUI();toast(result.persisted?'Run saved on this device.':'Run recorded for this visit; browser storage is unavailable.');
  }
}
async function connectLeaderboard(){
  try {const result=await fetchGlobalScores();state.leaderboardMode='global';state.leaderboard=result.scores;state.leaderboardNotice='Public community scores. Casual, unverified runs.';pushUI();}
  catch {state.leaderboardMode='local';state.leaderboardNotice='Community board is unavailable in this preview. Runs are saved on this device.';pushUI();}
}
function handleCommand(e){const c=e.detail||{};switch(c.type){case 'start':start();break;case 'warp':releaseMouse();landPlanet(c.planet,true);break;case 'land':interact();break;case 'takeoff':if(state.mode==='surface')enterSpace();break;case 'interact':interact();break;case 'dash':dash();break;case 'recall':recall();break;case 'ultimate':ultimate();break;case 'fire':fireHeld=!!c.pressed;if(fireHeld)shoot();break;case 'overlay':overlay=!!c.open;resetControls();if(overlay)releaseMouse();break;case 'pause':overlay=!overlay;resetControls();break;case 'settings':if(typeof c.reducedMotion==='boolean')reducedMotion=state.reducedMotion=c.reducedMotion;if(typeof c.sound==='boolean'){state.sound=c.sound;sound.setEnabled(c.sound);}break;case 'saveScore':saveRun(c.name);break;case 'restart':restart();break;case 'input':if(c.pressed)keys.add(c.key.toLowerCase().replace(/^key/,''));else keys.delete(c.key.toLowerCase().replace(/^key/,''));break;}pushUI();}
window.addEventListener('game:command',handleCommand);
window.addEventListener('keydown',e=>{if(e.defaultPrevented||e.target.matches('input,textarea,select')||e.target.closest('dialog[open]'))return;const k=e.key.toLowerCase();if([' ','arrowup','arrowdown','arrowleft','arrowright','shift','q','e','r','w','a','s','d'].includes(k))e.preventDefault();keys.add(k);if(e.repeat)return;if(k===' ')shoot();if(k==='e')interact();if(k==='q')recall();if(k==='r')ultimate();if(k==='shift'&&state.mode==='surface')dash();});
window.addEventListener('keyup',e=>keys.delete(e.key.toLowerCase()));
canvas.addEventListener('pointerdown',e=>{
  if(isInputBlocked())return;canvas.focus({preventScroll:true});dragging=true;lastPointer={x:e.clientX,y:e.clientY};
  if(e.pointerType==='mouse'){
    if(e.button===0){fireHeld=true;shoot();}
    if(state.mode==='surface'&&document.pointerLockElement!==canvas){try{const result=canvas.requestPointerLock();result?.catch?.(()=>toast('Drag to aim; this browser could not capture the mouse.'));}catch{}}
  }else canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove',e=>{if(document.pointerLockElement===canvas||!dragging||isInputBlocked())return;const dx=e.clientX-lastPointer.x,dy=e.clientY-lastPointer.y;lastPointer={x:e.clientX,y:e.clientY};rotateView(dx,dy);});
document.addEventListener('mousemove',e=>{if(document.pointerLockElement!==canvas||isInputBlocked())return;if(!lastPointer){lastPointer={x:e.clientX,y:e.clientY};return;}const dx=e.movementX||(e.clientX-lastPointer.x),dy=e.movementY||(e.clientY-lastPointer.y);lastPointer={x:e.clientX,y:e.clientY};rotateView(clamp(dx,-150,150),clamp(dy,-150,150));});
document.addEventListener('pointerlockchange',()=>{state.pointerLocked=document.pointerLockElement===canvas;lastPointer=null;if(!state.pointerLocked)resetControls();});
document.addEventListener('mouseup',()=>{fireHeld=false;dragging=false;});
function releasePointer(){dragging=false;fireHeld=false;lastPointer=null;}
canvas.addEventListener('pointerup',releasePointer);canvas.addEventListener('pointercancel',releasePointer);canvas.addEventListener('contextmenu',e=>e.preventDefault());
window.addEventListener('blur',()=>{blurred=true;resetControls();});window.addEventListener('focus',()=>{blurred=false;});document.addEventListener('visibilitychange',()=>{blurred=document.hidden;resetControls();});
window.addEventListener('resize',updateViewport);

function updateSpace(dt){
  const turning=(keys.has('a')||keys.has('arrowleft')?1:0)-(keys.has('d')||keys.has('arrowright')?1:0);yaw+=turning*dt*1.25;
  pitch=clamp(pitch+((keys.has('arrowup')?1:0)-(keys.has('arrowdown')?1:0))*dt*.7,-1.1,1.1);
  const thrust=(keys.has('w')?1:0)-(keys.has('s')?1:0);const boost=keys.has('shift');const target=thrust*(boost?170:68);spaceSpeed=THREE.MathUtils.damp(spaceSpeed,target,thrust?1.6:1.1,dt);direction();player.addScaledVector(forward,spaceSpeed*dt);
  let nearest=null,dist=Infinity;for(const p of PLANETS){tmp.set(...p.position);let d=player.distanceTo(tmp)-p.radius;if(d<22){const normal=player.clone().sub(tmp).normalize();player.copy(tmp).addScaledVector(normal,p.radius+22);spaceSpeed=Math.max(0,spaceSpeed)*.3;d=22;}if(d<dist){dist=d;nearest=p;}}
  state.nearPlanet=nearest.id;state.nearestDistance=Math.round(dist);state.canLand=dist<110;state.targetPlanet={id:nearest.id,distance:Math.round(dist),behind:new THREE.Vector3(...nearest.position).sub(player).dot(forward)<0};state.speed=Math.abs(spaceSpeed);
  if(player.length()>1900){player.multiplyScalar(.98);spaceSpeed=-15;toast('Outer boundary reached. Turn toward the system, or warp with M.');}
  ship.position.copy(player);ship.rotation.set(pitch,yaw,THREE.MathUtils.damp(ship.rotation.z,turning*.28,5,dt),'YXZ');
  const behind=new THREE.Vector3(Math.sin(yaw)*34,12,-(-Math.cos(yaw)*34));behind.y+=-Math.sin(pitch)*22;
  const targetPos=player.clone().add(behind);camera.position.lerp(targetPos,1-Math.exp(-dt*4));camera.lookAt(player.clone().addScaledVector(forward,20).add(new THREE.Vector3(0,2,0)));camera.fov=THREE.MathUtils.damp(camera.fov,boost&&thrust?68:56,3,dt);camera.updateProjectionMatrix();
  if(boost&&Math.abs(spaceSpeed)>70&&frameCount%3===0&&!reducedMotion)addEffect(player.clone().addScaledVector(forward,-9),0x8fedff,1,2);
  if(ship.userData.thrusters)for(const t of ship.userData.thrusters){t.scale.y=1+Math.abs(spaceSpeed)/60;}
}
function updateSurface(dt){
  const turn=(keys.has('arrowleft')?1:0)-(keys.has('arrowright')?1:0);footYaw+=turn*dt*1.8;
  footPitch=clamp(footPitch+((keys.has('arrowdown')?1:0)-(keys.has('arrowup')?1:0))*dt*.5,-.5,.6);
  const f=(keys.has('w')?1:0)-(keys.has('s')?1:0),s=(keys.has('d')?1:0)-(keys.has('a')?1:0);footDirection();right.set(Math.cos(footYaw),0,-Math.sin(footYaw));
  const move=new THREE.Vector3().addScaledVector(forward,f).addScaledVector(right,s);if(move.lengthSq()>0)move.normalize();if(dashTimer>0&&move.lengthSq()===0)move.copy(forward);const displacement=move.clone().multiplyScalar((dashTimer>0?72:9)*dt);player.copy(surface.resolveMovement(player,displacement,.6));state.speed=move.lengthSq()>0?9:0;
  astronaut.position.copy(player);astronaut.rotation.y=footYaw;
  if(astronaut.userData.limbs){const legs=[astronaut.userData.limbs.leftLeg,astronaut.userData.limbs.rightLeg];for(let i=0;i<legs.length;i++)legs[i].rotation.x=move.lengthSq()>0?Math.sin(time*11+i*Math.PI)*.45:0;}
  const cameraOffset=new THREE.Vector3(Math.sin(footYaw)*9,4.5+footPitch*7,Math.cos(footYaw)*9);const camTarget=player.clone().add(cameraOffset);camTarget.y=Math.max(camTarget.y,surface.heightAt(camTarget.x,camTarget.z)+2.3);camera.position.lerp(camTarget,1-Math.exp(-dt*9));camera.lookAt(player.clone().addScaledVector(forward,10).add(new THREE.Vector3(0,1.4-footPitch*5,0)));camera.fov=THREE.MathUtils.damp(camera.fov,dashTimer>0&&!reducedMotion?68:58,5,dt);camera.updateProjectionMatrix();
  const beacon=new THREE.Vector3(...surface.beaconPosition);state.canInteract=player.distanceTo(beacon)<13;state.canEmbark=player.distanceTo(ship.position)<17;
  state.nearestDistance=Math.round(player.distanceTo(beacon));state.targetPlanet=null;
  for(const e of enemies){const to=player.clone().sub(e.mesh.position);to.y=0;const distance=to.length();to.normalize();if(distance>5)e.mesh.position.addScaledVector(to,e.speed*dt);e.mesh.position.y=surface.heightAt(e.mesh.position.x,e.mesh.position.z)+1.8+Math.sin(time*2+e.phase)*.45;e.mesh.lookAt(player.x,e.mesh.position.y,player.z);e.mesh.rotation.z=Math.sin(time*2+e.phase)*.08;e.shoot-=dt;if(e.shoot<=0&&distance<70){e.shoot=2.4+Math.random()*2;const origin=e.mesh.position.clone();spawnBolt(origin,player.clone().add(new THREE.Vector3(0,1.2,0)).sub(origin).normalize(),true,14+state.wave*2);}if(distance<2.2)damagePlayer(dt*18);}
  if(enemies.length===0){waveTimer-=dt;if(waveTimer<=0){state.wave++;spawnWave();waveTimer=5;toast(`ANOMALY WAVE ${state.wave} · Weapon ${state.weaponName}`);}}
  if(anchor){anchor.life-=dt;anchorMesh.rotation.y+=dt;anchorMesh.material.opacity=.4+Math.sin(time*8)*.2;if(anchor.life<=0){scene.remove(anchorMesh);anchorMesh.material.dispose();anchorMesh.geometry.dispose();anchorMesh=null;anchor=null;state.recallActive=false;state.recallCooldown=6;toast('Anchor faded. Recall recharging.');}}
}
function updateProjectiles(dt){
  for(let i=projectiles.length-1;i>=0;i--){const p=projectiles[i],old=p.mesh.position.clone();p.mesh.position.addScaledVector(p.velocity,dt);p.life-=dt;let hit=false;
    if(p.enemy){const center=player.clone().add(new THREE.Vector3(0,1.2,0));if(hitSegmentSphere(old,p.mesh.position,center,1)){damagePlayer(p.damage);hit=true;}}
    else if(state.mode==='surface'){
      for(const e of [...enemies])if(hitSegmentSphere(old,p.mesh.position,e.mesh.position,1.6)){e.hp-=p.damage;addEffect(p.mesh.position,0xf4b78b,4,3);if(e.hp<=0)killEnemy(e);hit=true;break;}
      if(!hit)for(const prop of [...props])if(hitSegmentSphere(old,p.mesh.position,prop.mesh.position,prop.radius)){prop.hp-=p.damage;if(prop.hp<=0)destroyProp(prop);hit=true;break;}
    }
    if(p.life<=0||hit){scene.remove(p.mesh);projectiles.splice(i,1);}
  }
}
function updateEffects(dt){for(let i=effects.length-1;i>=0;i--){const e=effects[i];e.life-=dt;if(e.ring){e.mesh.scale.setScalar(1+(1-e.life/e.max)*e.size);e.mesh.material.opacity=Math.max(0,e.life/e.max);}else{e.mesh.position.addScaledVector(e.velocity,dt);e.velocity.multiplyScalar(Math.exp(-dt*1.5));e.mesh.rotation.x+=dt*4;e.mesh.scale.multiplyScalar(Math.exp(-dt*2));}if(e.life<=0){scene.remove(e.mesh);if(e.ownMaterial)e.mesh.material.dispose();effects.splice(i,1);}}}
function pushUI(){canvas.dataset.position=JSON.stringify({x:+player.x.toFixed(2),y:+player.y.toFixed(2),z:+player.z.toFixed(2)});canvas.dataset.heading=String(state.mode==='surface'?footYaw:yaw);state.paused=overlay||blurred;state.position={x:player.x,z:player.z};state.recallActive=!!anchor;state.recallRemaining=anchor?Math.ceil(anchor.life):0;state.weaponName=weaponForXP(state.xp).name;state.level=levelForXP(state.xp);ui.update({...state});canvas.setAttribute('aria-label',state.mode==='space'?'3D spaceflight through Maxwell Calkin’s portfolio':`Exploring ${getPlanet(state.planetId).name}. ${enemies.length} anomalies remaining.`);}
function frame(){animation=requestAnimationFrame(frame);const dt=Math.min(clock.getDelta(),.04);frameCount++;time+=dt;
  if(!state.started){space.update(time,dt);ship.scale.setScalar(innerWidth<600?.76:1);ship.position.set((innerWidth<600?-1:2)+Math.sin(time*.27)*2,(innerWidth<600?12:8)+Math.sin(time*.65)*.4,120);ship.rotation.set(.04,Math.sin(time*.14)*.08,Math.sin(time*.25)*.035);camera.position.set(5+Math.sin(time*.09)*2,21,162);camera.lookAt(-34,22,-110);}
  else if(!isInputBlocked()){runDuration+=dt;shotTimer=Math.max(0,shotTimer-dt);state.dashCooldown=Math.max(0,state.dashCooldown-dt);state.recallCooldown=Math.max(0,state.recallCooldown-dt);dashTimer=Math.max(0,dashTimer-dt);invincible=Math.max(0,invincible-dt);damageTimer+=dt;if(damageTimer>6)state.shield=Math.min(100,state.shield+dt*12);
    if(state.mode==='space'){space.update(time,dt);updateSpace(dt);}else{surface.update(time,dt);updateSurface(dt);}if(fireHeld||keys.has(' '))shoot();updateProjectiles(dt);updateEffects(dt);updateUltimate(dt);sound.update(state.speed);
  }
  transition=Math.max(0,transition-dt);if(!reducedMotion&&invincible>0&&state.mode==='surface')astronaut.visible=Math.floor(time*18)%2===0||dashTimer>0;else astronaut.visible=state.mode==='surface';
  for(const {p,button} of planetLabels){if(!state.started||state.mode!=='space'||overlay){button.hidden=true;continue;}const pos=new THREE.Vector3(...p.position);pos.y+=p.radius+9;pos.project(camera);const visible=pos.z<1&&pos.z>-1&&Math.abs(pos.x)<.87&&Math.abs(pos.y)<.76;button.hidden=!visible;if(visible){button.style.left=`${(pos.x*.5+.5)*innerWidth}px`;button.style.top=`${(-pos.y*.5+.5)*innerHeight}px`;}}
  renderer.render(scene,camera);uiTick+=dt;if(uiTick>.09){uiTick=0;pushUI();}
}
try{
  renderer=new THREE.WebGLRenderer({canvas,antialias:true,alpha:false,powerPreference:'high-performance'});renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.2;
  renderer.shadowMap.enabled=false;updateViewport();space=createSpaceWorld(scene);ship=createShip();astronaut=createAstronaut();scene.add(ship,astronaut);enterSpace(true);ui.setReady();pushUI();frame();connectLeaderboard();if(location.hash==='#long-form')ui.openPanel('philosophy');
  canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();cancelAnimationFrame(animation);ui.setError('The 3D view was interrupted. Reload to resume, or read the portfolio.');});
}catch(error){console.error('Unable to start 3D portfolio',error);ui.setError('This browser could not start the 3D world. The complete reading version is available.');}
