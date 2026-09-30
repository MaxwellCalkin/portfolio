import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createLoop, updateLoop, crossesRing, segmentSphereHitTime, createSpacePlayground } from '../game/space-playground.js';

const v = (x=0,y=0,z=0) => new THREE.Vector3(x,y,z);
const near = (a,b,eps=1e-8) => assert.ok(Math.abs(a-b)<eps,`${a} differs from ${b}`);
const nearVector = (a,b,eps=1e-8) => assert.ok(a.distanceTo(b)<eps,`${a.toArray()} differs from ${b.toArray()}`);

test('Evasive Loop is a complete continuous backward loop with identical entry/exit heading and speed', () => {
  const position=v(140,-60,913), direction=v(-.6,.2,-.7).normalize();
  const originalPosition=position.clone(),originalDirection=direction.clone();
  for (const speed of [8,30,120,340,450]) {
    const loop=createLoop(position,direction,speed);
    const initial=updateLoop(loop,0);
    nearVector(initial.position,position);nearVector(initial.direction,direction);near(initial.speed,speed);
    const opposite=updateLoop(loop,loop.duration/2);
    nearVector(opposite.direction,direction.clone().negate());
    nearVector(opposite.position,position.clone().addScaledVector(loop.up,2*loop.radius));
    assert.equal(opposite.done,false);
    const end=updateLoop(loop,loop.duration/2);
    nearVector(end.position,position);nearVector(end.direction,direction);nearVector(end.up,loop.up);
    assert.equal(end.done,true);near(end.speed,speed);
    nearVector(v(0,0,-1).applyQuaternion(end.quaternion),direction);
    nearVector(updateLoop(loop,100).position,end.position);
  }
  nearVector(position,originalPosition);nearVector(direction,originalDirection);
});

test('loop frame integration is partition invariant and arc velocity preserves entry speed', () => {
  const slow=createLoop(v(),v(0,0,-1),340),fast=createLoop(v(),v(0,0,-1),340);
  const single=updateLoop(slow,.63);
  let result;for(let i=0;i<63;i++)result=updateLoop(fast,.01);
  nearVector(single.position,result.position);nearVector(single.direction,result.direction);
  const duration=fast.duration,steps=10000,h=duration/steps;
  const loop=createLoop(v(),v(0,0,-1),120);let before=updateLoop(loop,0);let distance=0;
  for(let i=0;i<steps;i++){
    const next=updateLoop(loop,h);distance+=next.position.distanceTo(before.position);
    near(next.direction.length(),1);near(next.up.dot(next.direction),0);
    nearVector(v(0,0,-1).applyQuaternion(next.quaternion),next.direction);
    before=next;
  }
  near(distance,120*duration,.00002);
});

test('loop handles vertical starts, rejects rest and invalid speed, and ignores negative dt', () => {
  for(const direction of [v(0,1,0),v(0,-1,0),v(0,1,.00001)]){
    const loop=createLoop(v(),direction,120);const result=updateLoop(loop,.4);
    assert.ok(result.position.toArray().every(Number.isFinite));near(result.up.dot(result.direction),0);
  }
  assert.equal(createLoop(v(),v(0,0,-1),0),null);
  assert.equal(createLoop(v(),v(0,0,-1),7.99),null);
  assert.equal(createLoop(v(),v(0,0,-1),Infinity),null);
  assert.equal(createLoop(v(),v(),120),null);
  const loop=createLoop(v(),v(0,0,-1),120);nearVector(updateLoop(loop,-1).position,v());
});

test('ring aperture requires a swept crossing and works at boost speed in either direction',()=>{
  const c=v(),normal=v(0,0,1);
  assert.equal(crossesRing(v(0,0,100),v(0,0,-100),c,normal,40),true);
  assert.equal(crossesRing(v(0,0,-100),v(0,0,100),c,normal,40),true);
  assert.equal(crossesRing(v(39,0,100),v(39,0,-100),c,normal,40),true);
  assert.equal(crossesRing(v(41,0,100),v(41,0,-100),c,normal,40),false);
  assert.equal(crossesRing(v(0,0,100),v(0,0,1),c,normal,40),false);
  assert.equal(crossesRing(v(0,0,0),v(0,0,100),c,normal,40),false);
  assert.equal(crossesRing(v(0,0,1),v(0,0,0),c,normal,40),true);
  assert.equal(crossesRing(v(0,0,1),v(30,0,1),c,normal,40),false);
});

test('ring crossing is invariant under rotation and world translation',()=>{
  const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(.8,.4,.2)),offset=v(160,-90,2500);
  const transform=p=>p.applyQuaternion(q).add(offset);
  assert.equal(crossesRing(transform(v(20,4,80)),transform(v(20,4,-80)),offset,v(0,0,1).applyQuaternion(q),40),true);
  assert.equal(crossesRing(transform(v(41,4,80)),transform(v(41,4,-80)),offset,v(0,0,1).applyQuaternion(q),40),false);
});

