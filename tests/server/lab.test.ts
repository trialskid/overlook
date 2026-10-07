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
import { automationRows } from '../../shared/health.ts';
import { recentQ } from '../../server/adapters/prom-infra.ts';
import { fillDetail } from '../../server/derive/util.ts';
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

test('tunnel: an endpoint on another tunnel (tunnelJob) answering does not hide the main tunnel being down', () => {
  const cfg = structuredClone(config);
  cfg.publicEndpoints.push({ name: 'Status page', host: 'status.example.com', via: 'tunnel', tunnelJob: 'cloudflared-backup', origin: 'status · nas', expect: [200] } as (typeof cfg.publicEndpoints)[number]);
  const raw = mockRaw(cfg);
  for (const h of ['requests.example.com', 'photos.example.com']) raw.probes![h] = { code: null, ms: null, error: 'timeout', at: Date.now() - 60e3 };
  raw.probes!['status.example.com'] = { code: 200, ms: 50, error: null, at: Date.now() - 60e3 };
  const s = snap(raw, cfg);
  assert.equal(s.network.internet, 'down');
  assert.ok(ids(s, 'danger').includes('internet'), ids(s).join(', '));
});

test('access points: short names the map segment, the Devices row keeps the full model', () => {
  const cfg = structuredClone(config);
  cfg.network.accessPoints!.push({ name: 'AP Guest', ip: '10.20.0.22', segment: 'guest', model: 'Acme X200 (mesh node)', short: 'mesh node' });
  const s = snap(mockRaw(cfg), cfg);
  assert.equal(s.network.segments.find(x => x.id === 'guest')!.label, 'AP Guest · mesh node');
  const rows = s.devices.groups.flatMap(g => g.rows ?? []) as { name: string; sub?: string }[];
  assert.equal(rows.find(r => r.name === 'AP Guest')?.sub, 'access point · Acme X200 (mesh node)');
});

test('apps: one with only jobs takes their status, counts as monitored, and lets the job item speak', () => {
  const cfg = structuredClone(config);
  cfg.apps.push({ name: 'photo-sync', label: 'Photo sync', host: 'nas', jobs: ['kopia'] });
  const up = snap(mockRaw(cfg), cfg).apps.find(a => a.name === 'photo-sync')!;
  assert.equal(up.monitored, true);
  assert.equal(up.status, 'up');
  const raw = mockRaw(cfg);
  raw.jobs!.kopia = { ...raw.jobs!.kopia, ok: false };
  const s = snap(raw, cfg);
  assert.equal(s.apps.find(a => a.name === 'photo-sync')!.status, 'down');
  assert.equal(s.hosts.find(h => h.id === 'nas')!.leaves.find(l => l.key === 'app-photo-sync')?.status, 'down');
  assert.ok(!ids(s).includes('app-photo-sync'), ids(s).join(', '));
});

test('checks: one naming a job carries it, so that job leaves Automation', () => {
  const cfg = structuredClone(config);
  cfg.checks![0] = { ...cfg.checks![0], job: 'health-report' };
  const s = snap(mockRaw(cfg), cfg);
  assert.equal(s.health.alerting.find(a => a.name === 'Hottest disk')?.job, 'health-report');
  assert.ok(!automationRows(s.health).some(u => u.kind === 'row' && u.row.job.id === 'health-report'));
});

test('spotlight window: a bare selector gets the exact 150 s range, an expression a subquery', () => {
  assert.equal(recentQ('app_ready'), 'max(max_over_time(app_ready[150s]))');
  assert.equal(recentQ(' app_ready{job="x"} '), 'max(max_over_time(app_ready{job="x"}[150s]))');
  assert.equal(recentQ('min(a_ready) * b_ready'), 'max_over_time((max(min(a_ready) * b_ready))[150s:15s])');
});

