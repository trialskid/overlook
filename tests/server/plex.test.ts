// Plex remote access (adapter plex) and the port-forward rows. Run: node --import tsx --test tests/server/plex.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlexAccount, recentSub } from '../../server/adapters/apps.ts';
import { derive } from '../../server/derive.ts';
import { mockRaw } from '../../server/adapters/mock.ts';
import { config } from '../../server/config.ts';
import type { Conn, SourceView } from '../../shared/types.ts';

const OPTS = { mock: false, incident: false, build: 'test' };
const sources = (over: Record<string, Conn> = {}): SourceView[] => ['proxmox', 'prom-infra', 'kuma', 'probes', 'plex'].map(name => {
  const conn = over[name] ?? 'ok', now = Date.now();
  return { name, label: name, conn, lastOk: now - 5e3, ageSec: 5, everySec: 300, maxAgeSec: 900, error: null };
});
const fw = (s: ReturnType<typeof derive>) => s.health.exposure.filter(x => x.via === 'port-forward').map(x => [x.name, x.status, x.note]);

test('parsePlexAccount: mapped, an error, and a body without the field', () => {
  assert.deepEqual(parsePlexAccount('<MyPlex authToken="x" mappingState="mapped" mappingError="" publicPort="32400" signInState="ok"/>'), { mapped: true, state: 'mapped', error: '', publicPort: 32400 });
  assert.deepEqual(parsePlexAccount('<MyPlex mappingState="unknown" mappingError="unreachable" publicPort="0"/>'), { mapped: false, state: 'unknown', error: 'unreachable', publicPort: null });
  assert.throws(() => parsePlexAccount('<html>login</html>'));
});

test('Plex forward reads Plex, another forward says it can\'t be checked; a broken mapping is one amber item', () => {
  const ok = derive(mockRaw(), sources(), OPTS, config);
  assert.deepEqual(fw(ok), [['Plex remote access', 'up', 'reachable'], ['WireGuard', 'unknown', "can't be checked"]]);
  assert.equal(ok.attention.find(a => a.id === 'plex-remote'), undefined);
  const r = mockRaw(); r.plex = { mapped: false, state: 'unknown', error: 'unreachable', publicPort: 32400 };
  const bad = derive(r, sources(), OPTS, config);
  assert.deepEqual(fw(bad)[0], ['Plex remote access', 'down', 'unreachable']);
  assert.equal(bad.attention.find(a => a.id === 'plex-remote')!.severity, 'warn');
  // no token: says so, no item
  const nt = derive(r, sources({ plex: 'not-connected' }), OPTS, config);
  assert.deepEqual(fw(nt)[0], ['Plex remote access', 'unknown', 'no Plex token']);
  assert.equal(nt.attention.find(a => a.id === 'plex-remote'), undefined);
});

test('chaptarrStats: sums author statistics; a wrong answer throws instead of reading zero', async () => {
  const { chaptarrStats } = await import('../../server/adapters/apps.ts');
  const authors = [{ statistics: { availableBookCount: 3, totalBookCount: 3 } }, { statistics: { availableBookCount: 13, totalBookCount: 22 } }, {}];
  assert.deepEqual(chaptarrStats(authors, { totalRecords: 6 }, { totalRecords: 0 }), { authors: 3, books: 16, booksTotal: 25, missing: 6, queued: 0 });
  assert.throws(() => chaptarrStats({} as any, { totalRecords: 6 }, { totalRecords: 0 }));
  assert.throws(() => chaptarrStats(authors, {}, { totalRecords: 0 }));
});

test('recentSub: the line under a Recently added poster (episode, season, new show, movie)', () => {
  assert.equal(recentSub({ media_type: 'episode', parent_media_index: '2', media_index: '5' }), 'S2E5');
  assert.equal(recentSub({ media_type: 'episode', parent_media_index: '', media_index: '5' }), undefined);
  assert.equal(recentSub({ media_type: 'season', media_index: 2 }), 'Season 2');
  assert.equal(recentSub({ media_type: 'show' }), 'New show');
  assert.equal(recentSub({ media_type: 'movie', year: '2024' }), '2024');
  assert.equal(recentSub({ media_type: 'movie', year: '' }), undefined);
  assert.equal(recentSub({ media_type: 'track' }), undefined);
});
