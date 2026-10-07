// The network map's geometry and pill keys (src/map/layout.ts): leaf columns, stable keys as leaves come and go, any
// number of hosts, with or without a gateway and switch. Run: node --import tsx --test tests/server/map-layout.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derive } from '../../server/derive.ts';
import { mockRaw } from '../../server/adapters/mock.ts';
import { config } from '../../server/config.ts';
import { layoutMap, MAP } from '../../src/map/layout.ts';
import type { HostView, LeafView } from '../../shared/types.ts';

const base = derive(mockRaw(config), [], { mock: true, incident: false, build: 'test' }, config).hosts[0];
const leaf = (j: number): LeafView => ({ key: `l${j}`, kind: 'lxc', tag: String(100 + j), name: `guest ${j}`, count: '', public: false, status: 'up' });
const fakeHost = (i: number, leaves = 3): HostView => ({ ...base, id: `h${i}`, name: `host ${i}`, leaves: Array.from({ length: leaves }, (_, j) => leaf(j)) });
const keysOf = (L: ReturnType<typeof layoutMap>, host: string) => L.leaves.filter(l => l.hostId === host).map(l => l.key);

test('8 leaves: one compact column at the 26px pitch, all inside the canvas; 9 and more go to two columns', () => {
  const L = layoutMap([fakeHost(0), fakeHost(1, 8), fakeHost(2)]);
  const eight = L.leaves.filter(l => l.hostId === 'h1');
  assert.ok(eight.every(l => l.compact));
  assert.deepEqual(eight.map(l => l.y), Array.from({ length: 8 }, (_, j) => MAP.LEAF_Y + j * MAP.COMPACT_PITCH));
  assert.ok(Math.max(...L.leaves.map(l => l.y + (l.compact ? 11 : 14))) <= L.H - 30, 'the lowest pill clears the bottom');
  assert.equal(new Set(L.leaves.map(l => `${l.hostId}/${l.leaf.key}`)).size, L.leaves.length); // no second copy of a pill
  const nine = layoutMap([fakeHost(0, 9)]).leaves;
  assert.equal(new Set(nine.map(l => l.x)).size, 2);
  assert.ok(layoutMap([fakeHost(0, 7)]).leaves.every(l => !l.compact));
});

test('pill keys are host:leaf, unique, and a leaf coming or going on one host never re-keys another host', () => {
  const full = layoutMap([fakeHost(0, 5), fakeHost(1, 8), fakeHost(2, 4)]);
  assert.equal(new Set(full.leaves.map(l => l.key)).size, full.leaves.length);
  assert.ok(keysOf(full, 'h1').includes('h1:l7'));
  const less = layoutMap([fakeHost(0, 4), fakeHost(1, 8), fakeHost(2, 4)]);
  assert.equal(keysOf(less, 'h0').length, 4);
  for (const h of ['h1', 'h2']) assert.deepEqual(keysOf(less, h), keysOf(full, h), h);
  // 8 → 7 (one column at 32px): the 7 that stay keep their keys
  const seven = layoutMap([fakeHost(0, 5), fakeHost(1, 7), fakeHost(2, 4)]);
  assert.deepEqual(keysOf(seven, 'h1'), keysOf(full, 'h1').filter(k => k !== 'h1:l7'));
});

test('two leaves with the same key on one host still get distinct pill keys', () => {
  const h = fakeHost(0, 3), twin = { ...h, leaves: [...h.leaves, { ...h.leaves[0] }] };
  const keys = keysOf(layoutMap([twin]), 'h0');
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(keys[keys.length - 1], `${keys[0]}#2`);
});

// ---- any number of hosts, with or without a gateway and switch
const overlaps = (L: ReturnType<typeof layoutMap>) => L.hosts.some((a, i) => L.hosts.some((b, j) => i < j && a.top === b.top && Math.abs(a.cx - b.cx) < MAP.HOST_W));

test('1, 4, 5 and 9 hosts: at most four a row, no two nodes overlapping, every node and pill inside the canvas', () => {
  for (const n of [1, 4, 5, 9]) {
    const L = layoutMap(Array.from({ length: n }, (_, i) => fakeHost(i)));
    const rows = [...new Set(L.hosts.map(h => h.top))];
    assert.equal(rows.length, Math.ceil(n / MAP.PER_ROW), `${n} hosts: rows`);
    assert.ok(rows.every(t => L.hosts.filter(h => h.top === t).length <= MAP.PER_ROW));
    assert.ok(!overlaps(L), `${n} hosts: no overlap`);
    assert.ok(L.hosts.every(h => h.left >= 0 && h.left + MAP.HOST_W <= MAP.W), `${n} hosts: inside the width`);
    assert.ok(Math.max(...L.leaves.map(l => l.y + 14)) <= L.H - 30, `${n} hosts: the lowest pill clears the bottom`);
    // a later row sits below every pill of the row above
    for (let r = 1; r < rows.length; r++) assert.ok(Math.max(...L.leaves.filter(l => L.hosts.find(h => h.host.id === l.hostId)!.top === rows[r - 1]).map(l => l.y)) < rows[r] - 40);
    // each host has its own path from the trunk (the failure trace and the packets follow it)
    assert.equal(new Set(L.hosts.map(h => h.curve)).size, n);
  }
});

test('no gateway or switch: the trunk runs straight from the Internet pill to the fan-out', () => {
  assert.equal(layoutMap([fakeHost(0)], { gateway: false, switch: false }).trunkD.split(' M')[0], `M${MAP.GX},42 L${MAP.GX},228`);
  assert.ok(layoutMap([fakeHost(0)], { gateway: true, switch: false }).trunkD.startsWith(`M${MAP.GX},42 L${MAP.GX},78 M${MAP.GX},134 L${MAP.GX},228`));
  assert.ok(layoutMap([fakeHost(0)]).trunkD.startsWith(`M${MAP.GX},42 L${MAP.GX},78 M${MAP.GX},134 L${MAP.GX},172`)); // both: unchanged
});