test('checks: a Kuma check reads its monitors, with words for its states', () => {
  const cfg = structuredClone(config), raw0 = mockRaw(cfg), id = raw0.kuma![0].id;
  cfg.checks!.push({ id: 'outage-push', name: 'Outage push', kuma: [id], words: { 1: 'reachable', 0: 'not reachable' }, below: true, danger: 1, where: 'second tunnel · from outside' });
  const up = snap(mockRaw(cfg), cfg).health.alerting.find(a => a.name === 'Outage push')!;
  assert.deepEqual([up.state, up.tone, up.where], ['reachable', 'ok', 'second tunnel · from outside']);
  const raw = mockRaw(cfg);
  raw.kuma = raw.kuma!.map(m => (m.id === id ? { ...m, status: 'down' as const } : m));
  const s = snap(raw, cfg);
  assert.deepEqual([s.health.alerting.find(a => a.name === 'Outage push')!.state, s.health.alerting.find(a => a.name === 'Outage push')!.tone], ['not reachable', 'danger']);
  assert.ok(ids(s, 'danger').includes('check-outage-push'), ids(s).join(', '));
  raw.kuma = raw.kuma!.filter(m => m.id !== id);
  assert.equal(snap(raw, cfg).health.alerting.find(a => a.name === 'Outage push')!.state, 'no Kuma monitor');
});

test("checks: format 'ago' shows an epoch as an age, text wraps it, and warn/danger are ages in seconds", () => {
  const cfg = structuredClone(config);
  cfg.checks!.push({ id: 'watchdog', name: 'Watchdog', query: 'max(watchdog_last_run_timestamp_seconds)', format: 'ago', text: 'last run {value}', warn: 600, danger: 3600 });
  const raw = mockRaw(cfg);
  raw.checks!.watchdog = Date.now() / 1000 - 20;
  assert.deepEqual((({ state, tone }) => ({ state, tone }))(snap(raw, cfg).health.alerting.find(a => a.name === 'Watchdog')!), { state: 'last run just now', tone: 'ok' });
  raw.checks!.watchdog = Date.now() / 1000 - 2 * 3600;
  const s = snap(raw, cfg), row = s.health.alerting.find(a => a.name === 'Watchdog')!;
  assert.deepEqual([row.state, row.tone], ['last run 2 h ago', 'danger']);
  assert.equal(s.attention.find(a => a.id === 'check-watchdog')?.detail, 'older than 1 h');
});

test('storage: a row read from Prometheus joins Health › Storage; one without figures is left out', () => {
  const cfg = structuredClone(config);
  cfg.storage = [{ name: 'Off-site box', used: 'offsite_used_bytes', total: 'offsite_total_bytes' }, { name: 'Bucket', used: 'b_used', total: 'b_total' }];
  const raw = mockRaw(cfg);
  raw.storage = { 'Off-site box': { used: 2.1e12, total: 5e12 }, Bucket: { used: null, total: 1e12 } };
  const v = snap(raw, cfg).health.storage;
  assert.deepEqual((({ used, cap, pct, sub }) => ({ used, cap, pct, sub }))(v.find(x => x.name === 'Off-site box')!), { used: '2.1 TB', cap: '5 TB', pct: 42, sub: '2.9 TB free' });
  assert.ok(!v.some(x => x.name === 'Bucket'));
});

test('jobs: detail fills from values; a part without its value drops out, |word replaces a 0', () => {
  const cfg = structuredClone(config), kopia = cfg.jobs.find(j => j.id === 'kopia')!;
  kopia.detail = '{ready}/{total} mounts · {paused|none} paused · {gone} gone';
  kopia.values = { ready: 'sum(m_ready)', total: 'count(m_ready)', paused: 'sum(p)', gone: 'g' };
  const raw = mockRaw(cfg);
  raw.jobs!.kopia = { ...raw.jobs!.kopia, values: { ready: 5, total: 5, paused: 0, gone: null } };
  assert.equal(snap(raw, cfg).health.jobs.find(j => j.id === 'kopia')!.detail, '5/5 mounts · none paused');
  assert.equal(fillDetail('{n} new at {t:clock} · login to {d:day}', { n: 11, t: Date.now() / 1000 - 60, d: null }, Date.now()).split(' · ').length, 1);
});

test('ui: the gateway tile, the qBittorrent line and the spotlight backup label come from config', () => {
  assert.equal(snap().ui.gatewayMonogram, 'GW');
  const cfg = structuredClone(config);
  cfg.ui = { ...cfg.ui, monograms: { ...cfg.ui?.monograms, router: 'OP' }, qbittorrentVia: 'a VPN container · WireGuard' };
  cfg.spotlight = { app: 'Nextcloud', backupJob: 'kopia', backupLabel: 'Last dump' };
  const s = snap(mockRaw(cfg), cfg);
  assert.deepEqual([s.ui.gatewayMonogram, s.ui.qbittorrentVia, s.spotlight?.backupLabel], ['OP', 'a VPN container · WireGuard', 'Last dump']);
});