test('swept sphere returns earliest impact and rejects line extensions',()=>{
  near(segmentSphereHitTime(v(-10),v(10),v(),2),.4);
  near(segmentSphereHitTime(v(),v(10),v(),2),0);
  near(segmentSphereHitTime(v(-10,2),v(10,2),v(),2),.5);
  assert.equal(segmentSphereHitTime(v(-10,2.01),v(10,2.01),v(),2),null);
  assert.equal(segmentSphereHitTime(v(10),v(20),v(),2),null);
  assert.equal(segmentSphereHitTime(v(-20),v(-10),v(),2),null);
  assert.equal(segmentSphereHitTime(v(10),v(10),v(),2),null);
});

test('combat hits nearest ship once, awards a real destruction, and resets pooled entities',()=>{
  let kills=0;const playground=createSpacePlayground(new THREE.Scene(),{onEnemyDestroyed:()=>kills++});
  for(const e of playground.enemies)e.alive=false;
  const [far,nearby]=playground.enemies;
  far.alive=true;far.mesh.position.set(0,0,-160);nearby.alive=true;nearby.mesh.position.set(0,0,-60);
  assert.equal(playground.tryHitSegment(v(),v(0,0,-300),1000),true);
  assert.equal(nearby.alive,false);assert.equal(far.alive,true);assert.equal(kills,1);
  assert.equal(playground.tryHitSegment(v(),v(0,0,-90),1000),false);assert.equal(kills,1);
  playground.reset();assert.ok(playground.enemies.every(e=>e.alive&&e.hp===e.maxHp));
  playground.dispose();assert.equal(playground.group.parent,null);
  assert.equal(playground.tryHitSegment(v(),v(0,0,-300),1000),false);
  assert.equal(playground.shoot(v(),v(0,0,-1)),false);
});

test('gates grant boost only on actual passage, with cooldown and teleport protection',()=>{
  const boosts=[];const playground=createSpacePlayground(new THREE.Scene(),{onBoost:e=>boosts.push(e)});
  const ring=playground.rings[0],forward=ring.normal.clone();
  const before=ring.position.clone().addScaledVector(forward,-15),after=ring.position.clone().addScaledVector(forward,15);
  playground.update(.05,0,before,forward,340);assert.equal(boosts.length,0);
  playground.update(.05,.05,after,forward,340);assert.equal(boosts.length,1);assert.equal(boosts[0].duration,3.4);
  playground.update(.05,.1,before,forward,340);assert.equal(boosts.length,1);
  playground.reset();
  playground.update(.05,0,ring.position.clone().addScaledVector(forward,-800),forward,340);
  playground.update(.05,.05,ring.position.clone().addScaledVector(forward,800),forward,340);
  assert.equal(boosts.length,1);
  playground.dispose();
});

test('world geometry remains inside budget and resources are shared',()=>{
  const playground=createSpacePlayground(new THREE.Scene());let triangles=0;const unique=new Set();let instances=0;
  playground.group.traverse(o=>{if(o.geometry){triangles+=(o.geometry.index?.count||o.geometry.attributes.position.count)/3*(o.isInstancedMesh?o.count:1);unique.add(o.geometry);instances++;}});
  assert.ok(triangles<50000,`playground adds ${triangles} triangles`);
  assert.ok(unique.size<30,`uses ${unique.size} geometries`);assert.ok(instances>250);
  assert.equal(playground.enemies.length,12);assert.equal(playground.rings.length,14);
  const resources=[...unique];let disposals=0;for(const geometry of resources)geometry.addEventListener('dispose',()=>disposals++);
  playground.dispose();assert.equal(disposals,resources.length);playground.dispose();assert.equal(disposals,resources.length);
});

test('enemy movement stays finite, opponents fire real bolts, and pooled player shots damage ships',()=>{
  let damage=0;const scene=new THREE.Scene();const playground=createSpacePlayground(scene,{onPlayerDamage:amount=>damage+=amount});
  for(const enemy of playground.enemies){enemy.alive=false;enemy.respawnTimer=999;}
  const enemy=playground.enemies[0];enemy.alive=true;enemy.mesh.visible=true;enemy.mesh.position.set(0,0,-200);
  enemy.mesh.quaternion.setFromUnitVectors(v(0,0,-1),v(0,0,1));enemy.direction.set(0,0,1);enemy.shootTimer=0;
  const startHp=enemy.hp;playground.shoot(v(),v(0,0,-1),20);
  for(let i=0;i<600;i++)playground.update(1/60,i/60,v(),v(0,0,-1),0);
  assert.ok(enemy.hp<startHp,'player shots hit the ship');
  assert.ok(damage>0,'a hostile bolt hit the player');
  assert.ok(enemy.mesh.position.toArray().every(Number.isFinite));
  playground.dispose();
});
