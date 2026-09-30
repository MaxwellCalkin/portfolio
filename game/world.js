import * as THREE from 'three';
import { createCollisionWorld, createTerrainSampler, createMeshFootprint } from './collision.js';

/* Original procedural world art. All constructors face -Z; terrain coordinates are world-local. */
export const PLANETS = [
  { id: 'philosophy', name: 'Philosophy', subtitle: 'THE WAY I SEE', color: '#81d9c0', position: [-210, 25, -290], radius: 60 },
  { id: 'experience', name: 'Experience', subtitle: 'WHERE I HAVE BEEN', color: '#df9671', position: [220, 60, -500], radius: 76 },
  { id: 'projects', name: 'Projects', subtitle: 'WORLDS I HAVE BUILT', color: '#bda3ed', position: [450, -50, -80], radius: 58 },
  { id: 'mission', name: 'Mission', subtitle: 'WHAT COMES NEXT', color: '#81b9e3', position: [-450, -30, 90], radius: 84 },
  { id: 'contact', name: 'Contact', subtitle: 'A SIGNAL BETWEEN US', color: '#eac789', position: [40, 100, 350], radius: 46 },
].map(p=>({...p,position:p.position.map(value=>value*3.5),radius:p.radius*2.5}));
const TAU = Math.PI * 2;
const color = c => new THREE.Color(c);
const clamp = THREE.MathUtils.clamp;
const mix = THREE.MathUtils.lerp;
function random(seed = 1) {
  let s = seed >>> 0;
  return () => { s += 0x6d2b79f5; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
function mesh(geometry, material, parent, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material); m.position.set(x, y, z); if (parent) parent.add(m); return m;
}
function standard(c, roughness = .6, metalness = .1, extra = {}) {
  return new THREE.MeshStandardMaterial({ color: c, roughness, metalness, ...extra });
}
function disposeGroup(group) {
  group.removeFromParent();
  const geometries = new Set(), materials = new Set(), textures = new Set();
  group.traverse(o => {
    if (o.geometry && !o.isSprite && !o.geometry.userData.shared) geometries.add(o.geometry);
    for (const mat of (Array.isArray(o.material) ? o.material : o.material ? [o.material] : [])) {
      if (mat.userData.shared) continue; materials.add(mat);
      for (const value of Object.values(mat)) if (value?.isTexture && !value.userData.shared) textures.add(value);
    }
  });
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose());
}

let glowTexture;
function getGlowTexture() {
  if (glowTexture) return glowTexture;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d'), gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(.09, 'rgba(255,255,255,.95)'); gradient.addColorStop(.24, 'rgba(255,255,255,.32)'); gradient.addColorStop(.55, 'rgba(255,255,255,.07)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(canvas); glowTexture.userData.shared = true;
  return glowTexture;
}
export function createGlow(c = '#9ffff1', size = 5) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: getGlowTexture(), color: c, transparent: true, opacity: .9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  s.scale.setScalar(size); return s;
}

