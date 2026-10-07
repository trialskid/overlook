// Hub: freshness, slice ownership and the rebuild guard (v3.1 rules 1, 2 and 6). No server, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Guard, Hub, HEALTH_GRACE, healthReason } from '../../server/hub.ts';
import { maxAgeOf, type Adapter } from '../../server/adapters/types.ts';
import type { Raw } from '../../server/raw.ts';

/** An adapter whose next answer the test sets (a Partial<Raw>, an Error to throw, or a promise to hold). */
function fake(name: string, every = 15_000, extra: Partial<Adapter> = {}) {
  let next: Partial<Raw> | Error | Promise<Partial<Raw>> = {};
  const a: Adapter & { set(v: typeof next): void } = {
    name, label: name, every, configured: () => true,
    run: async () => { const v = next; if (v instanceof Error) throw v; return v; },
    set(v) { next = v; },
    ...extra,
  };
  return a;
}
function setup(adapters: Adapter[], o: { mock?: boolean; dev?: boolean } = {}) {
  const clock = { t: 1_000_000 };
  const logs: string[] = [];
  const hub = new Hub(adapters, { ...o, now: () => clock.t, log: m => logs.push(m) });
  return { hub, clock, logs };
}
const UNRAID = { arrayUsedTB: 31, arrayTB: 47, cacheUsedGB: 400, cacheGB: 1000, os: '7.3.2' };
const KUMA: Raw['kuma'] = [{ id: 30, name: 'Nextcloud', type: 'http', url: 'http://10.20.0.86:1337', hostname: null, port: null, status: 'up', ms: 12, up1d: 1, up30d: 1, certDays: null, cells: [], downSince: null }];

test('a stale adapter is dropped once its last good answer is older than maxAge', async () => {
  const a = fake('weather', 600_000);
  const { hub, clock } = setup([a]);
  a.set({ weather: { tempC: 12, text: 'cloudy' } });
  assert.equal(await hub.tick(a), 'ok');
  const t0 = clock.t;
  assert.deepEqual(hub.compose(t0 + maxAgeOf(a)).weather, { tempC: 12, text: 'cloudy' });
  assert.equal(hub.compose(t0 + maxAgeOf(a) + 1).weather, null);
  const v = hub.sourceViews(t0 + maxAgeOf(a) + 1)[0];
  assert.equal(v.conn, 'stale');
  assert.equal(v.ageSec, Math.round((maxAgeOf(a) + 1) / 1000));
});

test('a failing adapter keeps its part only until maxAge, and says why', async () => {
  const a = fake('kuma', 30_000);
  const { hub, clock } = setup([a]);
  a.set({ kuma: KUMA });
  await hub.tick(a);
  const t0 = clock.t;
  clock.t += 30_000;
  a.set(new Error('HTTP 401 from http://kuma:3001/metrics?apikey=SECRET123'));
  assert.equal(await hub.tick(a), 'error');
  assert.deepEqual(hub.compose(clock.t).kuma, KUMA); // still within 90 s
  let v = hub.sourceViews(clock.t)[0];
  assert.equal(v.conn, 'ok');
  assert.match(v.error!, /HTTP 401/);
  assert.doesNotMatch(v.error!, /SECRET123/);
  assert.equal(hub.compose(t0 + maxAgeOf(a) + 1).kuma, null);
  v = hub.sourceViews(t0 + maxAgeOf(a) + 1)[0];
  assert.equal(v.conn, 'stale');
  assert.match(v.error!, /401/);
});

test('an adapter that never answered is an error, an unconfigured one is not-connected', async () => {
  const a = fake('grafana'), b = fake('prowlarr', 60_000, { configured: () => false, needs: 'a Prowlarr API key' });
  const { hub } = setup([a, b]);
  a.set(new Error('connect ECONNREFUSED'));
  await hub.tick(a);
  assert.equal(await hub.tick(b), 'skipped');
  const [va, vb] = hub.sourceViews();
  assert.equal(va.conn, 'error');
  assert.equal(va.lastOk, null);
  assert.equal(vb.conn, 'not-connected');
  assert.equal(vb.needs, 'a Prowlarr API key');
});

