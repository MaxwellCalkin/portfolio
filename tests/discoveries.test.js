import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DISCOVERIES, WORLD_ORDER, Journal, discoveriesFor, discoveryFor } from '../game/gameplay/discoveries.js';
import { CONTENT, PROJECTS, ESSAYS } from '../game/content.js';
import { LAYOUTS } from '../game/world/layout.js';

/** Node names (incl. extras.name) per root node of a GLB, read without three.js. */
function glbRoots(file) {
  const buf = readFileSync(new URL(`../public/models/${file}`, import.meta.url));
  const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
  const name = n => n.extras?.name || n.name || '';
  const roots = new Map();
  const walk = (i, out) => { out.push(name(json.nodes[i])); for (const c of json.nodes[i].children || []) walk(c, out); };
  for (const r of json.scenes[json.scene || 0].nodes) { const out = []; walk(r, out); roots.set(name(json.nodes[r]), out); }
  return roots;
}
const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('thirty-seven unique discoveries across five worlds, one main archive each', () => {
  assert.equal(DISCOVERIES.length, 37);
  assert.equal(new Set(DISCOVERIES.map(d => d.id)).size, 37);
  for (const world of WORLD_ORDER) {
    const list = discoveriesFor(world);
    assert.ok(list.length >= 6, `${world} has enough to find`);
    assert.equal(list.filter(d => d.kind === 'archive').length, 1);
    assert.equal(list.find(d => d.kind === 'archive').panel, world);
  }
});

test('every discovery quotes the existing portfolio copy verbatim', () => {
  const corpus = [
    ...Object.values(CONTENT).flatMap(c => [plain(c.title), plain(c.lede), plain(c.html)]),
    ...PROJECTS.flatMap(p => [p.name, p.tag, p.description, p.url]),
    ...ESSAYS.flatMap(e => [e.title, e.description, e.url]),
  ].join(' \n ');
  for (const d of DISCOVERIES) {
    for (const piece of [d.text, ...(d.list || []), ...(d.links || []).flatMap(l => [l.label, l.note, l.url]), d.link].filter(Boolean)) {
      if (/^(mailto:|https:\/\/(github|linkedin|x)\.com)/.test(piece)) continue; // contact links appear as hrefs
      const sentences = piece.split(/(?<=[.!?])\s+/);
      for (const s of sentences) assert.ok(corpus.includes(s.trim()), `${d.id}: "${s}" is not in content.js`);
    }
  }
});

test('every discovery lives on a placed landmark with a matching interaction point', () => {
  const shared = glbRoots('landmarks-shared.glb');
  for (const world of WORLD_ORDER) {
    const roots = glbRoots(`landmarks-${world}.glb`);
    const marks = new Map(LAYOUTS[world].landmarks.map(m => [m.id, m]));
    for (const mark of marks.values()) assert.ok((mark.shared ? shared : roots).has(mark.node), `${world}: node ${mark.node} exists`);
    for (const d of discoveriesFor(world)) {
      const mark = marks.get(d.landmark);
      assert.ok(mark, `${d.id}: landmark ${d.landmark} is placed`);
      const names = (mark.shared ? shared : roots).get(mark.node);
      const poi = d.poi || names.find(n => /^POI_(read|archive|arena)/.test(n));
      assert.ok(names.includes(poi), `${d.id}: ${mark.node} has ${poi}`);
      assert.equal(discoveryFor(world, d.landmark, poi), d);
    }
  }
});

test('the journal persists, ignores duplicates and survives broken storage', () => {
  const memory = new Map();
  const storage = { getItem: k => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v) };
  const journal = new Journal(storage);
  assert.equal(journal.discover('philosophy:origin'), true);
  assert.equal(journal.discover('philosophy:origin'), false);
  assert.equal(journal.addShard('philosophy:shard:1'), true);
  assert.equal(journal.addWarden('philosophy'), true);
  journal.data.arenaBest = 21.5; journal.data.riff = true; journal.save();
  const again = new Journal(storage);
  assert.deepEqual(again.progress('philosophy'), { found: 1, total: discoveriesFor('philosophy').length });
  assert.equal(again.data.shards.length, 1);
  again.reset();
  assert.equal(again.progress().found, 0);
  assert.equal(again.data.arenaBest, 21.5, 'records survive a reset');
  assert.equal(again.data.riff, true, 'the unlocked emote survives a reset');
  const broken = new Journal({ getItem: () => '{oops', setItem: () => { throw new Error('quota'); } });
  assert.equal(broken.discover('contact:signal'), true);
  assert.equal(broken.save(), false);
});
