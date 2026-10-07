// Mock data (MOCK=1, npm run demo): plausible values for every Raw slice, all of it shaped from homelab.json (hosts,
// guests, web UIs, apps, jobs, endpoints, Home Assistant entities, checks), plus random-walk fast series. Made up and
// seeded, so every run of the same config looks the same.
// Everything is healthy except two amber items, so screenshots show the amber path: one firing Grafana alert (a cache
// 91% full) and security updates waiting 20 days on one host. MOCK_CALM=1: neither (the calm Overview).
import { config } from '../config.ts';
import { dayKey, type LibraryHistory } from '../trend.ts';
import { jobOf } from '../derive/util.ts';
import { uiAddr } from '../derive/kuma.ts';
import { PRODUCT_NAMES } from '../../shared/ui.ts';
import type { AptRaw, GuestRaw, JobRaw, KumaMonitorRaw, Raw, ResRaw, Sample, UnraidDiskRaw } from '../raw.ts';
import type { HomelabConfig, Status } from '../../shared/types.ts';

const rnd = (s: number) => { const x = Math.sin(s * 12.9898) * 43758.5453; return x - Math.floor(x); };
/** a stable number for a string (seeds per host, guest and monitor) */
const seedOf = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 100_003, 7);
const GiB = 1024 ** 3, MIN = 60e3, H = 3600e3, D = 24 * H;
const lanOf = (cfg: HomelabConfig) => (cfg.network?.subnet ?? '10.0.0.0/24').split('/')[0].split('.').slice(0, 3).join('.');
const full = (cfg: HomelabConfig, ip: string) => (ip.startsWith('.') ? lanOf(cfg) + ip : ip);

/** `cfg`: the config to shape it from (index.ts dry-runs a reloaded homelab.json through derive with it).
 *  MOCK_OPS=0: leave out the ups, unraid, apt and edge metrics ('not monitored yet').
 *  MOCK_CALM=1: nothing amber either (calmRaw), so the Overview shows its calm shape.
 *  MOCK_PLAYING=1: Plex playing one stream (Media's playing layout). */
export function mockRaw(cfg: HomelabConfig = config): Raw {
  const raw = mockAll(cfg);
  if (process.env.MOCK_OPS === '0') Object.assign(raw, { ups: null, unraidHealth: null, apt: null, edge: null });
  const out = process.env.MOCK_CALM === '1' ? calmRaw(raw) : raw;
  return process.env.MOCK_PLAYING === '1' && out.tautulli
    ? { ...out, tautulli: { ...out.tautulli, streams: 1, nowPlaying: { title: 'Arrival', sub: '2016', user: 'alex', progress: 42, state: 'playing' } } }
    : out;
}
/** The mock with its two amber items gone: no firing Grafana alert, and no security update older than two weeks.
 *  Info notes stay (they never change the status). */
export function calmRaw(raw: Raw): Raw {
  const now = Date.now();
  return { ...raw, grafana: raw.grafana ? [] : raw.grafana, apt: raw.apt?.map(a => (a.securitySince != null && now - a.securitySince > 14 * D ? { ...a, securitySince: now - 3 * D } : a)) ?? raw.apt };
}