const noiseGLSL = `
float hash(vec3 p) { p=fract(p*0.3183099+vec3(.17,.11,.23)); p*=17.; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float noise(vec3 p) { vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
 return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z); }
float fbm(vec3 p) { float v=0.; float a=.5; for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.03+vec3(4.1,1.7,9.2);a*=.5;}return v; }
`;
const planetVertex = `varying vec3 vPosition; varying vec3 vNormal; varying vec3 vWorld; void main(){vPosition=position;vNormal=normalize(mat3(modelMatrix)*normal);vWorld=(modelMatrix*vec4(position,1.)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
function planetMaterial(base, seed, giant = false) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color(base) }, uSeed: { value: seed }, uGiant: { value: giant ? 1 : 0 }, uTime: { value: 0 } },
    vertexShader: planetVertex,
    fragmentShader: `uniform vec3 uColor;uniform float uSeed,uGiant,uTime;varying vec3 vPosition,vNormal,vWorld;${noiseGLSL}
    void main(){float closeView=1.-smoothstep(60.,180.,distance(cameraPosition,vWorld));vec3 p=normalize(vPosition);vec3 q=p*4.2+uSeed;float continents=fbm(q+fbm(q*1.7));float ridges=fbm(p*22.+uSeed);float fine=noise(p*115.+uSeed);
    vec3 ocean=mix(vec3(.012,.032,.046),uColor*.24,.6); vec3 land=mix(uColor*.36,uColor*1.1,smoothstep(.39,.73,continents));
    float edges=smoothstep(.44,.50,continents);vec3 albedo=mix(ocean,land,edges);albedo*=.72+.42*ridges+.14*fine;
    float cloud=fbm(p*6.+vec3(uSeed,uTime*.008,0.)+fbm(p*11.));float cloudMask=smoothstep(.57,.71,cloud);albedo=mix(albedo,mix(uColor,vec3(1.),.83),cloudMask*.88*(1.-closeView*.8));
    if(uGiant>.5){float bands=sin(p.y*46.+fbm(p*7.)*14.);albedo=mix(uColor*.23,uColor*1.2,bands*.5+.5);albedo=mix(albedo,vec3(.92,.79,.66),smoothstep(.67,.9,fbm(p*10.))*.6);}
    vec3 n=normalize(vNormal),l=normalize(vec3(-.65,.6,.55)),v=normalize(cameraPosition-vWorld);float daylight=max(dot(n,l),0.);float twilight=smoothstep(-.3,.4,dot(n,l));
    vec3 surveyGround=mix(uColor*.38,uColor*.76,.5+.5*noise(vPosition*.6+uSeed));albedo=mix(albedo,surveyGround,closeView*.7);vec3 lit=albedo*(.07+.92*daylight+closeView*.38);float spec=pow(max(dot(reflect(-l,n),v),0.),40.)*(1.-edges);lit+=vec3(.52,.71,.73)*spec*.28;
    float rim=pow(1.-max(dot(n,v),0.),3.);lit+=uColor*rim*.36*twilight;float city=step(.82,noise(p*245.))*step(.53,continents)*(1.-twilight);lit+=vec3(1.,.43,.12)*city*.22*(1.-closeView);
    gl_FragColor=vec4(lit,1.);#include <tonemapping_fragment>\n#include <colorspace_fragment>}`.replace(';}#', ';}\n#').replace(';#include', ';\n#include'),
  });
}
function atmosphere(radius, c) {
  const m = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color(c) } }, vertexShader: planetVertex,
    fragmentShader: `uniform vec3 uColor;varying vec3 vNormal,vWorld;void main(){vec3 v=normalize(cameraPosition-vWorld);float rim=pow(1.-abs(dot(normalize(vNormal),v)),3.4);float lit=.28+.72*max(dot(normalize(vNormal),normalize(vec3(-.65,.6,.55))),0.);gl_FragColor=vec4(uColor*1.1,rim*lit*.55);}`,
    transparent: true, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius * 1.047, 48, 32), m);
}
function createRing(inner, outer, c, opacity = .5) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 160, 1), new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color(c) }, uInner: { value: inner }, uOuter: { value: outer }, uOpacity: { value: opacity } },
    vertexShader: `varying vec2 vPosition;void main(){vPosition=position.xy;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `uniform vec3 uColor;uniform float uInner,uOuter,uOpacity;varying vec2 vPosition;void main(){float r=length(vPosition);float t=(r-uInner)/(uOuter-uInner);float bands=.32+.30*sin(t*225.)+.22*sin(t*77.)+.14*sin(t*981.);float a=smoothstep(0.,.07,t)*(1.-smoothstep(.86,1.,t));float gap=smoothstep(.006,.011,abs(t-.48));gl_FragColor=vec4(uColor*(.65+.5*t),a*clamp(bands,.09,.82)*gap*uOpacity);}`,
    side: THREE.DoubleSide, transparent: true, depthWrite: false,
  }));
  ring.rotation.x = Math.PI * .39; ring.rotation.y = -.22; return ring;
}
function createPlanet(spec, i, giant = false) {
  const root = new THREE.Group(); root.position.fromArray(spec.position || [0,0,0]);
  const globe = mesh(new THREE.SphereGeometry(spec.radius, 72, 48), planetMaterial(spec.color, i * 11.37 + 3.4, giant), root);
  globe.rotation.z = -.12 + i * .06; root.add(atmosphere(spec.radius, spec.color));
  if (i === 0 || i === 2 || giant) root.add(createRing(spec.radius * 1.29, spec.radius * (giant ? 2.15 : 1.85), spec.color, giant ? .84 : .63));
  return { root, globe };
}
function starfield(count, radius, seed = 42, minRadius = .8) {
  const rnd = random(seed), positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), sizes = new Float32Array(count);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const theta = rnd()*TAU, y = rnd()*2-1, d = Math.sqrt(1-y*y), r = radius * mix(minRadius,1,rnd());
    positions.set([Math.cos(theta)*d*r,y*r,Math.sin(theta)*d*r],i*3);
    c.setHSL(rnd()<.7 ? .56+rnd()*.13 : .08+rnd()*.08,.1+rnd()*.32,.57+rnd()*.43); colors.set([c.r,c.g,c.b],i*3); sizes[i] = rnd()<.03 ? 3.2+rnd()*2 : .7+rnd()*1.5;
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position',new THREE.BufferAttribute(positions,3));geo.setAttribute('color',new THREE.BufferAttribute(colors,3));geo.setAttribute('size',new THREE.BufferAttribute(sizes,1));
  return new THREE.Points(geo,new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } }, vertexShader: `attribute float size;varying vec3 vColor;uniform float uTime;void main(){vColor=color;vec4 p=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*p;gl_PointSize=size*(.82+.18*sin(position.x+uTime*.3));}`,
    fragmentShader: `varying vec3 vColor;void main(){float d=length(gl_PointCoord-.5);float a=1.-smoothstep(.1,.5,d);gl_FragColor=vec4(vColor,a);}`,
    transparent:true,vertexColors:true,depthWrite:false,blending:THREE.AdditiveBlending,
  }));
}
function nebulaSky(radius = 2600, surface = false, tint = '#618f91') {
  return new THREE.Mesh(new THREE.SphereGeometry(radius,40,24),new THREE.ShaderMaterial({
    uniforms:{uTint:{value:color(tint)},uSurface:{value:surface?1:0}},side:THREE.BackSide,depthWrite:false,
    vertexShader:`varying vec3 vDir;void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`varying vec3 vDir;uniform vec3 uTint;uniform float uSurface;${noiseGLSL}
    void main(){vec3 p=normalize(vDir);float ribbon=exp(-pow((p.y+.17+p.x*.24)/.28,2.));float n=fbm(p*3.1+vec3(2.,3.,5.));float detail=fbm(p*9.+n*4.);float dust=smoothstep(.34,.72,n)*ribbon;vec3 ink=vec3(.006,.014,.024);vec3 blue=vec3(.042,.103,.125);vec3 wine=vec3(.15,.063,.053);vec3 fog=mix(blue,wine,smoothstep(-.25,.6,p.x));vec3 sky=ink+fog*dust*.78+vec3(.06,.11,.12)*pow(detail,3.)*ribbon;float horizon=exp(-abs(p.y)*5.);sky=mix(sky,sky+uTint*.13*horizon+uTint*.018,uSurface);gl_FragColor=vec4(sky,1.);}`,
  }));
}
function arcLine(radius, start, end, c, opacity = .1) {
  const pts=[];for(let i=0;i<=180;i++){const a=mix(start,end,i/180);pts.push(new THREE.Vector3(Math.cos(a)*radius,0,Math.sin(a)*radius));}
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),new THREE.LineBasicMaterial({color:c,transparent:true,opacity,depthWrite:false}));
}
function worldLighting(group, surface = false, tint = '#8bbbbb') {
  group.add(new THREE.HemisphereLight(surface ? '#b8d6e0' : '#b0cfde', surface ? '#514a49' : '#222e3d', surface ? 1.65 : 1.05));
  const key = new THREE.DirectionalLight('#fff0d8',surface ? 3.15 : 3.8);key.position.set(-130,160,100);group.add(key);
  const fill = new THREE.DirectionalLight(tint,surface ? .9 : 1.9);fill.position.set(100,20,-160);group.add(fill);
}
export function createSpaceWorld(scene) {
  const group=new THREE.Group();group.name='procedural-deep-space';scene.add(group);
  group.add(nebulaSky(12000));const stars=starfield(6000,10500);group.add(stars);worldLighting(group);
  const planets=PLANETS.map((spec,i)=>{const p=createPlanet(spec,i);group.add(p.root);p.globe.userData.planetId=spec.id;return {...spec,mesh:p.globe,group:p.root};});
  for(let i=0;i<3;i++){const line=arcLine(440+i*210,-Math.PI*.98,Math.PI*.92,'#7daeb2',.065-i*.009);line.rotation.set(.08+i*.07,0,.10);line.position.y=-130-i*55;group.add(line);}
  const sun=createGlow('#f7dfb2',380);sun.position.set(-720,380,-1400);group.add(sun);const sunCore=createGlow('#ffecc4',45);sunCore.position.copy(sun.position);group.add(sunCore);
  const rnd=random(928),rockGeo=new THREE.IcosahedronGeometry(1,0),rockMat=standard('#536167',.95,.25);
  const debris=new THREE.InstancedMesh(rockGeo,rockMat,140); const dummy=new THREE.Object3D();
  for(let i=0;i<140;i++){let a=rnd()*TAU,r=670+rnd()*260;dummy.position.set(Math.cos(a)*r,(rnd()-.5)*140-140,Math.sin(a)*r);dummy.rotation.set(rnd()*3,rnd()*3,rnd()*3);dummy.scale.set(1+rnd()*5,1+rnd()*3,1+rnd()*4);dummy.updateMatrix();debris.setMatrixAt(i,dummy.matrix);}group.add(debris);
  return {group,planets,update(time,dt){stars.material.uniforms.uTime.value=time;for(let i=0;i<planets.length;i++){planets[i].mesh.material.uniforms.uTime.value=time;}},dispose(){disposeGroup(group);}};
}