test('prom-infra and kuma write different keys and never wipe each other', async () => {
  const prom = fake('prom-infra'), kuma = fake('kuma', 30_000);
  const { hub } = setup([prom, kuma]);
  prom.set({ unraid: UNRAID, hostStatus: { unraid: 'up' } });
  kuma.set({ kuma: KUMA });
  await hub.tick(prom); await hub.tick(kuma);
  prom.set({ unraid: { ...UNRAID, arrayUsedTB: 32 }, hostStatus: { unraid: 'up' } });
  await hub.tick(prom);
  const raw = hub.compose();
  assert.deepEqual(raw.kuma, KUMA);
  assert.equal(raw.unraid?.arrayUsedTB, 32);
  // v3 crash path: the Unraid exporter disappears (unraid: null), then Kuma answers
  prom.set({ unraid: null, hostStatus: { unraid: 'down' } });
  await hub.tick(prom); await hub.tick(kuma);
  const r2 = hub.compose();
  assert.equal(r2.unraid, null);
  assert.deepEqual(r2.kuma, KUMA);
});

test('a run replaces the adapter part: a key it stops writing goes away', async () => {
  const a = fake('prom-media');
  const { hub } = setup([a]);
  a.set({ sonarr: { series: 1, queued: 0, wanted: 0 }, nzbget: { todayGB: 2 } });
  await hub.tick(a);
  a.set({ sonarr: { series: 2, queued: 0, wanted: 0 } });
  await hub.tick(a);
  const raw = hub.compose();
  assert.equal(raw.sonarr?.series, 2);
  assert.equal(raw.nzbget, null);
});

test('MERGE_KEYS merge per entry across fresh adapters; null or stale ones erase only their own', async () => {
  const pve = fake('proxmox'), prom = fake('prom-infra'), mac = fake('mac', 30_000);
  const { hub, clock } = setup([pve, prom, mac]);
  pve.set({ hostStatus: { pve1: 'up', pve2: 'up' }, versions: { 'Proxmox · pve1': '9.2.20' }, jobs: { 'vzdump-pve1': { lastAt: 1, ok: true, days: null } } });
  prom.set({ hostStatus: { unraid: 'down' }, versions: { Unraid: '7.3.2' }, jobs: null });
  mac.set({ hostStatus: { mac: 'up' }, versions: null });
  await hub.tick(pve); await hub.tick(prom); await hub.tick(mac);
  let raw = hub.compose();
  assert.deepEqual(raw.hostStatus, { pve1: 'up', pve2: 'up', unraid: 'down', mac: 'up' });
  assert.deepEqual(raw.versions, { 'Proxmox · pve1': '9.2.20', Unraid: '7.3.2' });
  assert.deepEqual(Object.keys(raw.jobs ?? {}), ['vzdump-pve1']);
  // proxmox stops answering: its entries leave after maxAge, the others stay
  clock.t += maxAgeOf(pve) + 1;
  await hub.tick(prom); await hub.tick(mac);
  raw = hub.compose();
  assert.deepEqual(raw.hostStatus, { unraid: 'down', mac: 'up' });
  assert.deepEqual(raw.versions, { Unraid: '7.3.2' });
  assert.equal(raw.jobs, null);
});

test('two adapters writing the same plain key: later one wins, logged once in dev', async () => {
  const a = fake('a'), b = fake('b');
  const { hub, logs } = setup([a, b], { dev: true });
  a.set({ lanDevices: 1 }); b.set({ lanDevices: 2 });
  await hub.tick(a); await hub.tick(b);
  assert.equal(hub.compose().lanDevices, 2);
  hub.compose();
  assert.equal(logs.filter(l => l.includes('raw.lanDevices')).length, 1);
});

test('overlapping runs are skipped', async () => {
  let release!: (v: Partial<Raw>) => void;
  let runs = 0;
  const a = fake('probes', 300_000, { run: () => { runs++; return new Promise(r => { release = r; }); } });
  const { hub } = setup([a]);
  const first = hub.tick(a);
  assert.equal(await hub.tick(a), 'skipped');
  assert.equal(runs, 1);
  release({ probes: {} });
  assert.equal(await first, 'ok');
  const second = hub.tick(a);
  assert.equal(runs, 2);
  release({ probes: {} });
  assert.equal(await second, 'ok');
});

