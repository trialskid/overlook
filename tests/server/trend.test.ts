// server/trend.ts: Library health's daily samples (review finding 17): one per local day, fresh counts only, 30 days
// kept, the 7-day change, and the atomic DATA_DIR file. Run: node --import tsx --test tests/server/trend.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryTrend, dayKey, libraryCounts, type LibraryCounts } from '../../server/trend.ts';
import { emptyRaw } from '../../server/raw.ts';
import { derive } from '../../server/derive.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-trend-'));
let n = 0;
const freshFile = () => path.join(root, `t${++n}`, 'library-history.json');
const DAY = 86400e3;
/** noon on 2026-10-06, local time */
const T0 = new Date(2026, 9, 6, 12).getTime();
const counts = (o: Partial<LibraryCounts> = {}): LibraryCounts => ({ bazarr: 2116, sonarrWanted: 1212, radarrMissing: 105, radarrWanted: 81, chaptarrMissing: 6, ...o });

test('dayKey: the local calendar day, moved by whole days across months and DST', () => {
  assert.equal(dayKey(T0), '2026-10-06');
  assert.equal(dayKey(T0, -7), '2026-09-29');
  assert.equal(dayKey(new Date(2026, 10, 3, 0, 30).getTime(), -7), '2026-10-27'); // across the November DST change
  assert.equal(dayKey(new Date(2026, 0, 2, 23, 59).getTime(), -2), '2025-12-31');
});

test('record: one sample per count per day; a later value the same day changes nothing; nulls are skipped', () => {
  const t = new LibraryTrend(null);
  assert.equal(t.record(counts({ chaptarrMissing: null }), T0), true);
  assert.equal(t.record(counts({ bazarr: 9999 }), T0 + 3600e3), true, 'Chaptarr answered later that day: sampled then');
  assert.equal(t.record(counts({ bazarr: 1 }), T0 + 7200e3), false);
  assert.deepEqual(t.history(), { '2026-10-06': { bazarr: 2116, sonarrWanted: 1212, radarrMissing: 105, radarrWanted: 81, chaptarrMissing: 6 } });
  t.record(counts({ bazarr: 2000 }), T0 + DAY);
  assert.equal(t.history()['2026-10-07'].bazarr, 2000);
  // a day where nothing answered leaves no entry
  t.record({ bazarr: null, sonarrWanted: null, radarrMissing: null, radarrWanted: null, chaptarrMissing: null }, T0 + 2 * DAY);
  assert.equal(t.history()['2026-10-08'], undefined);
});

test('delta7: now minus the sample from 7 days before; null without that sample or without a count now', () => {
  const t = new LibraryTrend(null);
  t.record(counts({ radarrWanted: null }), T0);
  for (let d = 1; d < 7; d++) t.record(counts(), T0 + d * DAY);
  assert.deepEqual(Object.values(t.delta7(counts(), T0 + 6 * DAY)), [null, null, null, null, null], 'six days of data: no trend yet');
  const d7 = t.delta7(counts({ bazarr: 2032, sonarrWanted: 1274, radarrMissing: null }), T0 + 7 * DAY);
  assert.deepEqual(d7, { bazarr: -84, sonarrWanted: 62, radarrMissing: null, radarrWanted: null, chaptarrMissing: 0 });
});

test('record: keeps 30 days', () => {
  const t = new LibraryTrend(null);
  for (let d = 0; d < 40; d++) t.record(counts({ bazarr: d }), T0 + d * DAY);
  const days = Object.keys(t.history()).sort();
  assert.equal(days.length, 30);
  assert.equal(days[0], dayKey(T0 + 10 * DAY));
});

test('the file: written atomically (no tmp left), read back by a new instance, an unreadable one starts over', () => {
  const f = freshFile();
  const a = new LibraryTrend(f);
  a.record(counts(), T0);
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['library-history.json']);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).version, 1);
  const b = new LibraryTrend(f);
  assert.deepEqual(b.history(), a.history());
  assert.equal(b.record(counts(), T0 + 60e3), false, 'already sampled today: no write');
  fs.writeFileSync(f, '{ not json');
  const c = new LibraryTrend(f);
  assert.deepEqual(c.history(), {});
  c.record(counts(), T0);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).days).length, 1);
});

test('libraryCounts: the five counts, a source that is not fresh gives null; derive passes delta7 through', () => {
  const raw = { ...emptyRaw(), bazarr: { episodes: 2116, movies: 10 }, sonarr: { series: 1, queued: 0, wanted: 1212 }, radarr: { movies: 1, queued: 0, missing: 105, wanted: 81 } };
  assert.deepEqual(libraryCounts(raw), { bazarr: 2116, sonarrWanted: 1212, radarrMissing: 105, radarrWanted: 81, chaptarrMissing: null });
  assert.deepEqual(libraryCounts(raw, s => s !== 'prom-media'), { bazarr: 2116, sonarrWanted: null, radarrMissing: null, radarrWanted: null, chaptarrMissing: null });
  const opts = { mock: false, incident: false, build: 'test' };
  assert.deepEqual(derive(raw, [], opts).media.delta7, { bazarr: null, sonarrWanted: null, radarrMissing: null, radarrWanted: null, chaptarrMissing: null });
  const d7 = { bazarr: -84, sonarrWanted: 62, radarrMissing: 2, radarrWanted: null, chaptarrMissing: 0 };
  assert.deepEqual(derive(raw, [], { ...opts, delta7: d7 }).media.delta7, d7);
});
