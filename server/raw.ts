// What the adapters collect, before derive.ts turns it into a Snapshot.
//
// Ownership rule (v3.1): every adapter returns its own Partial<Raw>, and index.ts keeps one part per
// adapter with the time of its last good answer. Before each rebuild, index.ts composes Raw from the
// parts of adapters that are still fresh (age <= maxAge), in ADAPTERS order. A stale or failing
// adapter therefore contributes nothing, and its widgets read null ('—' / 'not answering').
// Two adapters must never write the same top-level key, except the record-shaped keys in MERGE_KEYS,
// which compose by shallow merge across the fresh adapters (each adapter writes its own entries).
import type { RecentItem, Status } from '../shared/types.ts';

export const MERGE_KEYS = ['hostStatus', 'hostRes', 'versions', 'jobs'] as const;

export interface KumaMonitorRaw {
  id: number; name: string; type: string; url: string; hostname: string | null; port: string | null;
  status: Status; ms: number | null;
  /** monitor_uptime_ratio windows, as fractions 0-1 */
  up1d: number | null; up30d: number | null;
  certDays: number | null;
  /** 48 × 30-min cells (oldest first) from the CC's own samples, persisted in DATA_DIR */
  cells: Status[];
  /** epoch ms since it's been down (CC's own observation) */
  downSince: number | null;
}

export interface JobRaw {
  /** epoch ms of the last success, null = series missing */
  lastAt: number | null;
  /** last run ok: true/false, null = no such signal / series missing */
  ok: boolean | null;
  detail?: string;
  /** JobConfig.values: name → value (null: no series) */
  values?: Record<string, number | null>;
  /** 14 daily squares oldest first, or null */
  days: Status[] | null;
  /** one of the job's own expressions failed at run time: its row can't read green (status at least 'unknown') */
  error?: string;
}

export interface GuestRaw {
  host: string; vmid: number; name: string; kind: 'vm' | 'lxc'; status: Status; template: boolean;
  cpuPct: number | null; memUsed: number | null; memTotal: number | null; diskUsed: number | null; diskTotal: number | null;
  swapUsed: number | null; swapTotal: number | null; uptimeSec: number | null;
}

export type ResRaw = { cpuPct: number | null; memUsed: number | null; memTotal: number | null; swapUsed: number | null; swapTotal: number | null; diskUsed: number | null; diskTotal: number | null; load1: number | null; uptimeSec: number | null };

export interface Raw {
  // ---- proxmox adapter
  /** Host up/down. proxmox writes mf/pve (down after 3 failed polls in a row), prom-infra writes unraid, mac writes mac. */
  hostStatus: Record<string, Status> | null;
  /** Host resources, keyed by host id (proxmox: /nodes/x/status; prom-infra: Unraid node_exporter). */
  hostRes: Record<string, ResRaw> | null;
  /** Live guest list from /qemu and /lxc on every node, keyed `${hostId}:${vmid}`. */
  guests: Record<string, GuestRaw> | null;
  pveStorage: Record<string, { label: string; usedGB: number; totalGB: number; sub: string }> | null;
  /** vzdump: written into `jobs` under ids `vzdump-<hostId>` (signal proxmox-vzdump). */

  // ---- prom-infra adapter (Prometheus)
  /** Running containers per Docker LXC (cAdvisor), keyed by vmid. */
  containers: Record<number, number> | null;
  unraid: { arrayUsedTB: number; arrayTB: number; cacheUsedGB: number; cacheGB: number; os: string | null } | null;
  /** Per data disk fill, from node_filesystem on /mnt/diskN. */
  unraidDisks: { disk: string; usedTB: number; totalTB: number }[] | null;
  lanDevices: number | null;
  /** SNMP: gateway and switch answering, the WAN link, each segment's gateway interface, the switch's port links */
  network: { gwUp: boolean | null; wanUp: boolean | null; switchUp: boolean | null; segments: Record<string, boolean | null>; ports: Record<string, boolean> } | null;
  /** *Recent: max over the last 150 s, so one failed probe (a blip) can be told apart from a sustained failure */
  /** the spotlight app's readiness signals (now and the best of the last 150 s), its probe time and recoveries */
  spotlight: { signals: Record<string, { now: number | null; recent: number | null }>; probeAt: number | null; recoveries: number | null } | null;
  /** Every active Prometheus scrape target (`up` health), plus configured scrape pools with no target at all (up false). */
  promTargets: { job: string; instance: string; up: boolean; error: string | null }[] | null;

