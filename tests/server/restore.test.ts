// The Restore tab (homelab.json restore, module restore): config checks, derive on made-up reads, the module hiding
// without items, and the example lab's list. Look only: it never raises a Needs attention item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, normalize } from '../../server/config.ts';
import { derive } from '../../server/derive.ts';
import { deriveRestore, CANT_READ, NONE_FOUND, RESTORE_NOTE } from '../../server/derive/restore.ts';
import { mockRaw } from '../../server/adapters/mock.ts';
import { moduleStates } from '../../server/modules.ts';
import { emptyRaw, type Raw } from '../../server/raw.ts';
import { visibleMTabs, visibleTabs } from '../../src/lib/modules.ts';
import type { HomelabConfig, JobView, RestoreConfig, SourceView } from '../../shared/types.ts';
import type { JobState } from '../../server/derive/jobs.ts';
import type { Adapter } from '../../server/adapters/types.ts';

const NOW = Date.UTC(2026, 10, 18, 12, 0, 0), H = 3600e3, S = (msAgo: number) => (NOW - msAgo) / 1000;
const base = { domain: 'lab.example.com', hosts: [], network: { subnet: '10.20.0.0/24' } };
const raw = (restore: Raw['restore']): Raw => ({ ...emptyRaw(), restore });
const fresh = () => NOW - 30e3;
const run = (rc: RestoreConfig, r: Raw, jobs: JobState[] = [], lastOk: (s: string) => number | null = fresh) => deriveRestore({ restore: rc }, r, jobs, lastOk, NOW)!;
const one = (rc: RestoreConfig, r: Raw, jobs?: JobState[]) => run(rc, r, jobs).items[0];
const jobState = (id: string, lastAts: (number | null)[]): JobState => ({
  job: { id, name: id, group: 'backup', where: '', schedule: '', maxAgeH: 30, signal: 'proxmox-vzdump' }, status: 'up', source: 'proxmox',
  rows: lastAts.map((lastAt, i) => ({ id: `${id}:${i}`, name: id, group: 'backup', where: '', schedule: '', status: 'up', lastAt, lastAgo: '', detail: '', days: null, signal: 'proxmox-vzdump' }) as JobView),
});

test('config: only https, http and tg links; a bad scheme is refused like other bad config', () => {
  const ok = { ...base, restore: { ask: { url: 'tg://msg?text=restore%20{n}' }, runbook: 'https://git.lab.example.com/r.md', items: [{ id: 'a', name: 'A', link: 'http://wiki.lab.example.com/a' }] } };
  assert.doesNotThrow(() => normalize(ok));
  assert.throws(() => normalize({ ...base, restore: { ask: { url: 'javascript:alert(1)' }, items: [] } }), /restore\.ask\.url .* not an https, http or tg link/);
  assert.throws(() => normalize({ ...base, restore: { runbook: 'file:///etc/passwd', items: [] } }), /restore\.runbook/);
  assert.throws(() => normalize({ ...base, restore: { items: [{ id: 'a', name: 'A', link: 'data:text/html,hi' }] } }), /restore item a link/);
  assert.throws(() => normalize({ ...base, restore: { items: [{ id: 'a', name: 'A', proof: 'tested' }] } }), /proof tested/);
  assert.throws(() => normalize({ ...base, restore: { items: [{ id: 'a', name: 'A', proofOn: 'Oct 2' }] } }), /proofOn/);
  assert.throws(() => normalize({ ...base, restore: { items: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] } }), /used twice/);
  assert.throws(() => normalize({ ...base, restore: { items: 'a' } }), /items list/);
});

test('derive: several series read as the oldest; a short count is flagged; the newest copy is never guessed', () => {
  const rc: RestoreConfig = { items: [{ id: 'off', name: 'Off-site', newest: 'q', expect: 4, unit: 'sources' }] };
  const it = one(rc, raw({ off: { newest: [S(2 * H), S(9 * H), S(5 * H)], proofAt: null } }));
  assert.equal(it.newest, NOW - 9 * H);
  assert.deepEqual(it.series, { read: 3, expected: 4, unit: 'sources' });
  assert.equal(it.short, true);
  assert.equal(it.stale, false);
  assert.equal(it.why, null);
  assert.equal(it.n, 1);
  assert.equal(run(rc, raw({})).readAt, NOW - 30e3); // when Prometheus last answered
});

