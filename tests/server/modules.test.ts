// Modules (server/modules.ts): listed vs inferred, and which adapters run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adapterEnabled, moduleStates, unknownModules } from '../../server/modules.ts';
import type { Adapter } from '../../server/adapters/types.ts';
import type { HomelabConfig } from '../../shared/types.ts';

const ad = (name: string, ok: boolean): Adapter => ({ name, label: name, every: 1000, configured: () => ok, run: async () => ({}) });
const ADS = [ad('proxmox', true), ad('prom-infra', true), ad('prom-jobs', true), ad('prom-media', true), ad('prom-ops', true), ad('kuma', false), ad('tautulli', true), ad('plex', false), ad('weather', true)];
const base = { domain: 'lab.example.com', hosts: [{ id: 'pve1', type: 'proxmox' }], network: { gateway: { id: 'gw' } }, webUis: { sonarr: '.41:8989' }, publicEndpoints: [], apps: [] } as unknown as HomelabConfig;
const conf = (a: Adapter) => a.configured();

test('inferred: on when the source is configured and the config describes it; opt-in modules stay off', () => {
  const s = moduleStates(base, ADS, conf);
  assert.equal(s.proxmox, 'on');
  assert.equal(s.sonarr, 'on'); // has a web UI
  assert.equal(s.radarr, 'off'); // Prometheus is there, but no radarr UI
  assert.equal(s.kuma, 'off'); // no key: off, not 'not-connected'
  assert.equal(s.plex, 'on'); // Tautulli alone is enough
  assert.equal(s.ups, 'off');
  assert.equal(s.weather, 'off'); // no location
  assert.equal(s.homeassistant, 'off');
});

test('listed: authoritative; listed without a key is not-connected', () => {
  const s = moduleStates({ ...base, modules: ['proxmox', 'kuma', 'ups'] }, ADS, conf);
  assert.equal(s.proxmox, 'on');
  assert.equal(s.kuma, 'not-connected');
  assert.equal(s.ups, 'on');
  assert.equal(s.sonarr, 'off');
  assert.ok(adapterEnabled(ad('kuma', false), s)); // runs (shows what it needs)
  assert.ok(adapterEnabled(ad('prom-ops', true), s)); // ups is on
  assert.ok(!adapterEnabled(ad('prom-media', true), s));
  assert.ok(adapterEnabled(ad('some-test-double', true), s)); // unknown adapters always run
});

test('a typo in modules is reported', () => {
  assert.deepEqual(unknownModules({ ...base, modules: ['proxmox', 'promethus' as never] }), ['promethus']);
});
