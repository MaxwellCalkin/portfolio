import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/** Original parametric xenofauna. No downloaded models or game-derived assets.
 * Meshes face -Z and are centred at y=0. Animate through userData.update(time, dt).
 * userData.groundOffset is the neutral-pose distance from origin to the feet.
 */
const TAU = Math.PI * 2;
const PALETTES = [
  { dark: '#142e32', shell: '#40666b', plate: '#91b5a8', trim: '#bcc4ae', glow: '#7df9d2', crystal: '#77cfce' },
  { dark: '#221b33', shell: '#484063', plate: '#a195c8', trim: '#ccb8da', glow: '#d9a3ff', crystal: '#a787dd' },
  { dark: '#2f2524', shell: '#66514a', plate: '#ba8f6b', trim: '#dfc5a0', glow: '#ffba63', crystal: '#df9467' },
];
const BOSS_PALETTES = {
  philosophy: { dark:'#102e2b', shell:'#2f645b', plate:'#83ac99', trim:'#dce5bd', glow:'#91ffd6', crystal:'#6cdbb5' },
  experience: { dark:'#321d22', shell:'#683d3b', plate:'#b77052', trim:'#ead0a0', glow:'#ff9a45', crystal:'#f5845a' },
  projects: { dark:'#251a3c', shell:'#543e79', plate:'#b49bcf', trim:'#edd0f2', glow:'#eaa1ff', crystal:'#af83f6' },
  mission: { dark:'#162c42', shell:'#3b6582', plate:'#99c7d7', trim:'#d1e8f3', glow:'#83e8ff', crystal:'#90d5f1' },
  contact: { dark:'#303023', shell:'#6d6848', plate:'#bcb17d', trim:'#ede1b4', glow:'#ffea93', crystal:'#d7c774' },
};
function materials(p) {
  const standard=(color,roughness,metalness,extra={})=>new THREE.MeshStandardMaterial({color,roughness,metalness,...extra});
  return {
    dark:standard(p.dark,.66,.27), shell:standard(p.shell,.43,.49), plate:standard(p.plate,.38,.46),
    trim:standard(p.trim,.32,.62), glow:standard(p.glow,.22,.25,{emissive:p.glow,emissiveIntensity:2.25}),
    crystal:standard(p.crystal,.2,.48,{emissive:p.glow,emissiveIntensity:.16,flatShading:true}),
    membrane:standard(p.shell,.55,.19,{side:THREE.DoubleSide}),
  };
}
function mesh(geo,mat,parent,position=[0,0,0]) {
  const m=new THREE.Mesh(geo,mat);m.position.fromArray(position);m.castShadow=true;m.receiveShadow=true;parent.add(m);return m;
}
function node(parent,position=[0,0,0]) {const g=new THREE.Group();g.position.fromArray(position);parent.add(g);return g;}
function orb(parent,mat,position,scale,segments=20) {
  const m=mesh(new THREE.SphereGeometry(1,segments,12),mat,parent,position);m.scale.fromArray(scale);return m;
}
/** A continuous ellipsoidal section sculpt rather than stacked primitive volumes. */
function bodyGeometry(profiles,sides=24,facets=0) {
  const positions=[],indices=[];
  for(let j=0;j<profiles.length;j++) {
    const [z,w,h,y=0]=profiles[j];
    for(let i=0;i<=sides;i++) {
      const a=i/sides*TAU,flute=1+Math.cos(a*6)*facets;
      positions.push(Math.cos(a)*w*flute,Math.sin(a)*h*flute+y,z);
    }
  }
  for(let j=0;j<profiles.length-1;j++)for(let i=0;i<sides;i++){const a=j*(sides+1)+i,b=a+sides+1;indices.push(a,a+1,b+1,a,b+1,b);}
  for(let i=1;i<sides-1;i++){indices.push(0,i+1,i);const a=(profiles.length-1)*(sides+1);indices.push(a,a+i,a+i+1);}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setIndex(indices);g.computeVertexNormals();return g;
}
/** Variable-radius swept horns, talons and living tendons, with smooth Frenet frames. */
function tendril(parent,mat,points,radii,segments=22,sides=8) {
  const curve=new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(...p))),frame=curve.computeFrenetFrames(segments,false),positions=[],indices=[];
  for(let j=0;j<=segments;j++) {
    const t=j/segments,rIndex=t*(radii.length-1),k=Math.min(radii.length-2,Math.floor(rIndex)),r=THREE.MathUtils.lerp(radii[k],radii[k+1],rIndex-k),p=curve.getPointAt(t);
    for(let i=0;i<=sides;i++){const a=i/sides*TAU;const v=p.clone().addScaledVector(frame.normals[j],Math.cos(a)*r).addScaledVector(frame.binormals[j],Math.sin(a)*r);positions.push(v.x,v.y,v.z);}
  }
  for(let j=0;j<segments;j++)for(let i=0;i<sides;i++){const a=j*(sides+1)+i,b=a+sides+1;indices.push(a,a+1,b,a+1,b+1,b);}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setIndex(indices);g.computeVertexNormals();return mesh(g,mat,parent);
}
function crystal(parent,mat,position,height=.7,width=.14,lean=[0,0,0]) {
  // Unequal hexagonal facets taper to an off-axis tip, like naturally grown mineral.
  const geo=bodyGeometry([[-height*.5,.001,.001,0],[-height*.33,width*.7,width*.7,0],[height*.23,width,width,0],[height*.48,width*.54,width*.54,width*.13],[height*.6,.002,.002,width*.35]],6);
  geo.rotateX(-Math.PI/2);const m=mesh(geo,mat,parent,position);m.rotation.set(...lean);return m;
}
function wingGeometry(points,thickness=.035) {
  const shape=new THREE.Shape();shape.moveTo(...points[0]);
  for(let i=1;i<points.length;i+=3){if(points[i+2])shape.bezierCurveTo(...points[i],...points[i+1],...points[i+2]);else shape.lineTo(...points[i]);}
  shape.closePath();const g=new THREE.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:true,bevelSegments:2,bevelSize:.035,bevelThickness:.025,curveSegments:14,steps:1});g.rotateX(Math.PI/2);return g;
}
function eye(parent,m,x,y,z,s=.095) {
  const socket=orb(parent,m.dark,[x,y,z],[s*1.65,s*.93,s*.6]);
  const lens=orb(parent,m.glow,[x,y,z-.034],[s,s*.49,s*.5]);lens.name='luminous-eye';return {socket,lens};
}
function segmentedTail(parent,m,length=2,segments=6) {
  let prev=parent;const joints=[];
  for(let i=0;i<segments;i++){
    const t=1-i/segments,g=node(prev,[0,-.025,i?length/segments:0]);
    mesh(bodyGeometry([[-.1,.21*t,.17*t,0],[.12,.23*t,.19*t,0],[length/segments+.02,.13*t,.11*t,0]],12),i%2?m.shell:m.plate,g);
    if(i<segments-1)orb(g,m.glow,[0,.17*t,.12],[.033*t,.022*t,.095]);
    joints.push(g);prev=g;
  }
  tendril(prev,m.trim,[[0,0,0],[0,.06,.3],[0,.13,.52]],[.08,.065,0],10,8);
  return joints;
}
function stalker(m,{royal=false}={}) {
  const root=new THREE.Group(),body=node(root,[0,.34,0]),legs=[],feelers=[];
  root.name='veridian-crystal-stalker';
  mesh(bodyGeometry([[-1.13,.02,.04,.04],[-.93,.36,.28,.09],[-.45,.63,.4,.04],[.1,.63,.43,0],[.7,.43,.29,-.04],[1.16,.08,.09,-.07]],24,.035),m.dark,body);
  // Interlocking dorsal carapace, each piece overhangs the next with a raised ridge.
  for(let i=0;i<5;i++) {
    const z=-.62+i*.35,w=.54-Math.abs(i-1.4)*.068;
    const p=mesh(bodyGeometry([[-.24,w*.76,.14,0],[-.16,w,.24,.03],[.08,w*.95,.18,.03],[.25,w*.66,.03,0]],16,.035),i%2?m.shell:m.plate,body,[0,.32,z]);p.rotation.x=.09;
    const gem=crystal(body,m.crystal,[0,.61,z],.39+(4-i)*.045,.13,[-.25,0,0]);
    tendril(body,m.glow,[[-w*.73,.39,z-.1],[0,.58,z-.17],[w*.73,.39,z-.1]],[.014,.021,.014],12,5);
  }
  const head=node(body,[0,.06,-1.03]);
  mesh(bodyGeometry([[-.46,.03,.05,0],[-.3,.32,.24,.035],[0,.44,.33,.11],[.4,.3,.2,0]],20,.02),m.shell,head);
  for(const s of [-1,1]) {
    const brow=orb(head,m.plate,[s*.26,.2,-.19],[.25,.145,.25]);brow.rotation.z=s*-.32;
    eye(head,m,s*.255,.1,-.402,.12);eye(head,m,s*.365,.19,-.255,.047);
    tendril(head,m.trim,[[s*.30,-.1,-.21],[s*.46,-.28,-.58],[s*.27,-.3,-.79],[s*.17,-.21,-.77]],[.09,.085,.04,0],20,9);
    const antenna=node(head,[s*.24,.3,-.14]);tendril(antenna,m.dark,[[0,0,0],[s*.19,.34,-.17],[s*.40,.48,-.42],[s*.55,.42,-.65]],[.035,.025,.015,0],20,6);orb(antenna,m.glow,[s*.49,.45,-.56],[.028,.035,.038],12);feelers.push(antenna);
    for(let i=0;i<3;i++){
      const z=-.63+i*.68,leg=node(body,[s*.46,-.12,z]);
      const reach=i===1?1.08:.92,forward=(i-1)*.28;
      tendril(leg,m.dark,[[0,0,0],[s*.42,.10,forward],[s*reach,-.25,forward+.1],[s*(reach-.10),-.94,forward+.21]],[.135,.12,.075,.032],20,8);
      tendril(leg,m.plate,[[s*.12,.025,forward*.3],[s*.46,.16,forward],[s*(reach-.08),-.19,forward+.08]],[.155,.12,.05],14,8);
      orb(leg,m.trim,[s*reach,-.25,forward+.1],[.09,.085,.09],12);
      tendril(leg,m.trim,[[s*(reach-.1),-.8,forward+.2],[s*(reach-.14),-.98,forward+.23],[s*(reach-.36),-.99,forward+.1]],[.047,.045,0],12,6);
      legs.push({g:leg,phase:i*Math.PI*.8+(s<0?Math.PI:0),s});
    }
  }
  const tail=segmentedTail(node(body,[0,-.09,1.0]),m,1.15,4);
  if(royal) {
    for(const s of [-1,1])for(let i=0;i<3;i++){
      tendril(body,m.plate,[[s*(.25+i*.1),.5,-.6+i*.44],[s*(.77+i*.10),.96,-.54+i*.43],[s*(.67+i*.08),1.5-i*.16,-.89+i*.48]],[.15,.1,0],22,10);
    }
  }
  return {root,body,animate(t){body.position.y=.34+Math.sin(t*2.7)*.035;for(const l of legs){l.g.rotation.x=Math.sin(t*4.1+l.phase)*.18;l.g.rotation.z=Math.cos(t*4.1+l.phase)*.055*l.s;}tail.forEach((g,i)=>g.rotation.y=Math.sin(t*2.2-i*.8)*.14);feelers.forEach((g,i)=>g.rotation.z=Math.sin(t*2+i*2)*.12);}};
}
function ray(m,{doubleWings=false}={}) {
  const root=new THREE.Group(),body=node(root,[0,.1,0]),wings=[],tailRoots=[];root.name='vesper-silk-ray';
  mesh(bodyGeometry([[-1.61,.015,.045,0],[-1.15,.33,.23,.02],[-.48,.55,.32,0],[.2,.48,.3,-.01],[.8,.24,.16,-.03],[1.3,.025,.045,-.02]],28),m.shell,body);
  mesh(bodyGeometry([[-1.12,.02,.02,.01],[-.55,.27,.17,.07],[0,.24,.19,0],[.75,.09,.04,0]],18),m.plate,body,[0,.23,0]);
  const points=[[.22,-.68],[.93,-1.05],[1.32,-1.56],[2.42,-1.05],[2.01,-.8],[2.1,-.06],[2.48,.37],[1.94,.25],[1.58,.56],[1.04,.93],[1.10,.44],[.55,.50],[.2,.74]];
  for(const s of [-1,1]){
    const wing=node(body);wing.scale.x=s;
    mesh(wingGeometry(points,.025),m.membrane,wing,[0,-.02,0]);
    // Structural rays are curved and embedded; a scalloped membrane reads as an animal.
    const ribs=[[[.28,0,-.56],[1.15,.06,-1.03],[2.42,0,-1.05]],[[.36,0,-.36],[1.24,.03,-.47],[2.43,0,.35]],[[.35,0,-.18],[.93,.05,.17],[1.04,0,.90]]];
    for(const r of ribs)tendril(wing,m.plate,r,[.09,.055,.003],24,8);
    tendril(wing,m.glow,[[.43,.048,-.49],[1.12,.075,-.9],[2.21,.05,-1.08]],[.011,.02,.002],28,5);
    for(let i=0;i<5;i++){
      const a=i*.19,x=.63+i*.23;
      tendril(wing,m.trim,[[x,.042,-.44-a*.13],[x+.09,.046,-.17+a*.30],[x+.08,.032,.01+a*.31]],[.012,.016,.008],10,5);
      orb(wing,m.glow,[x+.02,.06,-.27],[.045,.022,.022],12);
    }
    wings.push({g:wing,s,phase:0});
    if(doubleWings){const rear=wing.clone();rear.position.set(0,-.14,.68);rear.scale.multiplyScalar(.75);body.add(rear);wings.push({g:rear,s,phase:1.8});}
    eye(body,m,s*.25,.08,-1.21,.1);
    tendril(body,m.trim,[[s*.18,-.05,-1.18],[s*.41,-.15,-1.51],[s*.32,.04,-1.92]],[.1,.07,0],24,8);
    const tail=node(body,[s*.14,-.06,1.03]);
    tendril(tail,m.shell,[[0,0,0],[s*.18,-.14,.9],[s*.40,.15,1.75],[s*.67,.40,2.25]],[.105,.078,.035,0],36,8);
    tendril(tail,m.glow,[[s*.025,.025,.1],[s*.20,-.1,.88],[s*.4,.17,1.74]],[.018,.013,0],28,5);tailRoots.push(tail);
  }
  // Sail rising along the back, sculpted from a swept leaf rather than a cone.
  const sail=mesh(wingGeometry([[0,-.7],[.48,-.13],[1.32,.45],[.48,.84],[.24,.47],[0,.35],[0,-.7]],.025),m.plate,body);sail.rotation.z=Math.PI/2;sail.position.y=.25;sail.position.z=.13;
  const pearl=orb(body,m.glow,[0,-.15,-.85],[.11,.12,.08]);pearl.userData.weakspot=true;
  return {root,body,animate(t){body.position.y=.1+Math.sin(t*2)*.11;body.rotation.x=Math.sin(t*1.6)*.045;wings.forEach(w=>{w.g.rotation.z=w.s*(.12+Math.sin(t*2.5+w.phase)*.24);w.g.rotation.x=Math.sin(t*2.5+w.phase)*.075;});tailRoots.forEach((g,i)=>{g.rotation.y=Math.sin(t*1.8+i)*.16;g.rotation.x=Math.cos(t*2.1+i)*.1;});}};
}
function quadruped(m,{heavy=false}={}) {
  const root=new THREE.Group(),body=node(root,[0,.37,0]),legs=[],tails=[];root.name='ember-plated-grazer';
  mesh(bodyGeometry([[-1.35,.12,.16,0],[-.97,.57,.49,.03],[-.42,.74,.58,.08],[.4,.73,.55,.04],[1.1,.46,.39,-.05],[1.38,.04,.06,-.06]],26,.018),m.dark,body);
  for(let i=0;i<4;i++){
    const z=-.65+i*.46,w=.61-(i===3?.16:0),plate=mesh(bodyGeometry([[-.28,w*.82,.34,0],[-.16,w,.47,0],[.13,w*.95,.39,.01],[.29,w*.81,.23,-.02]],22,.025),i%2?m.plate:m.shell,body,[0,.2,z]);plate.rotation.x=.04;
    tendril(body,m.glow,[[-w*.72,.39,z-.15],[-.25,.67,z-.2],[.25,.67,z-.2],[w*.72,.39,z-.15]],[.012,.02,.02,.012],22,5);
    for(const s of [-1,1]){
      crystal(body,m.crystal,[s*w*.70,.54,z],.30+(3-i)*.05,.12,[s*.2,0,s*-.43]);
      // Layered scale skirts overlap along both flanks.
      const flank=orb(body,m.plate,[s*(w*.86),.19,z+.06],[.18,.28,.32]);flank.rotation.z=-s*.4;
    }
  }
  const head=node(body,[0,-.09,-1.12]);
  mesh(bodyGeometry([[-.92,.05,.08,-.07],[-.69,.36,.23,-.03],[-.31,.43,.37,.09],[.15,.41,.32,.1],[.33,.13,.11,.02]],24,.018),m.shell,head);
  mesh(bodyGeometry([[-.82,.22,.11,0],[-.38,.4,.21,0],[.13,.29,.16,.05]],16),m.plate,head,[0,.24,-.02]);
  tendril(head,m.trim,[[0,.35,-.39],[0,.62,-.64],[0,.88,-.91],[0,.91,-1.11]],[.18,.145,.075,0],28,12);
  orb(head,m.dark,[0,-.14,-.77],[.24,.11,.15]);
  for(const s of [-1,1]){
    eye(head,m,s*.345,.08,-.47,.085);
    tendril(head,m.trim,[[s*.34,-.1,-.46],[s*.54,-.23,-.79],[s*.52,.03,-1.00]],[.12,.085,0],24,9);
    for(let i=0;i<2;i++){
      const z=i?.84:-.71,g=node(body,[s*.53,-.24,z]);
      tendril(g,m.dark,[[0,0,0],[s*.20,-.4,.11],[s*.28,-.93,-.02]],[.23,.17,.115],20,12);
      const shoulder=orb(g,m.plate,[s*.1,-.1,0],[.285,.33,.3]);shoulder.rotation.z=s*-.2;
      tendril(g,m.shell,[[s*.17,-.34,.10],[s*.27,-.71,.07],[s*.26,-.89,-.07]],[.185,.16,.12],16,10);
      const foot=orb(g,m.dark,[s*.29,-.98,-.15],[.19,.11,.30]);
      for(let c=0;c<3;c++)tendril(g,m.trim,[[s*.29+(c-1)*.12,-.96,-.28],[s*.29+(c-1)*.12,-1.03,-.43],[s*.29+(c-1)*.13,-1.02,-.49]],[.055,.04,0],9,6);
      legs.push({g,phase:i*Math.PI+(s<0?Math.PI:0)});
    }
    if(heavy)tendril(body,m.trim,[[s*.53,.53,-.57],[s*.94,.90,-.44],[s*1.22,1.05,-.8],[s*.98,1.3,-1.1]],[.22,.17,.09,0],30,12);
  }
  const tail=segmentedTail(node(body,[0,-.02,1.18]),m,1.65,5);tails.push(...tail);
  return {root,body,animate(t){body.position.y=.37+Math.sin(t*3.7)*.035;legs.forEach(l=>{l.g.rotation.x=Math.sin(t*3.7+l.phase)*.20;});tails.forEach((g,i)=>g.rotation.y=Math.sin(t*2-i*.55)*.13);head.rotation.y=Math.sin(t*.9)*.055;}};
}
function crown(parent,m,kind='halo') {
  const pivot=node(parent,[0,1.13,-.25]),parts=[];
  if(kind==='halo') {
    const ring=mesh(new THREE.TorusGeometry(.86,.036,8,72,Math.PI*1.77),m.trim,pivot);ring.rotation.z=.36;ring.userData.animated=true;
    const inner=mesh(new THREE.TorusGeometry(.73,.014,6,64,Math.PI*1.52),m.glow,pivot);inner.rotation.z=-.22;inner.userData.animated=true;
    for(let i=0;i<7;i++){const a=(i/6)*Math.PI;const g=crystal(pivot,m.crystal,[Math.cos(a)*.87,Math.sin(a)*.87,0],.31,.09,[0,0,a-Math.PI/2]);parts.push(g);}
    return {pivot,animate(t){inner.rotation.z=-.22+t*.12;ring.rotation.z=.36-t*.065;}};
  }
  for(let i=0;i<9;i++){const a=i/9*TAU;const g=node(pivot,[Math.cos(a)*.78,Math.sin(a)*.78,0]);tendril(g,m.plate,[[0,0,0],[Math.cos(a)*.24,Math.sin(a)*.24,.03],[Math.cos(a)*.48,Math.sin(a)*.48,-.12]],[.075,.05,0],15,8);orb(g,m.glow,[0,0,-.03],[.055,.055,.03]);parts.push(g);}
  return {pivot,animate(t){pivot.rotation.z=Math.sin(t*.3)*.09;}};
}
/** Collapse static sibling surfaces by material while preserving every animated joint. */
function batchStaticSurfaces(root) {
  const old=new Set();
  function visit(parent){
    for(const child of [...parent.children])if(child.isGroup)visit(child);
    const batches=new Map();
    for(const child of parent.children){
      if(!child.isMesh||child.children.length||child.userData.animated||child.userData.weakspot)continue;
      if(!batches.has(child.material))batches.set(child.material,[]);batches.get(child.material).push(child);
    }
    for(const [material,parts] of batches){
      if(parts.length<2)continue;
      const geometries=parts.map(part=>{
        part.updateMatrix();const geo=part.geometry.index?part.geometry.toNonIndexed():part.geometry.clone();geo.applyMatrix4(part.matrix);geo.deleteAttribute('uv');geo.clearGroups();return geo;
      });
      const geo=mergeGeometries(geometries,false);geometries.forEach(g=>g.dispose());
      if(!geo)continue;
      const merged=mesh(geo,material,parent);merged.name='sculpted-surface-batch';
      parts.forEach(part=>{parent.remove(part);old.add(part.geometry);});
    }
  }
  visit(root);const retained=new Set();root.traverse(o=>{if(o.geometry)retained.add(o.geometry);});old.forEach(g=>{if(!retained.has(g))g.dispose();});
}
function finish(model,m,height,label) {
  batchStaticSurfaces(model.root);
  const root=new THREE.Group();root.name=label;root.add(model.root);model.root.updateMatrixWorld(true);
  const bounds=new THREE.Box3().setFromObject(model.root),size=bounds.getSize(new THREE.Vector3()),center=bounds.getCenter(new THREE.Vector3());
  const scale=height/size.y;model.root.position.sub(center);model.root.scale.setScalar(scale);model.root.position.multiplyScalar(scale);
  root.userData.kind=label;root.userData.height=height;root.userData.groundOffset=height*.5;
  root.userData.radius=Math.max(size.x,size.z)*scale*.5;root.userData.body=model.body;root.userData.weakspots=[];
  root.traverse(o=>{if(o.userData.weakspot)root.userData.weakspots.push(o);});
  root.userData.materials=Object.values(m);root.userData.update=(time,dt)=>model.animate(time,dt);
  let disposed=false;
  root.userData.dispose=()=>{
    if(disposed)return;disposed=true;root.removeFromParent();
    const geometries=new Set(),mats=new Set(Object.values(m));root.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(v=>mats.add(v));});
    geometries.forEach(g=>g.dispose());mats.forEach(v=>v.dispose());
  };
  return root;
}
export function createCreature(type=0) {
  const index=((Math.floor(Number(type)||0)%3)+3)%3,m=materials(PALETTES[index]);
  const model=index===0?stalker(m):index===1?ray(m):quadruped(m);
  const creature=finish(model,m,index===1?2.1:2.3,['crystal-stalker','vesper-ray','armored-grazer'][index]);creature.userData.isFlying=index===1;return creature;
}
export function createBoss(planetId='philosophy') {
  const id=Object.hasOwn(BOSS_PALETTES,planetId)?planetId:'philosophy',m=materials(BOSS_PALETTES[id]);
  let model,ornament,height=6.3,name;
  if(id==='philosophy') {model=stalker(m,{royal:true});ornament=crown(model.body,m);name='The Verdant Oracle';height=6.6;}
  if(id==='experience') {model=quadruped(m,{heavy:true});name='The Cinder Colossus';height=6.8;
    for(let i=0;i<4;i++)crystal(model.body,m.crystal,[0,1.0,-.45+i*.44],.85-i*.10,.20,[-.22,0,.09*(i%2?1:-1)]);
  }
  if(id==='projects') {model=ray(m,{doubleWings:true});name='The Dreamweaver';height=6.2;ornament=crown(model.body,m);
    for(const s of [-1,1])tendril(model.body,m.crystal,[[s*.45,.28,-.1],[s*.73,.8,-.3],[s*.64,1.35,-.64]],[.12,.085,0],22,9);
  }
  if(id==='mission') {model=ray(m);name='The Horizon Leviathan';height=6.9;
    for(let i=0;i<5;i++)crystal(model.body,m.crystal,[0,.48,-.8+i*.4],.9-i*.1,.14,[-.35,0,0]);
    for(const s of [-1,1])tendril(model.body,m.trim,[[s*.26,.11,-1.11],[s*.65,.33,-1.49],[s*.95,.79,-1.29],[s*.88,1.12,-.97]],[.16,.12,.055,0],30,12);
  }
  if(id==='contact') {model=stalker(m);name='The Gilded Herald';height=6.1;ornament=crown(model.body,m,'solar');
    for(const s of [-1,1]){
      const mantle=mesh(wingGeometry([[.3,-.65],[.91,-.85],[1.64,-.4],[1.48,.72],[1.15,.61],[.61,.78],[.31,.47]],.08),m.plate,model.body,[0,.27,.18]);mantle.scale.x=s;mantle.rotation.z=s*.26;
      tendril(model.body,m.glow,[[s*.49,.36,-.45],[s*1.08,.64,-.04],[s*1.34,.52,.65]],[.02,.025,0],22,6);
    }
  }
  const original=model.animate;model.animate=(t,dt)=>{original(t*.69,dt);ornament?.animate(t);};
  const weak=orb(model.body,m.glow,[0,.23,-1.30],[.17,.21,.10]);weak.name='boss-heart';weak.userData.weakspot=true;
  const result=finish(model,m,height,name);result.userData.isBoss=true;result.userData.isFlying=id==='projects'||id==='mission';result.userData.planetId=id;result.userData.displayName=name;
  return result;
}