test('derive: a vector of 7 with expect 7 is 7/7; a vector of 5 is 5/7 and flagged', () => {
  const rc: RestoreConfig = { items: [{ id: 'g', name: 'Guests', newest: 'q', expect: 7, unit: 'guests' }] };
  const seven = one(rc, raw({ g: { newest: [1, 2, 3, 4, 5, 6, 7].map(h => S(h * H)), proofAt: null } }));
  assert.equal(seven.newest, NOW - 7 * H);
  assert.deepEqual(seven.series, { read: 7, expected: 7, unit: 'guests' });
  assert.equal(seven.short, false);
  const five = one(rc, raw({ g: { newest: [1, 2, 3, 4, 5].map(h => S(h * H)), proofAt: null } }));
  assert.deepEqual([five.series.read, five.series.expected, five.short, five.newest], [5, 7, true, NOW - 5 * H]);
  // without expect, one series is a plain single copy
  assert.deepEqual(one({ items: [{ id: 'g', name: 'G', newest: 'q' }] }, raw({ g: { newest: [S(H)], proofAt: null } })).series, { read: 1, expected: null, unit: null });
});

test('derive: past maxAgeH is stale (default 30 h)', () => {
  const rc: RestoreConfig = { items: [{ id: 'a', name: 'A', newest: 'q' }, { id: 'b', name: 'B', newest: 'q', maxAgeH: 200 }] };
  const r = run(rc, raw({ a: { newest: [S(31 * H)], proofAt: null }, b: { newest: [S(31 * H)], proofAt: null } }));
  assert.deepEqual(r.items.map(i => i.stale), [true, false]);
});

test("derive: 0 is 'none found'; no series, a failed query or a stale Prometheus is \"can't read now\"", () => {
  const rc: RestoreConfig = { items: [{ id: 'z', name: 'Z', newest: 'q' }, { id: 'e', name: 'E', newest: 'q' }, { id: 'f', name: 'F', newest: 'q' }] };
  const r = run(rc, raw({ z: { newest: [S(H), 0], proofAt: null }, e: { newest: [], proofAt: null }, f: { newest: null, proofAt: null } }));
  assert.deepEqual(r.items.map(i => [i.why, i.newest]), [[NONE_FOUND, null], [CANT_READ, null], [CANT_READ, null]]);
  // a NaN series is not a time
  assert.equal(one({ items: [{ id: 'n', name: 'N', newest: 'q' }] }, raw({ n: { newest: [NaN], proofAt: null } })).why, CANT_READ);
  // the hub drops a source past its max age before derive: raw.restore is null, and no age is shown
  const stale = run(rc, raw(null), [], () => null);
  assert.ok(stale.items.every(i => i.why === CANT_READ && i.newest == null));
  assert.equal(stale.readAt, null);
});

test('derive: jobs count one series each (a by job by its oldest row); a job with no time is not read', () => {
  const rc: RestoreConfig = { items: [{ id: 'g', name: 'Guests', jobs: ['vz1', 'vz2', 'vz3'], expect: 3, unit: 'hosts' }] };
  const it = one(rc, raw(null), [jobState('vz1', [NOW - 3 * H]), jobState('vz2', [NOW - 2 * H, NOW - 7 * H]), jobState('vz3', [null])]);
  assert.equal(it.newest, NOW - 7 * H);
  assert.deepEqual(it.series, { read: 2, expected: 3, unit: 'hosts' });
  assert.equal(it.short, true);
});

test('derive: proofAt (read) wins over proofOn; proofOn when there is no read', () => {
  const rc: RestoreConfig = { items: [
    { id: 'a', name: 'A', newest: 'q', proof: 'restore-tested', proofAt: 'p', proofOn: '2026-10-02' },
    { id: 'b', name: 'B', newest: 'q', proof: 'restore-tested', proofAt: 'p', proofOn: '2026-10-02' },
    { id: 'c', name: 'C', newest: 'q' },
  ] };
  const r = run(rc, raw({ a: { newest: [S(H)], proofAt: S(48 * H) }, b: { newest: [S(H)], proofAt: null }, c: { newest: [S(H)], proofAt: null } }));
  assert.deepEqual(r.items.map(i => i.proofAt), [NOW - 48 * H, '2026-10-02', null]);
  assert.deepEqual(r.items.map(i => i.proof), ['restore-tested', 'restore-tested', 'finished']);
});

