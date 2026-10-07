// The example lab (config/example.homelab.json) end to end: mock data → derive() → the Snapshot the page gets, and the
// page's pure models on it. Run: node --import tsx --import ./tests/setup.ts --test tests/server/lab.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../../server/config.ts';
import { derive } from '../../server/derive.ts';
import { calmRaw, mockRaw } from '../../server/adapters/mock.ts';
import { applyIncident } from '../../server/incident.ts';
import { moduleStates } from '../../server/modules.ts';
import { failPath, incidentItem } from '../../src/lib/incident.ts';
import { setUi } from '../../src/lib/uiconfig.ts';
import type { HomelabConfig, SourceView } from '../../shared/types.ts';
import type { Adapter } from '../../server/adapters/types.ts';

const OPTS = { mock: true, incident: false, build: 'test' };
const NAMES = ['proxmox', 'prom-infra', 'prom-media', 'prom-home', 'prom-jobs', 'prom-ops', 'prom-checks', 'kuma', 'grafana', 'ntfy', 'probes', 'devices',
  'tautulli', 'bazarr', 'seerr', 'immich', 'prowlarr', 'plex', 'wud', 'weather'];
const sources = (): SourceView[] => NAMES.map(name => ({ name, label: name, conn: 'mock', lastOk: Date.now(), ageSec: 1, everySec: 30, maxAgeSec: 90, error: null }));
const snap = (raw = mockRaw(), cfg: HomelabConfig = config, extra = {}) => derive(raw, sources(), { ...OPTS, ...extra }, cfg);
const ids = (s: ReturnType<typeof snap>, sev?: string) => s.attention.filter(a => !sev || a.severity === sev).map(a => a.id);

test('the example lab is fictional: Acme Lab on lab.example.com, 10.20.0.0/24', () => {
  assert.equal(config.domain, 'lab.example.com');
  assert.equal(config.network.subnet, '10.20.0.0/24');
  const s = JSON.stringify(snap());
  assert.ok(!/192\.168\./.test(s)); // only the example's own addresses
});

test('default mock: amber with its two items (a Grafana alert, security updates waiting 20 days), nothing red', () => {
  const s = snap();
  assert.equal(s.status.tone, 'warn');
  assert.deepEqual(ids(s, 'danger'), []);
  assert.deepEqual(ids(s, 'warn').sort(), ['apt-sec-nas', 'grafana-cachecapacity90']);
  assert.equal(incidentItem(s), undefined); // amber never takes over the Overview
});

test('calm mock: green, only info notes', () => {
  const s = snap(calmRaw(mockRaw()));
  assert.equal(s.status.tone, 'ok');
  assert.ok(s.attention.every(a => a.severity === 'info'), ids(s).join(', '));
});

test('one web UI down: red, the incident leads, and the path runs Internet → gateway → switch → host → guest → UI', () => {
  const s = snap(applyIncident(mockRaw(), 'git'));
  assert.equal(s.status.tone, 'danger');
  const item = incidentItem(s)!;
  assert.equal(item.id, 'down-git');
  setUi(s.ui);
  const hops = failPath(s, item.id, 40)!;
  assert.deepEqual(hops.map(h => h.name), ['Internet', 'OPNsense', 'Core switch', 'pve1', '102 web', 'Gitea']);
  assert.equal(hops.at(-1)!.status, 'down');
});

test('network: the configured gateway, switch, access points and the guest Wi-Fi segment; devices filed by segment', () => {
  const s = snap();
  assert.equal(s.network.gateway?.name, 'OPNsense');
  assert.equal(s.network.switch?.name, 'Core switch');
  assert.deepEqual(s.network.aps.map(a => a.name), ['AP Living room', 'AP Office']);
  assert.deepEqual(s.network.segments.map(x => [x.id, x.label]), [['guest', 'Guest Wi-Fi']]);
  assert.equal(s.network.tunnelName, 'Cloudflare tunnel');
  const guest = s.devices.groups.find(g => g.id === 'seg:guest')!;
  assert.ok(guest.rows.some(r => r.name === 'guest-phone'));
  assert.deepEqual(s.devices.counts?.segments.map(x => x.name), ['Guest Wi-Fi']);
});

test('no gateway or switch: none drawn, and the path goes straight from the internet to the host', () => {
  const bare = { ...config, network: { subnet: config.network.subnet } };
  const s = snap(applyIncident(mockRaw(bare), 'git'), bare);
  assert.equal(s.network.gateway, null);
  assert.equal(s.network.switch, null);
  setUi(s.ui);
  assert.deepEqual(failPath(s, 'down-git', null)!.map(h => h.name).slice(0, 2), ['Internet', 'pve1']);
});

test('modules: a lab with only Proxmox and Kuma gets no media, Home Assistant or alert data, and says so in Snapshot.modules', () => {
  const cfg = { ...config, modules: ['proxmox', 'kuma'] } as HomelabConfig;
  const ad = (name: string): Adapter => ({ name, label: name, every: 1, configured: () => true, run: async () => ({}) });
  const states = moduleStates(cfg, NAMES.map(ad), () => true);
  const s = snap(mockRaw(cfg), cfg, { modules: states });
  assert.equal(s.modules.sonarr, 'off');
  assert.equal(s.modules.kuma, 'on');
  assert.equal(s.media.sonarr, null);
  assert.equal(s.home.haUp, null);
  assert.equal(s.alerts, null);
  assert.ok(!s.health.alerting.some(a => a.name === 'Grafana'));
  assert.ok(!ids(s).some(i => i.startsWith('grafana-')));
});

test('web UI links: the LAN address by default; an https console from uiUrls', () => {
  const s = snap();
  assert.equal(s.uis.find(u => u.name === 'sonarr')!.url, 'http://10.20.0.41:8989');
  assert.equal(s.uis.find(u => u.name === 'plex')!.url, 'http://10.20.0.41:32400/web/index.html');
  assert.equal(s.uis.find(u => u.name === 'pve1')!.url, 'https://10.20.0.10:8006');
});

test('checks and the ui section: the hottest-disk check reads ok; the title and brand come from config', () => {
  const s = snap();
  const row = s.health.alerting.find(a => a.name === 'Hottest disk')!;
  assert.equal(row.tone, 'ok');
  assert.match(row.state, /°C$/);
  assert.equal(s.ui.title, 'Overlook');
  assert.equal(s.ui.brand, 'lab.example.com');
  assert.equal(s.ui.lanPrefix, '10.20.0');
});

test('spotlight: none in the example; a configured one gets its block with LAN, Public and its own signals', () => {
  assert.equal(snap().spotlight, null);
  const cfg = { ...config, spotlight: { app: 'Nextcloud', signals: [{ name: 'Database', query: 'nextcloud_db_up', role: 'other' as const }] } };
  const s = snap(mockRaw(cfg), cfg);
  assert.equal(s.spotlight?.name, 'Nextcloud');
  assert.deepEqual(s.spotlight?.signals.map(x => x.name), ['LAN', 'Public', 'Database']);
});