function mockAll(cfg: HomelabConfig): Raw {
  const now = Date.now();
  const res = (seed: number, memT: number, diskT: number | null, swapT: number | null = 8): ResRaw => ({
    cpuPct: Math.round(3 + rnd(seed) * 12), memUsed: memT * (0.25 + rnd(seed + 1) * 0.4) * GiB, memTotal: memT * GiB,
    swapUsed: swapT == null ? null : 0.1 * GiB, swapTotal: swapT == null ? null : swapT * GiB,
    diskUsed: diskT == null ? null : diskT * (0.15 + rnd(seed + 2) * 0.4) * GiB, diskTotal: diskT == null ? null : diskT * GiB,
    load1: Math.round(rnd(seed + 3) * 20) / 10, uptimeSec: Math.round(3 + rnd(seed + 4) * 40) * 86400,
  });
  const hostRes: Record<string, ResRaw> = Object.fromEntries(cfg.hosts.map(h => [h.id,
    h.type === 'proxmox' ? res(seedOf(h.id), 64, 940) : h.type === 'unraid' ? res(seedOf(h.id), 32, null, null) : res(seedOf(h.id), 16, 460)]));

  const guests: Record<string, GuestRaw> = {};
  for (const g of cfg.guests) {
    const k = `${g.host}:${g.vmid}`, s = seedOf(k), lxc = g.kind === 'lxc', memT = g.kind === 'vm' ? 8 : 4 + (g.services?.length ?? 0);
    guests[k] = {
      host: g.host, vmid: g.vmid, name: g.name, kind: g.kind, status: 'up', template: false, cpuPct: Math.round(1 + rnd(s) * 10),
      memUsed: memT * (0.2 + rnd(s + 1) * 0.5) * GiB, memTotal: memT * GiB, diskUsed: (8 + rnd(s + 2) * 40) * GiB, diskTotal: 64 * GiB,
      swapUsed: lxc ? 0 : null, swapTotal: lxc ? 0.5 * GiB : null, uptimeSec: (5 + (g.vmid % 9)) * 86400,
    };
  }
  // containers per Docker LXC (cAdvisor): about one per service it lists
  const containers: Record<number, number> = Object.fromEntries(cfg.guests.filter(g => g.cadvisor).map(g => [g.vmid, Math.max(1, (g.services?.length ?? 1) + Math.round(rnd(g.vmid) * 4))]));

  // Uptime Kuma: one monitor per web UI (its LAN address), app and probed public endpoint; an app's own ids are kept
  const labelOf = (n: string) => cfg.ui?.names?.[n] ?? cfg.uiLabels?.[n] ?? PRODUCT_NAMES[n] ?? n;
  const mons: [number, string, string, string][] = [];
  let next = 100;
  for (const a of cfg.apps) for (const id of a.kuma ?? []) mons.push([id, a.label, 'http', a.url ?? a.publicUrl ?? '']);
  for (const [name, target] of Object.entries(cfg.webUis ?? {})) { const { ip, port } = uiAddr(cfg, target); mons.push([next++, labelOf(name), 'http', `http://${ip}${port ? `:${port}` : ''}`]); }
  for (const a of cfg.apps) if (!a.kuma?.length && a.url && !a.onDemand) mons.push([next++, a.label, 'http', a.url]);
  for (const e of cfg.publicEndpoints) if (e.via === 'tunnel' && e.probe !== false) mons.push([next++, `${e.name} (public)`, 'http', `https://${e.host}${e.path ?? '/'}`]);
  for (const [id, key] of Object.entries(cfg.kumaAliases ?? {})) if (!mons.some(m => m[0] === Number(id))) mons.push([Number(id), key.replace(/^\w+:/, ''), 'http', '']);
  const kuma: KumaMonitorRaw[] = mons.map(([id, name, type, url], i) => {
    const cells: Status[] = Array.from({ length: 48 }, (_, j) => { const r = rnd(i * 97 + j * 7 + 3); return r > 0.996 ? 'down' : r > 0.98 ? 'degraded' : 'up'; });
    return {
      id, name, type, url, hostname: null, port: null, status: 'up', ms: Math.round(6 + rnd(i * 13 + 5) * 60),
      up1d: 1 - rnd(i * 5 + 2) * 0.002, up30d: 0.999 + rnd(i * 3 + 1) * 0.00099,
      certDays: url.startsWith('https://') && !/\/\/\d/.test(url) ? 40 + Math.round(rnd(i * 11) * 40) : null, cells, downSince: null,
    };
  });

  // jobs: every job with a signal; a `by` job gets one row per (made-up) label value
  const days = (seed: number): Status[] => Array.from({ length: 14 }, (_, j) => (rnd(seed + j * 3) > 0.95 ? 'degraded' : 'up'));
  const jobs: Record<string, JobRaw & { label?: string }> = {};
  cfg.jobs.forEach((j, n) => {
    if (j.signal === 'none') return;
    const age = j.maxAgeH > 0 ? Math.min(j.maxAgeH * 0.4, 20) * H * (0.5 + rnd(n) / 2) : 9 * H;
    const row = (seed: number): JobRaw => ({ lastAt: now - age, ok: true, days: j.maxAgeH >= 24 ? days(seed) : null });
    const onNode = cfg.guests.filter(g => g.host === j.node).length;
    if (j.by) cfg.guests.slice(0, 3).forEach((g, i) => { jobs[`${j.id}:${g.name}`] = { ...row(n * 31 + i), label: g.name }; });
    else jobs[j.id] = { ...row(n * 31), ...(j.signal === 'proxmox-vzdump' ? { detail: `${onNode}/${onNode} guests` } : {}) };
  });

  const probes: NonNullable<Raw['probes']> = {};
  cfg.publicEndpoints.forEach((e, i) => { if (e.probe !== false && e.via !== 'port-forward') probes[e.host] = { code: e.expect[0] ?? 200, ms: Math.round(40 + rnd(i * 7) * 120), error: null, at: now - 70e3 }; });
  for (const h of cfg.retiredHosts) probes[h] = { code: 404, ms: 35, error: null, at: now - 70e3 };

  const ha = cfg.homeAssistant;
  const garageSince = new Date(now).setHours(7, 42, 0, 0);
  const nas = cfg.hosts.find(h => h.type === 'unraid');
  const disk = (disk: string, type: string, tempC: number | null, poh: number | null, extra: Partial<UnraidDiskRaw> = {}): UnraidDiskRaw => ({
    disk, type, status: 'DISK_OK', ok: true, tempC, errors: 0, spundown: false, fsMounted: type === 'Data' || type === 'Cache' ? true : null,
    failingNow: poh == null ? null : 0, failedPast: poh == null ? null : 0, reallocated: poh == null ? null : 0, pending: poh == null ? null : 0,
    offlineUncorrectable: poh == null ? null : 0, crc: poh == null ? null : 0, reportedUncorrect: poh == null ? null : 0, grown: poh == null ? null : 0, powerOnHours: poh, ...extra,
  });
  // apt: one row per host with a node_exporter job; the second waits 20 days on security updates (the amber item)
  const aptHosts = cfg.hosts.filter(h => h.nodeJob);
  const aptRow = (h: HomelabConfig['hosts'][number], i: number): AptRaw => {
    const security = i === 0 ? 4 : i === 1 ? 6 : 0, pve = h.type === 'proxmox';
    return {
      job: h.nodeJob!, instance: `${full(cfg, h.ip)}:9100`, host: h.id, pending: 6 + i * 5, held: 0, security, securitySince: security ? now - (i === 1 ? 20 : 3) * D : null,
      reboot: i === 0, rebootSince: i === 0 ? now - 2 * D : null,
      kernel: pve ? { running: '6.14.11-2-pve', expected: i === 0 ? '6.14.11-3-pve' : '6.14.11-2-pve' } : { running: '6.8.0-60-generic', expected: '6.8.0-60-generic' },
      collectorOk: true, collectorRunAt: now - 6 * MIN, cacheAt: now - 13 * H,
    };
  };
  const cfJob = (cfg.edge?.mainTunnelJob ?? jobOf(cfg, 'cloudflared', 'cloudflared')).replace(/[.*+?^${}()|[\]\\]/g, '') || 'cloudflared';
  const otherTunnels = [...new Set(cfg.publicEndpoints.map(e => e.tunnelJob).filter((j): j is string => !!j))];
  // each check comfortably on the good side of its first threshold
  const fine = (c: NonNullable<HomelabConfig['checks']>[number]) => { const t = c.warn ?? c.danger; return t == null ? 1 : c.below ? t * 1.5 + 1 : t * 0.6; };

  // the router's device list: config infra and smart home on their own IPs, then made-up phones, laptops and TVs
  const infraIps: [string, string, string][] = [
    ...(cfg.network?.gateway ? [[cfg.network.gateway.ip, 'gateway', 'router'] as [string, string, string]] : []),
    ...(cfg.network?.switch ? [[cfg.network.switch.ip, '', 'switch'] as [string, string, string]] : []),
    ...(cfg.network?.accessPoints ?? []).map(a => [a.ip, a.name, 'access point'] as [string, string, string]),
    ...cfg.hosts.map(h => [full(cfg, h.ip), h.id, 'server'] as [string, string, string]),
    ...cfg.guests.filter(g => g.ip).map(g => [full(cfg, g.ip), g.name, 'server'] as [string, string, string]),
    ...cfg.devices.map(d => [full(cfg, d.ip), d.name, 'smart home'] as [string, string, string]),
  ];
  const lan = lanOf(cfg), seg = cfg.network?.segments?.[0];
  const extras: [string, string, string, string, number][] = [
    [`${lan}.150`, 'alex-phone', 'Apple, Inc.', 'phone', 2], [`${lan}.151`, 'sam-laptop', 'Dell Inc.', 'laptop', 14], [`${lan}.152`, 'living-room-tv', 'LG Innotek', 'tv', 26 * 60],
    [`${lan}.153`, '', 'Amazon Technologies Inc.', 'smart speaker', 6], [`${lan}.154`, 'tablet', 'Samsung Electronics Co.,Ltd', 'tablet', 9 * 1440], [`${lan}.155`, 'old-laptop', 'Lenovo', 'laptop', 75 * 1440],
    ...(seg?.prefix ? [[`${seg.prefix}.21`, 'guest-phone', 'Google, Inc.', 'phone', 3], [`${seg.prefix}.34`, 'streaming-stick', 'Roku, Inc', 'tv', 50], [`${seg.prefix}.47`, '', 'Nintendo Co.,Ltd', 'game console', 4 * 1440]] as [string, string, string, string, number][] : []),
  ];
  const mac = (i: number) => `02:00:5E:${(i >> 8).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}:${Math.floor(rnd(i) * 256).toString(16).padStart(2, '0')}`.toUpperCase();
  const deviceList = [
    ...infraIps.map(([ip, name, type], i) => ({ ip, name, vendor: '', type, network: 'LAN', minAgo: 1 + (i % 3), i })),
    ...extras.map(([ip, name, vendor, type, minAgo], j) => ({ ip, name, vendor, type, network: seg?.prefix && ip.startsWith(`${seg.prefix}.`) ? seg.name : 'LAN', minAgo, i: 500 + j })),
  ].map(d => ({ mac: mac(d.i), ip: d.ip, name: d.name, vendor: d.vendor, type: d.type, brand: '', os: '', network: d.network, lastActive: now - d.minAgo * MIN, firstSeen: now - 200 * D }));

  return {
    checks: Object.fromEntries((cfg.checks ?? []).map(c => [c.id, fine(c)])),
    hostStatus: Object.fromEntries(cfg.hosts.map(h => [h.id, 'up' as Status])),
    hostRes,
    guests,
    pveStorage: Object.fromEntries(cfg.hosts.filter(h => h.type === 'proxmox').map(h => {
      const n = cfg.guests.filter(g => g.host === h.id).length;
      return [h.id, { label: `${h.name} · local-lvm`, usedGB: Math.round(120 + rnd(seedOf(h.id)) * 500), totalGB: 940, sub: `${n} guest${n === 1 ? '' : 's'}` }];
    })),
    containers,
    unraid: nas ? { arrayUsedTB: 21.4, arrayTB: 36, cacheUsedGB: 412, cacheGB: 1000, os: '7.1.4' } : null,
    unraidDisks: nas ? [['disk1', 7.1, 9], ['disk2', 6.4, 9], ['disk3', 5.2, 9], ['disk4', 2.7, 9]].map(([disk, usedTB, totalTB]) => ({ disk: disk as string, usedTB: usedTB as number, totalTB: totalTB as number })) : null,
    lanDevices: 42,
    network: {
      gwUp: true, wanUp: true, switchUp: true, segments: Object.fromEntries((cfg.network?.segments ?? []).map(x => [x.id, true])),
      ports: Object.fromEntries([...(cfg.network?.accessPoints ?? []).flatMap(a => (a.port ? [a.port] : [])), cfg.network?.switch?.mirrorPort ?? ''].filter(Boolean).map(p => [p, true])),
    },
    spotlight: cfg.spotlight?.app ? { signals: Object.fromEntries((cfg.spotlight.signals ?? []).map(x => [x.name, { now: 1, recent: 1 }])), probeAt: now - 40e3, recoveries: 0 } : null,
    promTargets: [...new Set([...cfg.hosts.map(h => h.nodeJob), ...cfg.guests.map(g => g.cadvisor), cfg.network?.gateway?.snmpJob, cfg.network?.switch?.snmpJob, 'prometheus',
      jobOf(cfg, 'homeassistant', 'homeassistant'), jobOf(cfg, 'qbittorrent', 'qbittorrent-exporter'), jobOf(cfg, 'nzbget', 'nzbget-exporter'), jobOf(cfg, 'ntfy', 'ntfy'), jobOf(cfg, 'caddy', 'caddy'), cfJob, ...otherTunnels])]
      .filter((j): j is string => !!j).map(job => ({ job, instance: '', up: true, error: null })),
    ups: {
      up: true, dataFresh: true, dataAgeSec: 8, model: 'Back-UPS 1500', upsName: 'ups', status: 'ONLINE', master: null,
      nominalV: 120, transferLowV: 100, transferHighV: 139,
      flags: { online: true, on_battery: false, low_battery: false, replace_battery: false, overload: false, comm_lost: false, shutting_down: false, slave: false, battery_present: true },
      chargePct: 100, timeLeftSec: 3180, timeLeftAvgSec: 3060, loadPct: 16, lineV: 121, onBatterySec: 0,
      nominalW: 900, shutdownChargePct: 30, shutdownTimeLeftSec: 900, shutdownOnBatterySec: 600,
      transfers: 0, lastOnBatteryAt: null, lastOffBatteryAt: null, lastTransferReason: null, daemonStartAt: now - 8 * D,
      collectorOk: true, collectorRunAt: now - 25e3, collectorOkAt: now - 25e3,
    },
    unraidHealth: nas ? {
      collectorOk: true, collectorRunAt: now - 2 * MIN, started: true, state: 'STARTED', maintenance: false, mounted: 5, unmountable: 0, mover: false,
      parity: { running: true, paused: false, progress: 0.37, speedBps: 118e6, action: 'check P', lastStartAt: now - 35 * D, lastEndAt: now - 33 * D, lastDurationSec: 93705, lastErrors: 0, lastExit: 0 },
      disks: [disk('parity', 'Parity', 31, 29796), disk('disk1', 'Data', 41, 44982, { reallocated: 8 }), disk('disk2', 'Data', 38, 44950), disk('disk3', 'Data', 39, 29710),
        disk('disk4', 'Data', 35, 12640), disk('cache', 'Cache', 39, 9120), disk('flash', 'Flash', null, null)],
    } : null,
    apt: aptHosts.length ? aptHosts.map(aptRow) : null,
    edge: {
      tunnels: [
        { job: cfJob, tunnel: 'main', main: true, up: true, conns: 4, locations: ['lhr01', 'ams02'], version: '2026.9.0' },
        ...otherTunnels.map(job => ({ job, tunnel: job, main: false, up: true, conns: 4, locations: ['lhr01'], version: '2026.9.0' })),
      ],
      ntfy: { up: true, delivered24h: 86, rejected24h: 0, rejected30m: 0 },
      caddy: { up: true, reloadOk: true, reloadAt: now - 21 * H },
    },
    sonarr: { series: 212, queued: 14, wanted: 388 },
    radarr: { movies: 846, queued: 0, missing: 41, wanted: 23 },
    qbit: { leeching: 3, seeding: 61, conn: 'connected', todayGB: 8.6 },
    nzbget: { todayGB: 12.3, queueGB: 3.4, paused: false },
    ha: ha ? {
      up: true,
      updates: [],
      climate: ha.climate ? { name: ha.climateLabel || 'Thermostat', indoor: 21.5, setpoint: 21, setpointRange: null, humidity: 38, mode: 'Heat', action: 'idle', available: true } : null,
      garage: ha.garage ? { open: false, since: garageSince > now ? garageSince - D : garageSince, obstruction: false, light: false, available: true } : null,
      moreClimates: (ha.moreClimates ?? []).map(c => ({ name: c.name, indoor: 16.8, setpoint: 10, setpointRange: null, humidity: null, mode: 'Heat', action: 'idle', available: true, battery: 75 })),
      appliances: (ha.appliances ?? []).map((a, i) => ({ kind: a.kind, name: a.name, state: a.kind === 'vacuum' ? 'docked' as const : i === 0 ? 'running' as const : 'off' as const,
        progress: null, remainingMin: i === 0 ? 42 : null, finishAt: null, battery: a.kind === 'vacuum' ? 100 : null, areaM2: null, lastAt: a.kind === 'vacuum' ? now - 20 * H : null,
        energyTodayKwh: a.kind === 'laundry' ? 0.4 : null, maintenance: a.kind === 'vacuum' ? { name: 'Filter', hoursLeft: 55 } : null })),
      lights: (ha.lights ?? []).map((l, i) => ({ name: l.name, room: l.room, on: i % 5 === 1, brightness: i % 5 === 1 ? 80 : 0, available: true })),
      smoke: (ha.smoke ?? []).map(s => ({ name: s.name, state: 'clear' as const, detail: 'online · no faults' })),
      locks: (ha.locks ?? []).map((l, i) => ({ name: l.name, state: 'locked' as const, since: now - (2 + i * 5) * H, battery: [82, 64, 91][i % 3], door: 'closed' as const })),
      printer: ha.printer ? { available: true, toner: { c: 62, m: 48, y: 71, k: 35 } } : null,
    } : null,
    jobs,
    kuma,
    grafana: [{
      name: 'Cache Capacity 90%', severity: 'warning', summary: 'cache is 91% full', since: now - 6 * H,
      labels: { severity: 'warning', grafana_folder: 'Storage', mountpoint: '/mnt/cache' },
    }],
    ntfyUp: true,
    activity: [
      { at: now - 20 * MIN, topic: 'lab-status', title: 'Health report', body: 'All checks passed', priority: 2, tags: ['white_check_mark'] },
      { at: now - 6 * H, topic: 'grafana', title: '[FIRING:1] Cache Capacity 90%', body: 'cache is 91% full', priority: 4, tags: ['warning'] },
      { at: now - 8 * H, topic: 'backups', title: 'Appdata backup finished', body: 'Backup of 24 containers done in 6 min', priority: 3, tags: ['floppy_disk'] },
      { at: now - 3 * D, topic: 'grafana', title: '[RESOLVED] Sonarr Queue Nonempty', body: 'Queue drained', priority: 2, tags: ['white_check_mark'] },
    ],
    probes,
    devices: { at: now - 2 * MIN, source: 'router', list: deviceList },
    wud: { updates: 3 },
    tautulli: { streams: 0, nowPlaying: null, others: 0, recent: ([['Arrival', '2016'], ['The Expanse', 'S6E2'], ['Dune: Part Two', '2024'], ['Severance', 'Season 2'], ['Andor', 'S2E5'], ['Blade Runner 2049', '2017'], ['Shōgun', 'New show']] as const).map(([title, sub], i) => ({ title, sub, key: `mock-${i}`, addedAt: now - [25, 300, 1440, 2880, 4320, 7200, 11520][i] * 60_000 })) },
    plexLibrary: { movies: 846, shows: 212 },
    bazarr: { episodes: 312, movies: 10 },
    seerr: { pending: 0, approved: 64, completed: 227 },
    chaptarr: { authors: 8, books: 16, booksTotal: 25, missing: 6, queued: 0 },
    plex: { mapped: true, state: 'mapped', error: '', publicPort: 32400 },
    prowlarr: { indexers: ['Usenet A', 'Usenet B', 'Torrent A', 'Torrent B'] },
    immich: { photos: 48210, videos: 1937, sizeGiB: 210.4, users: 2, version: '1.140.1' },
    weather: { tempC: 12.6, text: 'cloudy' },
    versions: {
      ...Object.fromEntries(cfg.hosts.filter(h => h.type === 'proxmox').map(h => [`Proxmox · ${h.name}`, '9.0.10 · kernel 6.14.11'])),
      ...(nas ? { Unraid: '7.1.4' } : {}), Immich: '1.140.1', Grafana: '12.2.0',
    },
  };
}

