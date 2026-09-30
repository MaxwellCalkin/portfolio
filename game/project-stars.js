import * as THREE from 'three';
import { SOLAR_SCALE } from './solar-scale.js';
import { withSolarDepth } from './solar-depth.js';
import { FontLoader } from 'three/addons/loaders/FontLoader.js';
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import sansData from './assets/beacn-typeface.json';
import serifData from './assets/heard-typeface.json';

/** Project identity sources, visually inspected 2026-09-30:
 * https://beacn.space/ — ivory/cyan circular outer ring, two separated inner arcs,
 * outlined lowercase beacn wordmark; indigo/lavender/blue/pink site palette.
 * Exact user-owned logo: https://beacn.space/images/logo-dark-mode-with-word-no-bg.png
 * https://heard-us.vercel.app/ — ivory serif Heard wordmark, navy/gold palette,
 * “Your Voice Matters”. Its orbital civic-signal sculpture is original artwork.
 * Three.js bundled Helvetiker and Droid typefaces retain their upstream licenses.
 */
export const PROJECT_LANDMARKS = Object.freeze({
  beacn: { id:'beacn', name:'BEACN', url:'https://beacn.space/', description:'Imagine the future together', position:[0,4200,-27000], radius:130*SOLAR_SCALE.landmarkScale },
  heardUs: { id:'heard-us', name:'Heard', url:'https://heard-us.vercel.app/', description:'Your Voice Matters', position:[4500,2100,-13500], radius:38*SOLAR_SCALE.landmarkScale },
});
const TAU=Math.PI*2;
const fonts={sans:new FontLoader().parse(sansData),serif:new FontLoader().parse(serifData)};
const beacnLogoUrl=new URL('./assets/beacn-logo.png',import.meta.url).href;
function mesh(geometry,material,parent,position=[0,0,0]){const m=new THREE.Mesh(geometry,material);m.position.fromArray(position);parent.add(m);return m;}
function surface(color,emissive=color,strength=.3){return new THREE.MeshStandardMaterial({color,metalness:.55,roughness:.29,emissive,emissiveIntensity:strength});}
function lightMaterial(color,opacity=1){return new THREE.MeshBasicMaterial({color,transparent:opacity<1,opacity,depthWrite:opacity>=1,toneMapped:false});}
function ring(parent,radius,tube,material,start=0,length=TAU){const m=mesh(new THREE.TorusGeometry(radius,tube,8,128,length),material,parent);m.rotation.z=start;return m;}
function textMesh(parent,text,size,font,material,position,outline=false){
  const depth=Math.max(.35,size*.045),geo=new TextGeometry(text,{font,size,depth,curveSegments:10,bevelEnabled:true,bevelThickness:size*.009,bevelSize:size*.009,bevelSegments:2});geo.computeBoundingBox();
  const cx=(geo.boundingBox.max.x+geo.boundingBox.min.x)*.5,cy=(geo.boundingBox.max.y+geo.boundingBox.min.y)*.5;geo.translate(-cx,-cy,0);
  const m=mesh(geo,material,parent,position);
  if(outline){
    const contours=[];
    for(const shape of font.generateShapes(text,size))for(const path of [shape,...shape.holes]){
      const points=path.getPoints(10),curve=new THREE.CurvePath();
      for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];if(a.distanceTo(b)<.0001)continue;curve.add(new THREE.LineCurve3(new THREE.Vector3(a.x-cx,a.y-cy,depth+.15),new THREE.Vector3(b.x-cx,b.y-cy,depth+.15)));}
      contours.push(new THREE.TubeGeometry(curve,Math.max(24,points.length*2),size*.011,6,true));
    }
    const outlineGeometry=mergeGeometries(contours,false);contours.forEach(g=>g.dispose());mesh(outlineGeometry,lightMaterial('#d4f7ef'),m);
  }
  return m;
}
function glow(parent,color,size,opacity=.6) {
  const c=document.createElement('canvas');c.width=c.height=128;const ctx=c.getContext('2d'),g=ctx.createRadialGradient(64,64,0,64,64,64);
  g.addColorStop(0,'rgba(255,255,255,1)');g.addColorStop(.1,'rgba(255,255,255,.58)');g.addColorStop(.3,'rgba(255,255,255,.2)');g.addColorStop(.65,'rgba(255,255,255,.03)');g.addColorStop(1,'rgba(255,255,255,0)');ctx.fillStyle=g;ctx.fillRect(0,0,128,128);
  const tex=new THREE.CanvasTexture(c),sprite=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,color,transparent:true,opacity,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false}));sprite.scale.set(size,size,1);parent.add(sprite);return sprite;
}
function label(parent,text,sub,color,width,position){
  const c=document.createElement('canvas');c.width=1024;c.height=160;const ctx=c.getContext('2d');ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.fillStyle=color;ctx.font='500 38px Arial, sans-serif';ctx.fillText(text,512,51);ctx.globalAlpha=.66;ctx.font='24px Arial, sans-serif';ctx.fillText(sub,512,112);
  const texture=new THREE.CanvasTexture(c);texture.colorSpace=THREE.SRGBColorSpace;
  const s=new THREE.Sprite(new THREE.SpriteMaterial({map:texture,transparent:true,depthWrite:false,toneMapped:false}));s.scale.set(width,width*160/1024,1);s.position.fromArray(position);parent.add(s);return s;
}
function plasmaMaterial(){return new THREE.ShaderMaterial(withSolarDepth({
  uniforms:{uTime:{value:0}},
  vertexShader:`varying vec3 vP,vN,vW;void main(){vP=position;vN=normalize(mat3(modelMatrix)*normal);vW=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
  fragmentShader:`uniform float uTime;varying vec3 vP,vN,vW;
  float noise(vec3 p){return sin(p.x*1.1+sin(p.y*1.8))*sin(p.y*.9+sin(p.z*1.4))*sin(p.z*1.2+sin(p.x*1.3));}
  void main(){vec3 p=normalize(vP);float n=noise(p*8.+vec3(0.,uTime*.075,uTime*.05));float fine=noise(p*25.+n*2.+uTime*.09);float vein=pow(max(0.,1.-abs(n+fine*.27)),11.);float rim=pow(1.-max(0.,dot(normalize(vN),normalize(cameraPosition-vW))),2.5);vec3 base=mix(vec3(.16,.09,.32),vec3(.50,.34,.7),n*.5+.5);base+=vec3(.7,.68,.42)*vein*.42;base=mix(base,vec3(.75,.87,.93),rim*.7);gl_FragColor=vec4(base,1.);}`,
}));}
function stellarDust(parent,radius,count,color){
  const data=new Float32Array(count*3);
  for(let i=0;i<count;i++){const a=i*2.399963229728653,y=1-2*(i+.5)/count,r=Math.sqrt(1-y*y),d=radius*(1+.10*Math.sin(i*17.731));data.set([Math.cos(a)*r*d,y*d,Math.sin(a)*r*d],i*3);}
  const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.BufferAttribute(data,3));return new THREE.Points(geo,new THREE.PointsMaterial({color,size:1.1*SOLAR_SCALE.landmarkScale,transparent:true,opacity:.5,depthWrite:false,blending:THREE.AdditiveBlending}));
}
function createBeacn(parent){
  const spec=PROJECT_LANDMARKS.beacn,group=new THREE.Group();group.name='BEACN — the collective-future sun';group.position.fromArray(spec.position);group.scale.setScalar(SOLAR_SCALE.landmarkScale);parent.add(group);
  group.userData.projectId='beacn';group.userData.url=spec.url;
  const ivory=surface('#d5f5e7','#b0e3e1',1.1),frame=surface('#586781','#476b85',.17),violet=surface('#a6a7e5','#ae8dea',.72);
  const sculpt=new THREE.Group();group.add(sculpt);sculpt.rotation.y=-.1;sculpt.rotation.x=.08;
  const plasma=plasmaMaterial(),core=mesh(new THREE.SphereGeometry(43,64,48),plasma,sculpt,[0,0,-17]);
  // The two concentric logo contours become a substantial, navigable 3D sculpture.
  const outer=ring(sculpt,105,2.8,ivory);ring(sculpt,105,4.7,frame).position.z=-3.2;
  const arcs=[];
  for(const start of [.24,Math.PI+.24]){const arc=ring(sculpt,74,2.8,ivory,start,Math.PI-.48);arc.position.z=3;arcs.push(arc);}
  const backRing=ring(sculpt,105,1.3,violet);backRing.rotation.y=Math.PI*.34;backRing.rotation.x=-.29;backRing.position.z=-8;
  const backRing2=ring(sculpt,104,1.2,surface('#b7aad5','#b28dcf',.48));backRing2.rotation.x=Math.PI*.39;backRing2.rotation.y=.36;backRing2.position.z=-8;
  // Hollow-looking front faces and luminous extruded contours echo the source lettering.
  const word=textMesh(sculpt,'beacn',36,fonts.sans,surface('#293146','#394766',.1),[0,-1,83],true);word.scale.x=1.04;
  const aura=glow(group,'#d4b9fa',445,.46);aura.position.z=-24;
  const centerGlow=glow(group,'#bdefff',118,.25);centerGlow.position.z=45;
  // A grazing circumsolar filament and particles make the mark feel alive at a distance.
  const corona=ring(group,126,.25,lightMaterial('#b8bbee',.36));corona.rotation.x=.50;corona.rotation.y=-.26;
  const particles=stellarDust(group,121,190,'#c4d6ed');group.add(particles);
  const title=label(group,'BEACN','IMAGINE THE FUTURE TOGETHER','#c4e4dd',167,[0,-139,20]);
  // Authentic source logo sits on a small heritage plaque when viewed up close.
  const tex=new THREE.TextureLoader().load(beacnLogoUrl);tex.colorSpace=THREE.SRGBColorSpace;
  const plaque=mesh(new THREE.PlaneGeometry(19,20.5),new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false,toneMapped:false,side:THREE.DoubleSide}),sculpt,[0,-65,70]);
  return {...spec,position:group.position,radius:spec.radius,group,update(time){plasma.uniforms.uTime.value=time;core.rotation.y=time*.018;backRing.rotation.z=time*.025;backRing2.rotation.z=-time*.021;particles.rotation.y=time*.013;particles.rotation.z=time*.005;centerGlow.material.opacity=.20+Math.sin(time*.8)*.035;aura.material.opacity=.42+Math.sin(time*.27)*.035;word.rotation.y=Math.sin(time*.15)*.015;}};
}
function createHeard(parent){
  const spec=PROJECT_LANDMARKS.heardUs,group=new THREE.Group();group.position.fromArray(spec.position);group.scale.setScalar(SOLAR_SCALE.landmarkScale);group.name='Heard — the civic-signal beacon';parent.add(group);group.userData.projectId='heard-us';group.userData.url=spec.url;
  const navy=surface('#102334','#132a40',.25),gold=surface('#cfad55','#ad7830',.45),bright=surface('#f1deb0','#f7d78a',1.0),ink=surface('#182a39','#213c50',.08);
  const orb=mesh(new THREE.SphereGeometry(22,48,32),navy,group);
  const bands=[];
  for(let i=0;i<3;i++) {const g=new THREE.Group();group.add(g);g.rotation.set(.5+i*.27,.18+i*.37,i*.52);const band=ring(g,27+i*3,.26+i*.05,i===1?bright:gold,.06,TAU-.12);bands.push(g);}
  const word=textMesh(group,'Heard',10,fonts.serif,bright,[0,1,30]);
  // A circle of individual lights broadcasts together: an original civic-signal motif.
  const signals=new THREE.Group();group.add(signals);signals.rotation.x=Math.PI/2;signals.position.y=-9;
  const signalMeshes=[];
  for(let i=0;i<28;i++){
    const a=i/28*TAU,h=1.3+3.2*(.5+.5*Math.sin(i*2.4)),r=28;
    const bar=mesh(new THREE.CapsuleGeometry(.28,h,3,6),gold,signals,[Math.cos(a)*r,Math.sin(a)*r,0]);bar.rotation.z=a-Math.PI/2;bar.userData.base=h;signalMeshes.push(bar);
  }
  for(const s of [-1,1]){
    const arch=ring(group,22,.36,gold,s<0?.56:Math.PI+.56,Math.PI-.85);arch.position.z=11;arch.rotation.y=s*.24;
  }
  const halo=glow(group,'#ffd787',119,.25);halo.position.z=-5;
  label(group,'HEARD','YOUR VOICE MATTERS','#e9d8aa',76,[0,-45,8]);
  const dust=stellarDust(group,37,70,'#e4c98b');group.add(dust);
  return {...spec,position:group.position,radius:spec.radius,group,update(time){orb.rotation.y=time*.025;bands.forEach((b,i)=>b.rotation.z=i*.52+time*(i%2?-.06:.04));signals.rotation.z=time*.022;signalMeshes.forEach((b,i)=>b.scale.y=.87+Math.sin(time*1.9-i*.55)*.12);dust.rotation.y=-time*.014;halo.material.opacity=.24+Math.sin(time*1.6)*.035;}};
}
export function createProjectStars(scene){
  const group=new THREE.Group();group.name='featured-project-landmarks';scene.add(group);
  const beacn=createBeacn(group),heardUs=createHeard(group);let disposed=false;
  return {group,beacn,heardUs,update(time,dt){if(disposed)return;beacn.update(time,dt);heardUs.update(time,dt);},dispose(){
    if(disposed)return;disposed=true;group.removeFromParent();const geometries=new Set(),materials=new Set(),textures=new Set();
    group.traverse(o=>{if(o.geometry&&!o.isSprite)geometries.add(o.geometry);for(const m of Array.isArray(o.material)?o.material:o.material?[o.material]:[]){materials.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v);}});
    geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());
  }};
}