function loft(profiles, sides = 8) {
  const vertices=[],indices=[];
  for(const [z,w,h,cy=0] of profiles) for(let i=0;i<sides;i++){const a=i*TAU/sides+Math.PI/8;vertices.push(Math.cos(a)*w,Math.sin(a)*h+cy,z);}
  for(let j=0;j<profiles.length-1;j++)for(let i=0;i<sides;i++){let a=j*sides+i,b=j*sides+(i+1)%sides,c=b+sides,d=a+sides;indices.push(a,b,c,a,c,d);}
  for(let i=1;i<sides-1;i++){indices.push(0,i+1,i);const o=(profiles.length-1)*sides;indices.push(o,o+i,o+i+1);}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setIndex(indices);g.computeVertexNormals();return g;
}
function plate(points, thickness, material, group, y = 0, bevel = .08) {
  const shape=new THREE.Shape();points.forEach((p,i)=>i?shape.lineTo(p[0],p[1]):shape.moveTo(p[0],p[1]));shape.closePath();
  const g=new THREE.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:bevel,bevelThickness:bevel});g.rotateX(Math.PI/2);g.translate(0,y+thickness/2,0);return mesh(g,material,group);
}
function cylinderZ(radiusTop,radiusBottom,length,mat,parent,x,y,z,sides=16) {const m=mesh(new THREE.CylinderGeometry(radiusTop,radiusBottom,length,sides),mat,parent,x,y,z);m.rotation.x=Math.PI/2;return m;}
export function createShip() {
  const group=new THREE.Group();group.name='Aster-surveyor';
  const pearl=standard('#e6e4d9',.32,.38),chalk=standard('#bbbeb9',.48,.45),graphite=standard('#18252c',.45,.62),orange=standard('#ef7243',.4,.28),glass=standard('#14383f',.16,.65,{emissive:'#184c53',emissiveIntensity:.22}),light=standard('#abf9eb',.2,.4,{emissive:'#70e6dd',emissiveIntensity:2.8});
  mesh(loft([[-7.3,.09,.08,-.1],[-5.7,.6,.34,0],[-3.6,1.16,.55,.1],[-.8,1.6,.88,.08],[2.8,1.4,.67,0],[4.8,.86,.37,0],[5.3,.45,.24,0]]),pearl,group);
  const keel=mesh(loft([[-6.3,.12,.1,-.4],[-2.4,1.08,.29,-.5],[2.8,1.19,.38,-.43],[5.2,.5,.16,-.25]]),graphite,group);
  mesh(loft([[-4.35,.15,.06,.45],[-3.5,.64,.35,.68],[-1.65,.92,.50,.81],[-.35,.83,.40,.71],[.25,.35,.1,.7]]),graphite,group);
  mesh(loft([[-4.15,.11,.05,.51],[-3.4,.54,.29,.74],[-1.7,.80,.42,.86],[-.55,.72,.33,.78],[.02,.3,.07,.76]]),glass,group);
  plate([[-.1,-6.8],[.1,-6.8],[.26,-4.3],[-.26,-4.3]],.045,orange,group,.36,.01);
  for(const sign of [-1,1]){
    const wingPoints=[[sign*1.2,-2.5],[sign*2.7,-.5],[sign*6.8,3.4],[sign*6.55,4.65],[sign*2.75,2.6],[sign*1.08,3.6]];
    plate(wingPoints,.28,graphite,group,-.2);
    plate([[sign*1.38,-2.13],[sign*2.55,-.3],[sign*6.48,3.45],[sign*6.3,4.11],[sign*2.83,2.04],[sign*1.32,2.87]],.12,pearl,group,.015,.055);
    plate([[sign*4.95,2.15],[sign*5.63,2.84],[sign*5.41,3.51],[sign*4.70,3.07]],.035,orange,group,.12,.025);
    plate([[sign*1.5,1.5],[sign*3.8,4.8],[sign*3.3,5.4],[sign*1.13,4.1]],.17,chalk,group,.19,.055);
    const nacelle=mesh(loft([[-.6,.32,.37,0],[.2,.56,.55,0],[3.4,.57,.46,0],[5.35,.42,.38,0]]),graphite,group,sign*2.52,-.04,.1);
    mesh(loft([[.05,.38,.13,.46],[1.,.51,.15,.44],[3.85,.47,.14,.35],[4.6,.33,.1,.3]]),pearl,group,sign*2.52,0,.1);
    cylinderZ(.43,.48,.44,graphite,group,sign*2.52,-.04,5.48);
    const nozzle=mesh(new THREE.TorusGeometry(.37,.08,8,24),chalk,group,sign*2.52,-.04,5.74);
    cylinderZ(.29,.31,.05,light,group,sign*2.52,-.04,5.77);
    const fin=plate([[0,0],[0,2.5],[.18,2.0],[.18,.4]],.8,graphite,null,0,.03);fin.rotation.z=sign*-.5;fin.rotation.y=Math.PI/2;fin.position.set(sign*2.56,.47,2.7);group.add(fin);
    const wingLight=createGlow(sign<0?'#ef6b44':'#9aebe1',1.3);wingLight.position.set(sign*6.57,.1,3.8);group.add(wingLight);
    const seam=mesh(new THREE.BoxGeometry(.055,.065,1.8),graphite,group,sign*.98,.59,1.3);seam.rotation.y=sign*.06;
  }
  const thrusters=[],engineGlows=[];
  for(const x of [-2.52,2.52]) {const glow=createGlow('#8df9ec',4.5);glow.position.set(x,-.04,6.0);group.add(glow);engineGlows.push(glow); const flame=cylinderZ(.23,.05,2.5,new THREE.MeshBasicMaterial({color:'#9effe9',transparent:true,opacity:.36,depthWrite:false,blending:THREE.AdditiveBlending}),group,x,-.04,6.7);thrusters.push(flame);flame.userData.flame=true;}
  group.userData.thrusters=thrusters;group.userData.engineGlows=engineGlows;group.userData.nominalLength=13;
  group.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});return group;
}

