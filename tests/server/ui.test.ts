// shared/ui.ts: the page's names, groups and LAN prefix from homelab.json `ui` over the product defaults.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COLUMNS, resolveUi } from '../../shared/ui.ts';
import type { HomelabConfig } from '../../shared/types.ts';

const hosts = [{ id: 'pve1' }, { id: 'nas' }] as HomelabConfig['hosts'];

test('defaults: product names and groups, host ids in Infrastructure, the first host open, LAN prefix from the subnet', () => {
  const u = resolveUi({ domain: 'lab.example.com', hosts, network: { subnet: '10.20.0.0/24' } as HomelabConfig['network'] });
  assert.equal(u.title, 'Overlook');
  assert.equal(u.brand, 'lab.example.com');
  assert.equal(u.names.qbittorrent, 'qBittorrent');
  const infra = u.groups.find(([t]) => t === 'Infrastructure')![1];
  assert.equal(infra[0], 'pve1'); // added first
  assert.equal(infra.filter(k => k === 'nas').length, 1); // already a default key: not added twice
  assert.deepEqual(u.columns, DEFAULT_COLUMNS);
  assert.deepEqual(u.openHosts, ['pve1']);
  assert.equal(u.lanPrefix, '10.20.0');
});

test('a lab\'s own: groups replace the defaults (no host ids added), names and aliases add to them, uiLabels count as names', () => {
  const u = resolveUi({
    domain: 'x', hosts, uiLabels: { git: 'Forgejo' },
    ui: { title: 'Rack', launcher: { groups: [['Core', ['PVE1', 'git']]], hidden: ['Overlook'] }, names: { pve1: 'Big box' }, aliases: { pve1: 'main' } },
  });
  assert.equal(u.title, 'Rack');
  assert.deepEqual(u.groups, [['Core', ['pve1', 'git']]]);
  assert.deepEqual(u.columns, [['Core']]);
  assert.deepEqual(u.hidden, ['overlook']);
  assert.equal(u.names.git, 'Forgejo');
  assert.equal(u.names.pve1, 'Big box');
  assert.equal(u.aliases.pve1, 'main');
  assert.equal(u.aliases.plex, 'movies shows media'); // product aliases stay
});