test('a run that hangs times out after max(every, 20 s) and frees the adapter', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = fake('slow', 5_000, { run: () => new Promise(() => {}) });
  const { hub } = setup([a]);
  const p = hub.tick(a);
  t.mock.timers.tick(19_999);
  assert.equal(hub.state.get('slow')!.inFlight, true);
  t.mock.timers.tick(1);
  assert.equal(await p, 'error');
  const s = hub.state.get('slow')!;
  assert.equal(s.err, 'timed out');
  assert.equal(s.inFlight, false);
});

test('errors are logged once per streak, recovery is logged', async () => {
  const a = fake('ntfy', 60_000);
  const { hub, logs } = setup([a]);
  a.set(new Error('HTTP 502'));
  await hub.tick(a); await hub.tick(a); await hub.tick(a);
  a.set({ ntfyUp: true });
  await hub.tick(a);
  assert.deepEqual(logs, ['[ntfy] HTTP 502', '[ntfy] ok again after 3 failed runs']);
});

test('an error that differs only in its timing is logged once', async () => {
  const a = fake('prom-infra');
  const { hub, logs } = setup([a]);
  for (const ms of [0, 3, 1]) { a.set(new Error(`curl: (7) Failed to connect to 127.0.0.1 port 9 after ${ms} ms`)); await hub.tick(a); }
  assert.equal(logs.length, 1);
});

test('mock mode reports every source as mock', () => {
  const { hub } = setup([fake('proxmox'), fake('kuma', 30_000, { configured: () => false })], { mock: true });
  assert.deepEqual(hub.sourceViews().map(v => v.conn), ['mock', 'mock']);
});

test('the rebuild guard keeps the last snapshot when derive throws', () => {
  const logs: string[] = [];
  const g = new Guard<{ at: number }>('rebuild', m => logs.push(m));
  assert.deepEqual(g.run(() => ({ at: 1 }), 1000), { at: 1 });
  const boom = () => { throw new TypeError("Cannot read properties of undefined (reading 'toFixed')"); };
  assert.deepEqual(g.run(boom, 2000), { at: 1 });
  assert.deepEqual(g.run(boom, 3000), { at: 1 });
  assert.equal(g.lastOk, 1000);
  assert.match(g.lastError!, /toFixed/);
  assert.equal(logs.length, 1); // once per distinct error
  assert.deepEqual(g.run(() => ({ at: 4 }), 4000), { at: 4 });
  assert.equal(g.lastError, null);
  assert.equal(g.lastOk, 4000);
});

test('healthz: 503 when the snapshot loop or every source has failed for 2 min, after the start grace', async () => {
  const a = fake('proxmox'), b = fake('kuma', 30_000);
  const { hub, clock } = setup([a, b]);
  const t0 = clock.t;
  // start grace: nothing has answered yet, still healthy
  assert.equal(healthReason(t0 + HEALTH_GRACE, hub, t0), null);
  // no rebuild for over 2 min
  assert.match(healthReason(t0 + HEALTH_GRACE + 1, hub, t0) ?? '', /snapshot/);
  // every source failing since start, snapshots fine
  const late = t0 + HEALTH_GRACE + 1;
  assert.match(healthReason(late, hub, late) ?? '', /all 2 sources/);
  // one source answering is enough
  clock.t = late;
  b.set({ kuma: [] });
  await hub.tick(b);
  assert.equal(healthReason(late + 1000, hub, late + 1000), null);
  // ... until it, too, has been stale for 2 min past its max age
  const dead = late + maxAgeOf(b) + HEALTH_GRACE + 1;
  assert.match(healthReason(dead, hub, dead) ?? '', /all 2 sources/);
});

test('an adapter whose modules are off is never polled, composed or listed, and is re-checked on every use', async () => {
  const a = fake('a'), b = fake('b');
  a.set({ unraid: UNRAID });
  let bOn = false;
  const clock = { t: 1_000_000 };
  const hub = new Hub([a, b], { now: () => clock.t, log: () => {}, enabled: x => x.name !== 'b' || bOn });
  assert.equal(await hub.tick(a), 'ok');
  assert.equal(await hub.tick(b), 'skipped');
  assert.deepEqual(hub.sourceViews().map(s => s.name), ['a']);
  bOn = true; // a config reload turned b's module on
  assert.equal(await hub.tick(b), 'ok');
  assert.deepEqual(hub.sourceViews().map(s => s.name), ['a', 'b']);
});