test('derive: the ask fills {n} and {id} (URL-encoded in the url); ask false leaves it off; the note defaults', () => {
  const rc: RestoreConfig = {
    ask: { url: 'https://t.me/acme_desk_bot?text=restore%20{n}%20{id}', text: 'send “restore {n}” ({id})' },
    items: [{ id: 'x', name: 'X', newest: 'q' }, { id: 'a b', name: 'AB', newest: 'q' }, { id: 'q', name: 'Q', newest: 'q', ask: false, link: 'https://wiki.lab.example.com/q' }],
  };
  const r = run(rc, raw({}));
  assert.equal(r.note, RESTORE_NOTE);
  assert.deepEqual(r.items[1].ask, { url: 'https://t.me/acme_desk_bot?text=restore%202%20a%20b', text: 'send “restore 2” (a b)', label: 'Restore…' });
  assert.equal(r.items[2].ask, null);
  assert.equal(r.items[2].link, 'https://wiki.lab.example.com/q');
  // text without a url still shows; the item's number is its place in the list, even past a half-written entry
  const t = run({ ask: { text: 'ask for {n}' }, items: [{} as never, { id: 'y', name: 'Y' }] }, raw({}));
  assert.deepEqual(t.items.map(i => [i.n, i.ask]), [[2, { url: null, text: 'ask for 2', label: 'Restore…' }]]);
});

test('module: hidden without restore.items, and the tab with it', () => {
  const ad = (name: string): Adapter => ({ name, label: name, every: 1, configured: () => true, run: async () => ({}) });
  const cfg = { ...config, modules: undefined, restore: undefined } as unknown as HomelabConfig;
  const states = moduleStates(cfg, [ad('prom-restore'), ad('prom-jobs')], () => true);
  assert.equal(states.restore, 'off');
  const sources: SourceView[] = [];
  const s = derive(mockRaw(cfg), sources, { mock: true, incident: false, build: 't', modules: states }, cfg);
  assert.equal(s.restore, null);
  assert.ok(!visibleTabs(s).includes('Restore'));
  assert.ok(!visibleMTabs(s).includes('Restore'));
  assert.equal(moduleStates({ ...cfg, restore: { items: [{ id: 'a', name: 'A' }] } }, [ad('prom-restore')], () => true).restore, 'on');
  // an empty list is no list
  assert.equal(derive(emptyRaw(), [], { mock: false, incident: false, build: 't' }, { ...cfg, restore: { items: [] } }).restore, null);
});

test('module: an authoritative modules list without restore hides the tab, even with items; listing it shows it', () => {
  const ad = (name: string): Adapter => ({ name, label: name, every: 1, configured: () => true, run: async () => ({}) });
  const withItems = { ...config, restore: { items: [{ id: 'a', name: 'A', newest: 'q' }] } } as HomelabConfig;
  const unlisted = { ...withItems, modules: ['prometheus'] } as HomelabConfig;
  const off = moduleStates(unlisted, [ad('prom-restore')], () => true);
  assert.equal(off.restore, 'off');
  const s = derive(mockRaw(unlisted), [], { mock: true, incident: false, build: 't', modules: off }, unlisted);
  assert.equal(s.restore, null);
  assert.ok(!visibleTabs(s).includes('Restore') && !visibleMTabs(s).includes('Restore'));
  const listed = { ...withItems, modules: ['prometheus', 'restore'] } as HomelabConfig;
  const on = moduleStates(listed, [ad('prom-restore')], () => true);
  assert.equal(on.restore, 'on');
  const s2 = derive(mockRaw(listed), [], { mock: true, incident: false, build: 't', modules: on }, listed);
  assert.ok(s2.restore && visibleTabs(s2).includes('Restore'));
});

test('the example lab: eight items, every state once, the Restore tab shown, and no Needs attention item from it', () => {
  const s = derive(mockRaw(), [], { mock: true, incident: false, build: 't' });
  const r = s.restore!;
  assert.equal(r.items.length, 8);
  assert.ok(visibleTabs(s).includes('Restore') && visibleMTabs(s).includes('Restore'));
  const by = Object.fromEntries(r.items.map(i => [i.id, i]));
  assert.equal(by.offsite.proof, 'restore-tested');
  assert.equal(typeof by.offsite.proofAt, 'number');
  assert.deepEqual(by.offsite.series, { read: 4, expected: 4, unit: 'sources' });
  assert.equal(by.guests.series.read, 2); // from the two vzdump jobs
  assert.equal(by.photos.proofAt, '2026-10-02');
  assert.equal(by['nas-snapshots'].proof, 'finished');
  assert.equal(by.db.ask, null);
  assert.equal(by.cloud.stale, true);
  assert.equal(by.laptops.why, CANT_READ);
  assert.equal(by.offsite.ask?.url, 'https://t.me/acme_desk_bot?text=restore%201');
  assert.ok(r.items.filter(i => i.id !== 'cloud' && i.id !== 'laptops').every(i => i.newest != null && !i.stale && !i.short));
  assert.ok(!s.attention.some(a => /restore/i.test(a.id)));
  assert.equal(s.status.tone, derive(mockRaw({ ...config, restore: undefined }), [], { mock: true, incident: false, build: 't' }, { ...config, restore: undefined }).status.tone);
});