/** Library health's samples for MOCK (server/trend.ts): a week in which the subtitle backlog shrank, Sonarr's wanted
 *  list grew past 5 %, Radarr's missing barely moved, Chaptarr's didn't, and Radarr's wanted list has only 3 days of
 *  samples (no change yet). */
export function mockLibraryHistory(now = Date.now()): LibraryHistory {
  const days: LibraryHistory = {};
  for (let i = 8; i >= 1; i--) days[dayKey(now, -i)] = { bazarr: 312 + i * 12, sonarrWanted: 388 - Math.round(i * 30 / 7), radarrMissing: i >= 7 ? 39 : 41, chaptarrMissing: 6, ...(i <= 3 ? { radarrWanted: 23 } : {}) };
  return days;
}

/** Random walks for the 1 s series: each host's CPU, the WAN and the downloaders. */
export class MockSampler {
  private v: Record<string, number> = { win: 40, wout: 12 };
  private seed = 1000;
  sample(): Sample {
    this.seed += 7;
    const step = (k: string, amp: number, lo: number, hi: number, o: number) => {
      const v = this.v[k] ?? lo + (hi - lo) * 0.3;
      return (this.v[k] = Math.max(lo, Math.min(hi, v + (rnd(this.seed + o) - 0.5) * amp)));
    };
    const cpu = Object.fromEntries(config.hosts.map((h, i) => [h.id, step(`cpu:${h.id}`, 5, 2, 35, i + 1)]));
    const win = step('win', 40, 3, 95, 50), wout = step('wout', 14, 1, 45, 60);
    return { cpu, wanIn: win, wanOut: wout, qbDl: win / 10, qbUl: wout / 10, nzDl: win / 6 };
  }
}