  // ---- prom-ops adapter (Prometheus): the collectors of plans H5-H13. A key is null while none of its series
  // exist ('not monitored yet'); timestamps are epoch ms, a missing series is null, never a default.
  /** H5: apcupsd on mf (slave of Unraid's master), textfile apcupsd.prom, ups="server" */
  /** homelab.json checks: id → value (null: no series) */
  checks: Record<string, number | null> | null;
  /** homelab.json storage (adapter prom-checks): name → bytes used and in all (null: no series) */
  storage: Record<string, { used: number | null; total: number | null }> | null;
  ups: UpsRaw | null;
  /** H6: Unraid array, parity and per-disk health (textfile unraid_health.prom, job node-unraid) */
  unraidHealth: UnraidHealthRaw | null;
  /** H11: apt per host/guest, only targets with apt_collector_info (VM 106's old distro collector is left out) */
  apt: AptRaw[] | null;
  /** module edge: cloudflared, ntfy and Caddy scrape jobs */
  edge: EdgeRaw | null;

  // ---- prom-media adapter (Prometheus)
  sonarr: { series: number; queued: number; wanted: number } | null;
  radarr: { movies: number; queued: number | null; missing: number; wanted: number } | null;
  qbit: { leeching: number; seeding: number; conn: 'connected' | 'firewalled' | 'disconnected' | null; todayGB?: number | null } | null;
  nzbget: { todayGB: number; queueGB: number | null; paused: boolean | null } | null;

  // ---- prom-home adapter (Prometheus, Home Assistant exporter; read-only)
  ha: {
    up: boolean | null;
    /** false only when every scrape in the last 2 min failed (a normal HA restart takes ~30 s) */
    downFor2m?: boolean;
    updates: string[];
    /** !available: HA dropped the readings, so indoor is NaN and mode '—' (placeholders, never shown). setpointRange: [low, high] in heat_cool. */
    climate: { name: string; indoor: number; setpoint: number | null; setpointRange?: [number, number] | null; humidity: number | null; mode: string; action: string | null; available: boolean } | null;
    garage: { open: boolean; since: number | null; obstruction: boolean | null; light: boolean | null; available: boolean } | null;
    lights: { name: string; room: string; on: boolean | null; brightness: number | null; available: boolean }[];
    moreClimates: ({ name: string; indoor: number; setpoint: number | null; setpointRange?: [number, number] | null; humidity: number | null; mode: string; action: string | null; available: boolean } & { battery: number | null })[];
    appliances: { kind: 'dishwasher' | 'laundry' | 'vacuum' | 'thermostat' | 'bed'; name: string; state: 'running' | 'on' | 'off' | 'cleaning' | 'charging' | 'docked' | 'heating' | 'cooling' | 'idle' | 'no-data'; progress: number | null; remainingMin: number | null; finishAt: number | null; battery: number | null; areaM2: number | null; lastAt: number | null; energyTodayKwh: number | null; maintenance: { name: string; hoursLeft: number } | null; tempC?: number | null; targetC?: number | null; humidity?: number | null; inBed?: boolean | null; sleptMin?: number | null }[];
    smoke: { name: string; state: 'clear' | 'alarm' | 'offline' | 'fault' | 'no-data'; detail: string }[];
    locks: { name: string; state: 'locked' | 'unlocked' | 'jammed' | 'unavailable' | 'no-data'; since: number | null; battery: number | null; door: 'open' | 'closed' | null }[];
    printer: { available: boolean; toner: { c: number; m: number; y: number; k: number } | null } | null;
  } | null;

  // ---- prom-jobs adapter (Prometheus) + proxmox (vzdump): keyed by job id, or `${jobId}:${labelValue}` for `by` jobs
  jobs: Record<string, JobRaw & { label?: string }> | null;

  // ---- kuma adapter
  kuma: KumaMonitorRaw[] | null;

  // ---- grafana adapter (Viewer service-account token)
  /** path: the alert rule's own page in Grafana ('/alerting/grafana/<uid>/view'), from generatorURL */
  grafana: { name: string; severity: string; summary: string; since: number | null; labels: Record<string, string>; path?: string }[] | null;

  // ---- ntfy adapter (reader token): health + recent messages (kept in DATA_DIR)
  ntfyUp: boolean | null;
  activity: { at: number; topic: string; title: string; body: string; priority: number; tags: string[] }[] | null;

  // ---- probes adapter: public endpoints and retired hosts, GET only
  probes: Record<string, { code: number | null; ms: number | null; error: string | null; at: number }> | null;

  // ---- devices adapter: the router's device list, a JSON file a job writes every few minutes (read-only here)
  /** at: when the job wrote it (epoch ms); list: one entry per MAC, normalised (missing text '', missing time null) */
  devices: { at: number; source: string; list: DeviceRaw[] } | null;

