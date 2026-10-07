// Media's pipeline stages (review finding 15, src/desktop/Media.tsx stageStates): Download→Watch takes the better of
// qBittorrent and NZBGet. Run: node --import tsx --test tests/server/pipeline.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derive } from '../../server/derive.ts';
import { mockRaw } from '../../server/adapters/mock.ts';
import { stageStates } from '../../src/desktop/Media.tsx';
import type { Snapshot } from '../../shared/types.ts';

const base = derive(mockRaw(), [], { mock: true, incident: false, build: 'test' });
const snap = (media: Partial<Snapshot['media']>): Snapshot => ({ ...base, media: { ...base.media, ...media } });
const ok = { leeching: 1, seeding: 2, conn: 'connected' as const }, nz = { todayGB: 1, queueGB: 0, paused: false };
const dl = (s: Snapshot, rate: number | null) => stageStates(s, rate)[3];

test('download: flowing while either downloader moves, even behind a firewalled VPN', () => {
  assert.equal(dl(snap({ qbit: { ...ok, conn: 'firewalled' }, nzbget: nz }), 3.2).seg, 'flow');
  assert.equal(dl(snap({ qbit: ok, nzbget: nz }), 0).seg, 'idle');
});

test('download: a blocked qBittorrent alone is not failing; failing only when NZBGet is paused or offline too', () => {
  assert.equal(dl(snap({ qbit: { ...ok, conn: 'firewalled' }, nzbget: nz }), 0).seg, 'idle');
  assert.deepEqual(dl(snap({ qbit: { ...ok, conn: 'firewalled' }, nzbget: { ...nz, paused: true } }), 0), { seg: 'warn', text: 'qBittorrent firewalled · NZBGet paused' });
  assert.deepEqual(dl(snap({ qbit: { ...ok, conn: 'disconnected' }, nzbget: null }), 0), { seg: 'danger', text: 'qBittorrent offline · NZBGet not answering' });
  assert.equal(dl(snap({ qbit: null, nzbget: { ...nz, paused: true } }), 0).seg, 'warn');
  assert.equal(dl(snap({ qbit: null, nzbget: null }), null).seg, 'off');
});

test('download: with only one downloader in the lab, that one blocked is failing; the other is never named', () => {
  const qbOnly = (media: Partial<Snapshot['media']>): Snapshot => ({ ...snap(media), modules: { ...base.modules, nzbget: 'off' } });
  assert.deepEqual(dl(qbOnly({ qbit: { ...ok, conn: 'firewalled' }, nzbget: null }), 0), { seg: 'warn', text: 'qBittorrent firewalled' });
  assert.equal(dl(qbOnly({ qbit: ok, nzbget: null }), 0).seg, 'idle');
});
