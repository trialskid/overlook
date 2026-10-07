// LiveSampler against a fake Prometheus on 127.0.0.1: gaps stay gaps, failures and old values read null.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

for (const k of Object.keys(process.env)) if (/^PVE_/.test(k)) delete process.env[k]; // Prometheus only
let mode: 'ok' | 'fail' | 'hang' | 'cut' = 'ok';
let asked = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  asked++;
  if (mode === 'hang') return;
  // headers and half a body, then the connection drops: node's http client used to wait for 'end' forever
  if (mode === 'cut') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '500' }); res.write('{"status":"succ'); setTimeout(() => res.socket?.destroy(), 20); return; }
  if (mode === 'fail') { res.writeHead(500); res.end('boom'); return; }
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname === '/api/v1/query_range') {
    const start = Number(u.searchParams.get('start')), q = u.searchParams.get('query')!;
    // node-nas CPU has a 10 s hole in the middle; WAN has no series at all
    const values = q.includes('node-nas') ? Array.from({ length: 40 }, (_, i) => i).filter(i => i < 10 || i >= 20).map(i => [start + i, String(10 + i)]) : null;
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: values ? [{ metric: {}, values }] : [] } }));
    return;
  }
  // batched instant query: one row per k
  const rows = ['cpu:nas', 'wanIn', 'wanOut', 'qbDl', 'qbUl', 'nzDl'].map((k, i) => ({ metric: { k }, value: [Date.now() / 1000, String(i + 1.234)] }));
  res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: rows } }));
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
process.env.PROMETHEUS_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
delete process.env.CC_FETCH;
after(() => { server.closeAllConnections(); server.close(); });
const { LiveSampler, tidy } = await import('../../server/live.ts');

test('tidy: one decimal, null for anything not finite', () => {
  assert.equal(tidy(12.345), 12.3);
  assert.equal(tidy(null), null);
  assert.equal(tidy(undefined), null);
  assert.equal(tidy(NaN), null);
  assert.equal(tidy(Infinity), null);
});

test('prefill keeps the steps Prometheus has no value for as null', async () => {
  const pre = await new LiveSampler().prefill(40);
  assert.equal(pre['cpu:nas']?.length, 40);
  assert.deepEqual(pre['cpu:nas']!.slice(8, 12), [18, 19, null, null]);
  assert.deepEqual(pre['cpu:nas']!.slice(18, 22), [null, null, 30, 31]);
  assert.deepEqual(pre.wanIn, Array(40).fill(null));
});

test('a failing Prometheus reads null at once, never its last value', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  mode = 'ok';
  const s = new LiveSampler();
  s.setViewers(1);
  const a = await s.sample();
  assert.equal(a.cpu.nas, 1.2);
  assert.equal(a.qbUl, 5.2);
  assert.equal(a.cpu.pve1, null); // no Proxmox token: no data, not a guess
  mode = 'fail';
  t.mock.timers.tick(4001); // past the 4 s Prometheus interval
  const b = await s.sample();
  assert.deepEqual([b.cpu.nas, b.wanIn, b.wanOut, b.qbDl, b.qbUl, b.nzDl], [null, null, null, null, null, null]);
});

test('a value older than 20 s reads null while the next answer is still pending', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  mode = 'ok';
  const s = new LiveSampler();
  s.setViewers(1);
  assert.equal((await s.sample()).wanIn, 2.2);
  mode = 'hang';
  t.mock.timers.tick(10_000);
  assert.equal((await s.sample()).wanIn, 2.2); // 10 s old: still current (Prometheus scrapes every 15 s)
  t.mock.timers.tick(10_001);
  assert.equal((await s.sample()).wanIn, null);
});

test('an answer cut mid-body fails the sample and the next one asks again (never wedged)', async () => {
  mode = 'cut';
  const s = new LiveSampler();
  s.setViewers(1);
  const a = await s.sample();
  assert.equal(a.wanIn, null);
  await new Promise(r => setTimeout(r, 300)); // the cut lands; the 1 s backoff starts
  mode = 'ok';
  await new Promise(r => setTimeout(r, 1100));
  const before = asked;
  const b = await s.sample();
  assert.ok(asked > before, 'asked Prometheus again');
  assert.equal(b.wanIn, 2.2);
});

test('with nobody watching, Prometheus is asked every 15 s instead of every 4 s', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  mode = 'ok';
  const s = new LiveSampler();
  await s.sample();
  const before = asked;
  t.mock.timers.tick(5000);
  await s.sample();
  assert.equal(asked, before, 'not yet');
  t.mock.timers.tick(10_001);
  await s.sample();
  assert.equal(asked, before + 1);
  s.setViewers(1); // a viewer arrives: due at once
  await s.sample();
  assert.equal(asked, before + 2);
});