  // ---- app adapters
  wud: { updates: number } | null;
  tautulli: { streams: number; nowPlaying: { title: string; sub: string; user: string; progress: number; poster?: string; state: string } | null; others: number; recent: RecentItem[] } | null;
  plexLibrary: { movies: number; shows: number } | null;
  bazarr: { episodes: number; movies: number } | null;
  seerr: { pending: number; approved: number; completed: number } | null;
  prowlarr: { indexers: string[] } | null;
  chaptarr: { authors: number; books: number; booksTotal: number; missing: number; queued: number } | null;
  /** Plex's own remote-access check (myplex/account): mapped = plex.tv reached it from outside */
  plex: { mapped: boolean; state: string; error: string; publicPort: number | null } | null;
  immich: { photos: number; videos: number; sizeGiB: number; users: number; version: string } | null;
  weather: { tempC: number; text: string } | null;
  /** live version strings by the names shown in Software (e.g. 'Proxmox · pve1', 'Unraid', 'Immich', 'Grafana') */
  versions: Record<string, string> | null;
}

export interface DeviceRaw {
  mac: string; ip: string; name: string; vendor: string; type: string; brand: string; os: string;
  /** 'LAN', a segment's name, or whatever else the router calls a network */
  network: string;
  /** epoch ms */
  lastActive: number | null; firstSeen: number | null;
}
export interface UpsRaw {
  up: boolean | null;
  /** false: COMMLOST or the master's data older than 120 s (the collector then leaves the measured values out) */
  dataFresh: boolean | null; dataAgeSec: number | null;
  model: string | null; upsName: string | null; status: string | null;
  /** the apcupsd NIS master this host polls ('10.20.0.30:3551'), when it is a client */
  master: string | null;
  nominalV: number | null; transferLowV: number | null; transferHighV: number | null;
  /** apcupsd_status_flag{flag}: online, on_battery, low_battery, replace_battery, overload, comm_lost, battery_present, … */
  flags: Record<string, boolean>;
  chargePct: number | null; timeLeftSec: number | null; timeLeftAvgSec: number | null; loadPct: number | null; lineV: number | null; onBatterySec: number | null;
  nominalW: number | null; shutdownChargePct: number | null; shutdownTimeLeftSec: number | null; shutdownOnBatterySec: number | null;
  /** since mf's apcupsd started (it resets on restart) */
  transfers: number | null; lastOnBatteryAt: number | null; lastOffBatteryAt: number | null; lastTransferReason: string | null; daemonStartAt: number | null;
  collectorOk: boolean | null; collectorRunAt: number | null; collectorOkAt: number | null;
}
export interface UnraidDiskRaw {
  disk: string; type: string; status: string | null; ok: boolean | null; tempC: number | null; errors: number | null; spundown: boolean | null; fsMounted: boolean | null;
  failingNow: number | null; failedPast: number | null; reallocated: number | null; pending: number | null; offlineUncorrectable: number | null; crc: number | null; reportedUncorrect: number | null;
  /** reallocated / 187 / CRC rise over 7 days (null until 7 days of history exist) */
  grown: number | null;
  powerOnHours: number | null;
}
export interface UnraidHealthRaw {
  collectorOk: boolean | null; collectorRunAt: number | null;
  started: boolean | null; state: string | null; maintenance: boolean | null; mounted: number | null; unmountable: number | null; mover: boolean | null;
  parity: {
    running: boolean | null; paused: boolean | null; progress: number | null; speedBps: number | null; action: string | null;
    lastStartAt: number | null; lastEndAt: number | null; lastDurationSec: number | null; lastErrors: number | null; lastExit: number | null;
  };
  disks: UnraidDiskRaw[];
}
export interface AptRaw {
  job: string; instance: string; host: string | null;
  pending: number | null; held: number | null; security: number | null; securitySince: number | null;
  reboot: boolean | null; rebootSince: number | null; kernel: { running: string; expected: string } | null;
  collectorOk: boolean | null; collectorRunAt: number | null; cacheAt: number | null;
}
export interface EdgeRaw {
  /** one per cloudflared scrape job; conns null when the target is down */
  tunnels: { job: string; tunnel: string; main: boolean; up: boolean | null; conns: number | null; locations: string[]; version: string | null }[];
  ntfy: { up: boolean | null; delivered24h: number | null; rejected24h: number | null; rejected30m: number | null } | null;
  caddy: { up: boolean | null; reloadOk: boolean | null; reloadAt: number | null } | null;
}

export const emptyRaw = (): Raw => ({
  hostStatus: null, hostRes: null, guests: null, pveStorage: null, containers: null, unraid: null, unraidDisks: null, lanDevices: null,
  network: null, spotlight: null, promTargets: null,
  checks: null, storage: null, ups: null, unraidHealth: null, apt: null, edge: null,
  sonarr: null, radarr: null, qbit: null, nzbget: null, ha: null,
  jobs: null, kuma: null, grafana: null, ntfyUp: null, activity: null, probes: null, devices: null, wud: null, tautulli: null, plexLibrary: null,
  bazarr: null, seerr: null, prowlarr: null, plex: null, chaptarr: null, immich: null, weather: null, versions: null,
});

/** Fast series sample (1/s). null = that source didn't answer this second. */
export interface Sample { cpu: Record<string, number | null>; wanIn: number | null; wanOut: number | null; qbDl: number | null; qbUl: number | null; nzDl: number | null }