function capsule(radius,length,mat,parent,x,y,z){return mesh(new THREE.CapsuleGeometry(radius,length,5,12),mat,parent,x,y,z);}
export function createAstronaut() {
  const group=new THREE.Group();group.name='the-explorer';
  const suit=standard('#dedfcf',.65,.16),dark=standard('#26333c',.68,.2),orange=standard('#d67443',.58,.2),metal=standard('#abb6b7',.42,.48),visor=standard('#163038',.1,.78,{emissive:'#265c63',emissiveIntensity:.4}),emissive=standard('#b8f9e6',.3,.2,{emissive:'#8aeedc',emissiveIntensity:2});
  capsule(.39,.48,suit,group,0,1.37,0).scale.set(1.08,1,.74);
  const chest=mesh(new THREE.BoxGeometry(.5,.45,.13),orange,group,0,1.52,-.27);
  mesh(new THREE.BoxGeometry(.27,.17,.025),dark,group,0,1.61,-.35);mesh(new THREE.BoxGeometry(.16,.025,.027),emissive,group,0,1.64,-.369);
  mesh(new THREE.BoxGeometry(.62,.15,.49),dark,group,0,1.0,0);
  const helmet=mesh(new THREE.SphereGeometry(.43,28,20),suit,group,0,2.05,0);helmet.scale.set(1.04,1,.96);
  const gasket=mesh(new THREE.SphereGeometry(.385,28,18),dark,group,0,2.065,-.165);gasket.scale.set(1,.69,.85);
  const mask=mesh(new THREE.SphereGeometry(.365,28,18),visor,group,0,2.075,-.208);mask.scale.set(1,.62,.78);
  const brow=mesh(new THREE.BoxGeometry(.4,.026,.037),metal,group,0,2.275,-.412);brow.rotation.x=-.16;
  for(const sign of [-1,1]){cylinderZ(.075,.075,.1,orange,group,sign*.393,2.025,0).rotation.set(0,0,Math.PI/2);mesh(new THREE.BoxGeometry(.09,.032,.015),emissive,group,sign*.305,2.1,-.39);}
  const backpack=mesh(new THREE.BoxGeometry(.58,.70,.28),dark,group,0,1.43,.36);mesh(new THREE.BoxGeometry(.42,.45,.1),suit,group,0,1.50,.54);
  for(const s of [-1,1])capsule(.105,.49,metal,group,s*.3,1.4,.38);
  mesh(new THREE.CylinderGeometry(.015,.015,.43,5),metal,group,-.3,1.98,.4);
  const limbs={};
  for(const [side,sign] of [['left',-1],['right',1]]){
    const leg=new THREE.Group();leg.position.set(sign*.22,.92,0);group.add(leg);capsule(.16,.32,suit,leg,0,-.24,0);capsule(.125,.2,dark,leg,0,-.55,0);mesh(new THREE.BoxGeometry(.22,.21,.2),orange,leg,0,-.43,-.1);mesh(new THREE.BoxGeometry(.29,.2,.43),dark,leg,0,-.80,-.095);limbs[`${side}Leg`]=leg;
    const arm=new THREE.Group();arm.position.set(sign*.47,1.67,0);group.add(arm);capsule(.15,.26,orange,arm,sign*.035,-.16,0);capsule(.12,.21,suit,arm,sign*.035,-.43,-.08);capsule(.115,.08,dark,arm,sign*.04,-.62,-.14);limbs[`${side}Arm`]=arm;
  }
  limbs.rightArm.rotation.x=-.5;
  const weapon=new THREE.Group();weapon.position.set(.51,1.04,-.53);group.add(weapon);mesh(new THREE.BoxGeometry(.19,.18,.58),dark,weapon,0,0,-.13);mesh(new THREE.BoxGeometry(.22,.10,.33),metal,weapon,0,.085,-.2);cylinderZ(.055,.07,.31,dark,weapon,0,.012,-.55);mesh(new THREE.BoxGeometry(.06,.05,.16),emissive,weapon,0,.08,-.17);mesh(new THREE.BoxGeometry(.09,.21,.10),dark,weapon,0,-.14,.04);
  group.userData.limbs=limbs;group.userData.parts=limbs;group.userData.weapon=weapon;group.userData.muzzle=new THREE.Vector3(.51,1.05,-1.22);
  Object.assign(group.userData,limbs);group.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true;}});return group;
}
const enemyAssetPool = new Map();
function enemyAssets(variant) {
  const key = variant % 2;
  if (enemyAssetPool.has(key)) return enemyAssetPool.get(key);
  const accent = key ? '#ecae6b' : '#d58271';
  const assets = { accent,
    shell: standard('#4b5356',.54,.55), dark: standard('#17282c',.6,.45), rim: standard(accent,.42,.4),
    core: standard('#ffe1aa',.2,.2,{emissive:accent,emissiveIntensity:2.4}),
    bodyGeo: new THREE.IcosahedronGeometry(.68,1), coreGeo: new THREE.OctahedronGeometry(.35,0),
    ringGeo: new THREE.TorusGeometry(.9,.048,5,48), finGeo: new THREE.ConeGeometry(.21,.94,3),
  };
  for (const resource of Object.values(assets)) if (resource?.userData) resource.userData.shared = true;
  enemyAssetPool.set(key,assets); return assets;
}
export function createEnemy(variant = 0) {
  const group=new THREE.Group();group.name='echo-sentinel';const a=enemyAssets(variant);
  const body=mesh(a.bodyGeo,a.shell,group,0,0,0);body.scale.set(1,.82,.87);mesh(a.coreGeo,a.core,group,0,0,-.49).scale.set(1,.75,.35);
  const orbit=mesh(a.ringGeo,a.rim,group,0,0,0);orbit.rotation.x=.65;orbit.rotation.y=.4;
  for(let i=0;i<3;i++){const angle=i*TAU/3;const fin=mesh(a.finGeo,a.dark,group,Math.cos(angle)*.66,-.21,Math.sin(angle)*.66);fin.rotation.z=Math.cos(angle)*-.55;fin.rotation.x=Math.sin(angle)*.55;fin.rotation.y=-angle;}
  const glow=createGlow(a.accent,2.4);glow.position.set(0,0,-.5);glow.material.opacity=.35;group.add(glow);
  group.userData.orbit=orbit;group.userData.body=body;group.userData.glow=glow;
  group.userData.dispose=()=>{group.removeFromParent();glow.material.dispose();}; return group;
}

