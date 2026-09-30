import test from 'node:test';import assert from 'node:assert/strict';import * as THREE from 'three';
import {createLoop,updateLoop} from '../game/space-playground.js';
import {CHASE_OFFSET,CHASE_ROTATION,captureChaseMount,chaseCameraPose} from '../game/chase-camera.js';
const near=(a,b,eps=1e-7)=>assert.ok(a.distanceTo(b)<eps);
test('camera remains rigidly behind ship through both vertical poles and full loop',()=>{const loop=createLoop(new THREE.Vector3(),new THREE.Vector3(0,0,-1),240);let previous;for(let i=0;i<=240;i++){const step=updateLoop(loop,i?loop.duration/240:0),pose=chaseCameraPose(step.position,step.quaternion);const inverse=step.quaternion.clone().invert();near(pose.position.clone().sub(step.position).applyQuaternion(inverse),CHASE_OFFSET);assert.ok(inverse.multiply(pose.quaternion).angleTo(CHASE_ROTATION)<1e-6);if(previous)assert.ok(previous.angleTo(pose.quaternion)<.04,'camera orientation must not flip at a pole');previous=pose.quaternion;}});
test('quarter/half/three-quarter orientations follow ship up, rather than world up',()=>{const loop=createLoop(new THREE.Vector3(),new THREE.Vector3(0,0,-1),300);const up=[];for(let i=0;i<4;i++){const step=updateLoop(loop,loop.duration/4),pose=chaseCameraPose(step.position,step.quaternion);near(pose.up,step.up);up.push(pose.up);}assert.ok(up[1].y<-.999);assert.ok(up[3].y>.999);});
test('entry mount is continuous and blends to fixed mount without an entry or exit cut',()=>{const p=new THREE.Vector3(3,7,-4),q=new THREE.Quaternion().setFromEuler(new THREE.Euler(.2,.7,.3));const pose=chaseCameraPose(p,q);const customPosition=pose.position.clone().add(new THREE.Vector3(.3,.2,-.6));const mount=captureChaseMount(customPosition,pose.quaternion,p,q);near(chaseCameraPose(p,q,mount,0).position,customPosition);const end=chaseCameraPose(p,q,mount,.22);near(end.position,pose.position);assert.ok(end.quaternion.angleTo(pose.quaternion)<1e-6)});
test('banked entry roll is preserved throughout the loop and restored at exit',()=>{const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(.23,.6,.4,'YXZ')),forward=new THREE.Vector3(0,0,-1).applyQuaternion(q),up=new THREE.Vector3(0,1,0).applyQuaternion(q);const loop=createLoop(new THREE.Vector3(),forward,420,up);const start=updateLoop(loop,0),end=updateLoop(loop,loop.duration);assert.ok(start.quaternion.angleTo(q)<1e-6);assert.ok(end.quaternion.angleTo(q)<1e-6);assert.equal(end.speed,420)});

test('a reverse-velocity loop retains the ship nose frame and signed momentum',()=>{
 const entry=new THREE.Quaternion().setFromEuler(new THREE.Euler(.31,-.7,.22,'YXZ'));
 const nose=new THREE.Vector3(0,0,-1).applyQuaternion(entry),up=new THREE.Vector3(0,1,0).applyQuaternion(entry);
 const loop=createLoop(new THREE.Vector3(80,-13,90),nose.clone().negate(),148,up);
 const halfTurn=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI);
 let previous=null,result;
 for(let i=0;i<=240;i++){
  result=updateLoop(loop,i?loop.duration/240:0);const ship=result.quaternion.clone().multiply(halfTurn);
  const pose=chaseCameraPose(result.position,ship);const local=pose.position.clone().sub(result.position).applyQuaternion(ship.clone().invert());
  assert.ok(local.distanceTo(CHASE_OFFSET)<1e-10);assert.equal(-result.speed,-148);
  if(previous)assert.ok(previous.angleTo(pose.quaternion)<.04);previous=pose.quaternion.clone();
  if(i===0)assert.ok(ship.angleTo(entry)<1e-7);
 }
 assert.ok(result.quaternion.clone().multiply(halfTurn).angleTo(entry)<1e-7);
});
