import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSphericalTerrain } from '../game/spherical-terrain.js';
import { createSphericalWorldCatalog } from '../game/spherical-world-catalog.js';
import { createWorldPopulation, POPULATION_LIMIT } from '../game/world-population.js';

function fixture(id='test',radius=1500) {
  const terrain=createSphericalTerrain({id,radius,position:[-22050,2625,-30450],terrainSegments:{width:64,height:40}});
  const catalog=createSphericalWorldCatalog(terrain);
  return {...terrain,nearbySectors:catalog.nearbySectors,nearestShrine:catalog.nearestShrine,shipPosition:terrain.patchPoint(0,25),worldCatalog:catalog};
}
function harness(surfaces) {
  const objects=new Map(),spawned=[],removed=[];
  const manager=createWorldPopulation(surfaces,{spawn(record){
    const enemy={...record,mesh:{position:record.position.clone()},surface:record.surface};objects.set(record.id,enemy);spawned.push(record.id);return enemy;
  },despawn(enemy){objects.delete(enemy.id);removed.push(enemy.id);}});
  const tick=(focus,surface,time,enabled=true)=>{for(let i=0;i<12;i++)manager.update(focus,surface,time+i/60,enabled);};
  return {manager,objects,spawned,removed,tick};
}

test('global habitats populate poles and arbitrary landing positions with a bounded local population',()=>{
  const surf=fixture(),{manager,objects,tick}=harness([surf]);
  const directions=[new THREE.Vector3(0,1,0),new THREE.Vector3(0,-1,0),new THREE.Vector3(1,0,0),new THREE.Vector3(-1,.6,.3).normalize(),new THREE.Vector3(.2,-.4,.8).normalize()];
  directions.forEach((direction,i)=>{
    const focus=surf.center.clone().addScaledVector(direction,surf.radiusAt(direction));tick(focus,surf,i,true);
    assert.ok(objects.size>=3,`landing ${i}: ${objects.size} creatures`);assert.ok(objects.size<=POPULATION_LIMIT);
    for(const enemy of objects.values()){
      assert.ok(enemy.mesh.position.distanceTo(focus)<=170);assert.ok(Math.abs(surf.altitudeAt(enemy.mesh.position))<.00001);
      assert.ok(surf.nearestShrine(enemy.mesh.position).distance>=15.9);
    }
  });
});

test('streaming preserves damage and defeated habitat IDs when returning, and reset starts a fresh run',()=>{
  const surf=fixture(),{manager,objects,spawned,tick}=harness([surf]),focus=surf.spawn??surf.patchPoint(0,15);
  tick(focus,surf,0,true);const first=[...objects.values()],victim=first[0],survivor=first[1];
  manager.markDefeated(victim.id);objects.delete(victim.id);survivor.hp=17;survivor.mesh.position.addScaledVector(surf.frameAt(survivor.mesh.position).right,2);
  const survivorPosition=survivor.mesh.position.clone();manager.update(focus,surf,1,false);assert.equal(objects.size,0);
  tick(focus,surf,2,true);assert.equal(objects.has(victim.id),false);assert.equal(objects.get(survivor.id).hp,17);assert.ok(objects.get(survivor.id).mesh.position.equals(survivorPosition));
  const count=spawned.length;manager.update(focus,surf,2.1,true);assert.equal(spawned.length,count);
  manager.reset();assert.equal(objects.size,0);assert.equal(manager.getStats().defeatedCount,0);tick(focus,surf,3,true);assert.ok(objects.has(victim.id));
});

test('habitat positions and species are deterministic across runs and independent of activation order',()=>{
  const surf=fixture(),first=harness([surf]),second=harness([surf]),focus=surf.patchPoint(0,15);
  first.tick(focus,surf,0);second.tick(surf.center.clone().add(new THREE.Vector3(0,-1500,0)),surf,0);second.tick(focus,surf,1);
  const list=h=>[...h.objects.values()].map(e=>[e.id,e.species,e.mesh.position.toArray()]).sort((a,b)=>a[0].localeCompare(b[0]));assert.deepEqual(list(first),list(second));
});

test('switching worlds and high orbit releases every old creature without awarding a kill',()=>{
  const a=fixture('a'),b=fixture('b',2100),{manager,objects}=harness([a,b]);manager.update(a.patchPoint(0,15),a,0);assert.ok(objects.size);
  manager.update(b.patchPoint(0,15),b,1);for(const enemy of objects.values())assert.equal(enemy.surface,b);
  manager.update(b.patchPoint(0,15,1000),b,2,false);assert.equal(objects.size,0);assert.equal(manager.getStats().defeatedCount,0);
});

test('fresh regions instantiate no more than one detailed model per rendered update',()=>{
  const surf=fixture(),{manager,spawned}=harness([surf]),focus=surf.groundAt(surf.center.clone().add(new THREE.Vector3(0,surf.radius,0)));
  for(let frame=0;frame<24;frame++){
    const before=spawned.length;manager.update(focus,surf,frame/60,true);assert.ok(spawned.length-before<=1);
  }
  const eligible=manager.descriptors(surf,focus).filter(item=>{const distance=item.position.distanceTo(focus);return distance>=14&&distance<=170;}).length;
  assert.equal(manager.getStats().activeCount,Math.min(POPULATION_LIMIT,eligible));
});