function terrainHeight(x,z,seed) {
  const r=Math.hypot(x,z), outer=THREE.MathUtils.smoothstep(r,34,115);
  const low=Math.sin(x*.022+seed)*Math.cos(z*.026)*2.8+Math.sin(z*.04+x*.011)*1.2;
  const ridges=Math.pow(Math.abs(Math.sin(x*.018+seed)*Math.cos(z*.019-seed)+.42*Math.sin(z*.045+x*.023)),2.3)*12;
  return low*(.24+.76*outer)+ridges*outer+Math.sin(x*.09+z*.03)*Math.sin(z*.08)*outer*.8;
}
function crystalGeometry() {
  const geo=new THREE.CylinderGeometry(0,.75,4,5,1);geo.translate(0,2,0);return geo;
}
function arch(parent,x,y,z,s,c,rotation=0) {
  const mat=standard('#3b5359',.78,.36), edge=standard(c,.48,.4,{emissive:c,emissiveIntensity:.35});const group=new THREE.Group();group.position.set(x,y,z);group.rotation.y=rotation;group.scale.setScalar(s);parent.add(group);
  const shape=new THREE.Shape();shape.moveTo(-5,0);shape.lineTo(-5,12);shape.quadraticCurveTo(0,17,5,12);shape.lineTo(5,0);shape.lineTo(3.75,0);shape.lineTo(3.75,10.6);shape.quadraticCurveTo(0,14.3,-3.75,10.6);shape.lineTo(-3.75,0);shape.closePath();
  const g=new THREE.ExtrudeGeometry(shape,{depth:1.25,bevelEnabled:true,bevelSegments:1,bevelSize:.15,bevelThickness:.15});mesh(g,mat,group);
  for(const sign of [-1,1])mesh(new THREE.BoxGeometry(.07,8.5,.035),edge,group,sign*4.2,5.5,-.17);
  return group;
}
export function createSurfaceWorld(scene,planetId) {
  const index=Math.max(0,PLANETS.findIndex(p=>p.id===planetId)),spec=PLANETS[index],seed=index*1.3+.5,rnd=random(1384+index*71);
  const themes=[{ground:'#62746a',dust:'#a7b0a0',rock:'#344f4e',flora:'#a6e6c3',sky:'#74aea1'},{ground:'#916453',dust:'#cba28b',rock:'#623d37',flora:'#e6bca0',sky:'#c4856e'},{ground:'#665e7b',dust:'#b0a4c2',rock:'#494659',flora:'#c4a7fa',sky:'#a18fb7'},{ground:'#61757c',dust:'#a1b8c2',rock:'#344f61',flora:'#a0d9ec',sky:'#719ab4'},{ground:'#8b8163',dust:'#c9bd95',rock:'#605946',flora:'#ffe6a0',sky:'#bca579'}];
  const theme=themes[index],group=new THREE.Group();group.name=`surface-${planetId}`;scene.add(group);worldLighting(group,true,spec.color);
  group.add(nebulaSky(1900,true,theme.sky));const stars=starfield(1800,1550,81+index);group.add(stars);
  const celestial=createPlanet({radius:220,color:index===1?'#8ab7b3':'#d0a18b',position:[-390,410,-1020]},11,true);celestial.root.rotation.z=-.25;group.add(celestial.root);
  const moon=createPlanet({radius:44,color:'#aaa9b0',position:[350,360,-830]},3);group.add(moon.root);
  const sun=createGlow('#ffe2b2',230);sun.position.set(-650,410,220);group.add(sun);
  const sculptHeight=(x,z)=>terrainHeight(x,z,seed);
  const terrain=new THREE.PlaneGeometry(640,640,160,160);terrain.rotateX(-Math.PI/2);const pos=terrain.attributes.position,col=new Float32Array(pos.count*3),dark=color(theme.ground),light=color(theme.dust),temp=new THREE.Color();
  for(let i=0;i<pos.count;i++){const x=pos.getX(i),z=pos.getZ(i),h=sculptHeight(x,z);pos.setY(i,h);const n=.5+.18*Math.sin(x*.12+Math.cos(z*.074)*3)+.10*Math.sin(z*.34+x*.17);temp.copy(dark).lerp(light,clamp(n+(h/80)*.16,0,1));col.set([temp.r,temp.g,temp.b],i*3);}terrain.setAttribute('color',new THREE.BufferAttribute(col,3));terrain.computeVertexNormals();
  const land=mesh(terrain,standard('#ffffff',.96,.05,{vertexColors:true}),group);land.name='terrain';land.receiveShadow=true;
  const terrainSampler=createTerrainSampler(terrain),heightAt=terrainSampler.heightAt;
  const collision=createCollisionWorld({heightAt,sampleTerrain:terrainSampler.sample,bounds:{minX:-280,maxX:280,minZ:-280,maxZ:280}});
  const addFootprint=(geometry,matrix,x,z,kind)=>{const y=heightAt(x,z),shape=createMeshFootprint(geometry,matrix,y+.04,y+2.5);if(shape)collision.addCollider({...shape,kind});};
  // Distant sculpted mesas establish scale beyond the traversable landing basin.
  const mountainGeo=new THREE.IcosahedronGeometry(1,2),mountainMat=standard(theme.rock,.94,.03);const mountains=new THREE.InstancedMesh(mountainGeo,mountainMat,37),dummy=new THREE.Object3D();
  for(let i=0;i<37;i++){const a=i/37*TAU+(rnd()-.5)*.1,r=205+rnd()*130,x=Math.cos(a)*r,z=Math.sin(a)*r,s=22+rnd()*43;dummy.position.set(x,heightAt(x,z)+s*.5,z);dummy.rotation.set(rnd()*.4,rnd()*TAU,rnd()*.2);dummy.scale.set(s*.85,s*(.55+rnd()*.65),s*(.65+rnd()));dummy.updateMatrix();mountains.setMatrixAt(i,dummy.matrix);addFootprint(mountainGeo,dummy.matrix,x,z,'mesa');}group.add(mountains);
  // Low, irregular boulders and tall translucent mineral blooms frame the playable basin.
  const rockGeo=new THREE.IcosahedronGeometry(1,1),rockMat=standard(theme.rock,.84,.14),rocks=new THREE.InstancedMesh(rockGeo,rockMat,250);
  for(let i=0;i<250;i++){let x=(rnd()-.5)*390,z=(rnd()-.5)*390;if(Math.hypot(x,z)<22){x+=Math.sign(x||1)*27;}const s=.5+rnd()*3.0;dummy.position.set(x,heightAt(x,z)+s*.22,z);dummy.rotation.set(rnd()*3,rnd()*3,rnd()*3);dummy.scale.set(s,s*(.4+rnd()*.7),s*(.7+rnd()));dummy.updateMatrix();rocks.setMatrixAt(i,dummy.matrix);addFootprint(rockGeo,dummy.matrix,x,z,'boulder');}rocks.castShadow=true;rocks.receiveShadow=true;group.add(rocks);
  const crystalGeo=crystalGeometry(),crystalMat=standard(theme.flora,.34,.45,{emissive:theme.flora,emissiveIntensity:.10,flatShading:true}),crystals=new THREE.InstancedMesh(crystalGeo,crystalMat,230);
  const crystalColor=new THREE.Color();
  for(let i=0;i<230;i++){let a=rnd()*TAU,r=24+Math.pow(rnd(),.85)*170,x=Math.cos(a)*r,z=Math.sin(a)*r;if(Math.abs(x)<12&&z>-36&&z<45)x+=Math.sign(x||1)*16;const s=.35+rnd()*1.15;dummy.position.set(x,heightAt(x,z)-.2,z);dummy.rotation.set((rnd()-.5)*.45,rnd()*TAU,(rnd()-.5)*.55);dummy.scale.set(s*(.6+rnd()),s*(.7+rnd()*1.5),s);dummy.updateMatrix();crystals.setMatrixAt(i,dummy.matrix);addFootprint(crystalGeo,dummy.matrix,x,z,'crystal');crystalColor.set(theme.flora).multiplyScalar(.62+rnd()*.54);crystals.setColorAt(i,crystalColor);}crystals.castShadow=true;group.add(crystals);
  // Umbrella-shaped xenoflora: sculptural canopies atop tapered charcoal stems.
  const stemGeo=new THREE.CylinderGeometry(.16,.38,5.5,7),capGeo=new THREE.SphereGeometry(1,10,7,0,TAU,0,Math.PI*.55),stemMat=standard(theme.rock,.8,.12),capMat=standard(theme.flora,.8,.12);
  const stems=new THREE.InstancedMesh(stemGeo,stemMat,45),caps=new THREE.InstancedMesh(capGeo,capMat,45);
  for(let i=0;i<45;i++){const a=rnd()*TAU,r=47+rnd()*145,x=Math.cos(a)*r,z=Math.sin(a)*r,s=.5+rnd()*1.4,y=heightAt(x,z);dummy.rotation.set(0,rnd()*TAU,(rnd()-.5)*.15);dummy.position.set(x,y+s*2.7,z);dummy.scale.set(s,s,s);dummy.updateMatrix();stems.setMatrixAt(i,dummy.matrix);addFootprint(stemGeo,dummy.matrix,x,z,'tree');dummy.position.y=y+s*5.35;dummy.scale.set(s*2.9,s*.9,s*2.3);dummy.updateMatrix();caps.setMatrixAt(i,dummy.matrix);addFootprint(capGeo,dummy.matrix,x,z,'low-canopy');}group.add(stems,caps);
  // A silent observatory, with luminous inset strips rather than ordinary architecture.
  for(const [x,z,s,rotation] of [[-39,-62,1.4,-.24],[69,-87,2.1,.53]]){
    arch(group,x,heightAt(x,z),z,s,spec.color,rotation);
    for(const sign of [-1,1]){const lx=sign*4.375*s,lz=.625*s,c=Math.cos(rotation),sn=Math.sin(rotation);collision.addCollider({type:'box',x:x+lx*c+lz*sn,z:z-lx*sn+lz*c,halfX:.775*s,halfZ:.775*s,rotation,kind:'arch-post'});}
  }
  const structureMat=standard('#253d43',.76,.34),trim=standard(spec.color,.4,.3,{emissive:spec.color,emissiveIntensity:.35});
  for(let i=0;i<5;i++){let x=-77+i*11,z=-100-(i%2)*12,y=heightAt(x,z),h=9+(i%3)*5;const tower=mesh(new THREE.BoxGeometry(4.2,h,3.2),structureMat,group,x,y+h/2,z);tower.rotation.z=(i-2)*.025;tower.updateMatrix();addFootprint(tower.geometry,tower.matrix,x,z,'pillar');mesh(new THREE.BoxGeometry(.12,h*.7,.06),trim,group,x-1.35,y+h*.53,z-1.66);}
  collision.addCollider({type:'circle',x:0,z:-20,radius:4.3,kind:'archive-base'});
  const by=heightAt(0,-20),beacon=new THREE.Group();beacon.position.set(0,by,-20);group.add(beacon);
  const base=mesh(new THREE.CylinderGeometry(3.4,4.3,.65,8),structureMat,beacon,0,.2,0);mesh(new THREE.CylinderGeometry(2.7,3.15,.15,48),trim,beacon,0,.63,0);
  for(let i=0;i<3;i++){const a=i*TAU/3;const obelisk=mesh(new THREE.ConeGeometry(.43,4.7,4),structureMat,beacon,Math.cos(a)*2.35,2.55,Math.sin(a)*2.35);obelisk.rotation.z=Math.cos(a)*-.10;obelisk.rotation.x=Math.sin(a)*.10;}
  const beaconCore=mesh(new THREE.OctahedronGeometry(.77,0),standard('#defaed',.22,.45,{emissive:spec.color,emissiveIntensity:2.6}),beacon,0,2.45,0);
  const halo=mesh(new THREE.TorusGeometry(1.35,.032,6,64),new THREE.MeshBasicMaterial({color:spec.color,transparent:true,opacity:.75}),beacon,0,2.45,0);halo.rotation.x=Math.PI/2;
  const beam=mesh(new THREE.CylinderGeometry(.05,.20,29,12,1,true),new THREE.MeshBasicMaterial({color:spec.color,transparent:true,opacity:.18,depthWrite:false,blending:THREE.AdditiveBlending,side:THREE.DoubleSide}),beacon,0,16.8,0);
  const beaconGlow=createGlow(spec.color,7);beaconGlow.position.set(0,2.5,0);beaconGlow.material.opacity=.4;beacon.add(beaconGlow);
  // A landing disc with graphic concentric survey markings; all are flush with the surface.
  const sy=heightAt(0,25),pad=new THREE.Group();pad.position.set(0,sy+.03,25);group.add(pad);
  const padRing=mesh(new THREE.RingGeometry(8.9,9.08,96),new THREE.MeshBasicMaterial({color:theme.dust,side:THREE.DoubleSide,transparent:true,opacity:.48,depthWrite:false}),pad);padRing.rotation.x=-Math.PI/2;
  for(let i=0;i<4;i++){const a=i*Math.PI/2;const marker=mesh(new THREE.BoxGeometry(.2,.04,2),trim,pad,Math.cos(a)*10,0,Math.sin(a)*10);marker.rotation.y=-a;}
  const motesGeo=new THREE.BufferGeometry(),mp=new Float32Array(100*3);for(let i=0;i<100;i++)mp.set([(rnd()-.5)*110,2+rnd()*17,(rnd()-.5)*110],i*3);motesGeo.setAttribute('position',new THREE.BufferAttribute(mp,3));const motes=new THREE.Points(motesGeo,new THREE.PointsMaterial({color:theme.flora,size:.07,transparent:true,opacity:.65,depthWrite:false}));group.add(motes);
  // Keep the parked hull and both swept wings solid without blocking its boarding radius.
  const shipYaw=Math.PI*.2,shipPoint=(x,z)=>({x:x*Math.cos(shipYaw)+z*Math.sin(shipYaw),z:25-x*Math.sin(shipYaw)+z*Math.cos(shipYaw)});
  const nose=shipPoint(0,-5.9),tail=shipPoint(0,4.6);
  collision.addCollider({type:'capsule',ax:nose.x,az:nose.z,bx:tail.x,bz:tail.z,radius:1.15,kind:'parked-ship'});
  for(const sign of [-1,1])collision.addCollider({type:'polygon',points:[[sign*1.2,-2.5],[sign*2.7,-.5],[sign*6.8,3.4],[sign*6.55,4.65],[sign*2.75,2.6],[sign*1.08,3.6]].map(([x,z])=>shipPoint(x,z)),kind:'parked-ship'});
  const setParkedShip=(parkedShip)=>{
    for(const [id,collider] of collision.colliders)if(collider.kind==='parked-ship')collision.removeCollider(id);
    if(!parkedShip)return;
    parkedShip.updateWorldMatrix(true,true);
    parkedShip.traverse(part=>{if(part.isMesh&&part.visible&&!part.userData.flame)addFootprint(part.geometry,part.matrixWorld,parkedShip.position.x,parkedShip.position.z,'parked-ship');});
  };
  return {group,heightAt,resolveMovement:collision.resolveMovement,addCollider:collision.addCollider,removeCollider:collision.removeCollider,setParkedShip,colliders:collision.colliders,
    spawn:[0,heightAt(0,15),15],shipPosition:[0,sy+1.9,25],beaconPosition:[0,by,-20],
    update(time,dt){beaconCore.rotation.y=time*.4;beaconCore.rotation.z=Math.sin(time*.5)*.15;beaconCore.position.y=2.45+Math.sin(time*1.5)*.16;halo.rotation.z=time*.3;halo.rotation.x=Math.PI/2+Math.sin(time*.4)*.25;beaconGlow.material.opacity=.32+Math.sin(time*2)*.08;celestial.globe.rotation.y+=dt*.006;motes.rotation.y=Math.sin(time*.03)*.025;stars.material.uniforms.uTime.value=time;},dispose(){disposeGroup(group);}};
}
