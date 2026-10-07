// Contract between the backend and the page. The backend builds a Snapshot (slow data, every
// 10 s) and a Tick (fast series, 1/s) and pushes both over SSE.
//
// Freshness rule (v3.1): nothing on the page may show an old value as if it were current.
// Every adapter has a max age; once its last good answer is older than that, the server drops the
// adapter's data before derive() runs, so widgets fall back to '—' / 'not answering', and the
// source shows up in Snapshot.fresh and in Needs attention. Ages are sent as epoch ms and turned
// into "3 h ago" at derive time (every 10 s), never baked in at poll time.

export type Status = 'up' | 'degraded' | 'down' | 'unknown';
/** Per-adapter connection state. 'not-connected' = no credentials configured (never a crash). 'stale' = was ok, last good answer older than its max age. */
export type Conn = 'ok' | 'stale' | 'error' | 'not-connected' | 'mock';
/** danger: something is down or failing now. warn: needs a look (stale data, failed/old backup, near full). info: known, chronic or cosmetic; never changes the status line. */
export type Severity = 'danger' | 'warn' | 'info';
export type Tone = 'ok' | 'warn' | 'danger';
/** One integration a lab may or may not have (server/modules.ts). */
export type ModuleId =
  | 'proxmox' | 'prometheus' | 'network' | 'kuma' | 'grafana' | 'ntfy' | 'probes' | 'devices' | 'weather' | 'hostprobe'
  | 'plex' | 'sonarr' | 'radarr' | 'bazarr' | 'prowlarr' | 'chaptarr' | 'seerr' | 'qbittorrent' | 'nzbget' | 'immich' | 'wud'
  | 'homeassistant' | 'spotlight' | 'ups' | 'unraid' | 'apt' | 'edge' | 'checks';
/** on: polled and shown. not-connected: listed in `modules` but missing a key or URL (the page says which). off: hidden. */
export type ModuleState = 'on' | 'not-connected' | 'off';

// ---------- config (config/homelab.json, re-read when the file changes)
export interface HomelabConfig {
  domain: string;
  /** The integrations this lab has. Absent: inferred from .env and the rest of this file (server/modules.ts). */
  modules?: ModuleId[];
  /** How the page looks and what it calls things (all optional). */
  ui?: UiConfig;
  /** Prometheus details for the modules that read it (all optional): the scrape job names this lab uses, and any
   *  built-in query to replace, by its key (docs/INTEGRATIONS.md lists them). */
  prometheus?: {
    jobs?: { homeassistant?: string; qbittorrent?: string; nzbget?: string; caddy?: string; ntfy?: string; cloudflared?: string };
    queries?: Record<string, string>;
  };
  /** module ups: what to call it, and the host whose apcupsd reports it (the one that shuts down on its own thresholds) */
  ups?: { name?: string; host?: string };
  /** module edge: the cloudflared job of the tunnel that carries the public endpoints (default: the first) */
  edge?: { mainTunnelJob?: string };
  /** module apt: when updates get applied, said on the update items (e.g. 'monthly window') */
  apt?: { window?: string };
  /** module spotlight: the one app Overview keeps in view (its own block beside Plex and Recent activity), with
   *  readiness signals from Prometheus. Each signal is a 1 (ready) / 0 expression; its role says which of the app's
   *  paths it speaks for (lan and public merge into the app's LAN and public checks, other stands on its own). A signal
   *  at 0 counts as down only once it stayed 0 for 150 s; a shorter dip shows amber in the block and raises nothing. */
  spotlight?: {
    app: string;
    signals?: { name: string; query: string; role?: 'lan' | 'public' | 'other' }[];
    /** epoch seconds of the probe's last run: older than 3 min and the signals no longer count */
    probeQuery?: string;
    /** a counter of automatic recoveries, shown when not 0 */
    recoveriesQuery?: string;
    /** homelab.json jobs shown in the block (its backup and restore test), and the one that runs the probe */
    backupJob?: string; restoreJob?: string; probeJob?: string;
    /** what the block calls its backup job's last run (default 'Last backup'), e.g. 'Last dump' */
    backupLabel?: string;
  };
  /** Your own Prometheus checks (module checks): a row each under Health › Alerting, and a Needs attention item once
   *  past warn / danger. */
  checks?: CheckConfig[];
  /** More rows for Health › Storage, each read from Prometheus (an off-site box, a cloud bucket): two PromQL queries
   *  returning bytes. Past attentionRules.diskWarnPct / diskDangerPct it turns amber / red like the other volumes. */
  storage?: StorageConfig[];
  /** IANA zone for clock times on the page (e.g. 'Europe/London'). Default: TZ, else the system's zone. */
  timezone?: string;
  /** for the weather (Open-Meteo); leave out for no weather */
  location?: { name: string; lat: number; lon: number };
  network: {
    /** the LAN, e.g. '10.20.0.0/24': addresses in it are shown as '.42' */
    subnet: string;
    /** The router / firewall between the internet and the LAN, drawn above the switch. Leave out to draw none.
     *  snmpJob: its snmp_exporter job (up = answering; wanIf's ifOperStatus = the WAN link). */
    gateway?: { id: string; name: string; ip: string; os?: string; kind?: string; snmpJob?: string; wanIf?: string };
    /** The switch the hosts hang off. Leave out to draw none. snmpJob: its snmp_exporter job (port link states). */
    switch?: { id: string; name: string; model?: string; ip: string; firmware?: string; eol?: boolean; mirrorPort?: string; snmpJob?: string };
    /** port: the switch port it's on (its link state is the AP's); segment: the segment it serves (it shares that state) */
    /** short: a shorter model for the map's segment label (default: model) */
    accessPoints?: { name: string; ip: string; port?: string; segment?: string; model: string; short?: string }[];
    /** Other networks behind the gateway (a guest Wi-Fi, an extender): gatewayIf's ifOperStatus is its state; prefix
     *  ('10.30.0') files the device list's addresses on it. */
    segments?: { id: string; name: string; prefix?: string; gatewayIf?: string }[];
    /** what carries the public endpoints, drawn beside the Internet pill (e.g. 'Cloudflare tunnel'); leave out for none */
    tunnel?: string;
    /** A LAN device count from Prometheus (e.g. ntopng): the query, its source's name and a note for the tooltip. */
    deviceCount?: { query: string; source: string; note?: string };
  };
  /** Everything the internet can reach. Probed by the backend (GET, every 5 min) so status and orphans are live. */
  publicEndpoints: PublicEndpointConfig[];
  /** Host names that used to be public. Shown as an orphan only while they still resolve and answer with the tunnel's 404/5xx. */
  retiredHosts: string[];
  hosts: HostConfig[];
  /** Enrichment for Proxmox guests (the guest list itself is live from the Proxmox API). */
  guests: GuestConfig[];
  /** Apps that aren't a Caddy web UI (Unraid containers, public apps). Shown as Unraid leaves, in Launch, ⌘K and Links → My apps. */
  apps: AppConfig[];
  macRoles: string[];
  /** web UI name → its LAN address, '.42:8989' (on the subnet) or 'host:port' */
  webUis: Record<string, string>;
  /** How a web UI's link is written: {name} {domain} {ip} {port}. Default 'http://{ip}:{port}'; behind a reverse proxy
   *  with a wildcard name, e.g. 'https://{name}.{domain}'. */
  uiUrl?: string;
  /** a web UI's full URL when the template doesn't fit it (e.g. a Proxmox console on https://10.20.0.10:8006) */
  uiUrls?: Record<string, string>;
  /** The reverse proxy every https://*.<domain> web UI goes through: when its Kuma monitor (kumaAliases →
   *  'infra:<name, lower-case>') is down, one item explains the web UIs that are down because of it. */
  reverseProxy?: { name: string };
  /** Where a web UI's app lives when it isn't '/', e.g. { plex: '/web/index.html' } (Plex answers 401 at '/').
   *  Used for WebUi.url (Launch, ⌘K, panels); Kuma matching stays keyed by the bare host. */
  uiPaths?: Record<string, string>;
  uiLabels: Record<string, string>;
  /** Kuma monitor_id → web UI / app / infra key, for monitors the URL matcher can't place (e.g. a port monitor). */
  kumaAliases: Record<string, string>;
  /** [name, url]. url may be a bare domain (https:// is added) or a full URL with a path. Only the seed: once the
   *  Links tab has been saved from the page, DATA_DIR/links.json wins (server/links.ts). */
  links: Record<string, [string, string][]>;
  attentionRules: { bazarrMissingSubtitlesAbove: number; wudUpdatesAbove: number; diskWarnPct: number; diskDangerPct: number; arrayWarnPct?: number; cacheWarnPct?: number; certWarnDays: number; lockBatteryWarnPct: number };
  /** Every scheduled job with a machine-readable signal, plus the ones without (signal: none, shown as 'not monitored'). */
  jobs: JobConfig[];
  devices: { name: string; ip: string; note: string; hue: number }[];
  mediaAlsoRunning: string[];
  /** the House tab (module homeassistant); leave out without Home Assistant */
  homeAssistant?: {
    climate: string; climateLabel: string; humidity: string | null; garage: string; garageObstruction: string | null; garageLight: string | null;
    /** shown on Home → Lights, read-only, in this order */
    lights?: { entity: string; name: string; room: string }[];
    /** more thermostats, drawn like the main one under it (garage) */
    moreClimates?: { name: string; entity: string; battery?: string }[];
    /** Home → Appliances, read-only. laundry/dishwasher: power switch (+ remaining time, progress, finish time, energy today);
     *  vacuum: cleaning/charging binaries, progress, battery, area, last clean end, maintenance time-left sensors (hours);
     *  thermostat: climate (+ temperature, humidity, battery); bed (a heated mattress side): climate action, bed temperature, target, presence, time slept */
    appliances?: { kind: 'dishwasher' | 'laundry' | 'vacuum' | 'thermostat' | 'bed'; name: string; power?: string; climate?: string; temperature?: string; humidity?: string; target?: string; presence?: string; slept?: string; remaining?: string; progress?: string; finish?: string; energyToday?: string;
      cleaning?: string; charging?: string; battery?: string; area?: string; lastEnd?: string; maintenance?: { name: string; entity: string }[] }[];
    /** Kidde detectors: entity ids are `${prefix}_smoke_alarm`, `_co_alarm`, `_too_much_smoke`, `_hardwire_smoke_alarm`, `_online`, `_lost`, `_contact_lost`, `*_fault`, sensor `${sensorPrefix}_last_seen`. */
    smoke: { name: string; prefix: string; sensorPrefix: string }[];
    printer: { entity: string; model: string; toner: Record<'c' | 'm' | 'y' | 'k', string> } | null;
    backup: string | null;
    /** The real door locks (not a garage opener's remote-lockout switch). */
    locks: { name: string; entity: string; battery?: string; jammed?: string; door?: string }[];
  };
  /** [name, version, badge, asOf]: only for things no adapter can read (router, switch firmware). Shown as 'manual · as of <asOf>'. */
  versions: [string, string, string, string][];
}
export interface CheckConfig {
  id: string; name: string;
  /** PromQL that returns one number (the first series counts); no series reads 'no data'. Leave out with `kuma`. */
  query?: string;
  /** instead of a query: Uptime Kuma monitor ids; the value is 1 while every one is up and 0 once one is down (pending
   *  or in maintenance reads 0.5). Pair it with `words` and `below`/`danger` (e.g. danger 1, below true). */
  kuma?: number[];
  /** 'ago': the value is an epoch time in seconds, shown as 'just now' / '4 min ago'; warn and danger are then ages in
   *  seconds (past them is worse). Default: a number. */
  format?: 'number' | 'ago';
  /** the row's text, with {value} for the value, e.g. 'last run {value}' */
  text?: string;
  /** a word for an exact value, e.g. { "1": "reachable", "0": "not reachable" } */
  words?: Record<string, string>;
  /** thresholds: past warn is amber, past danger red. below: true when lower is worse (e.g. mounts ready). */
  warn?: number; danger?: number; below?: boolean;
  /** shown after the value, e.g. '°C', '%', ' h' */
  unit?: string;
  /** where it runs or what it watches, under the name */
  where?: string;
  /** the attention item's detail; {value} is replaced by the value */
  detail?: string;
  /** a page to fix it from (the item's action) */
  link?: string;
  /** a homelab.json job behind this check: the row takes the worse of the two tones and the job leaves Automation */
  job?: string;
}
export interface UiConfig {
  /** the page and login title (default 'Overlook') */
  title?: string;
  /** the header's second line names the lab by this (default: domain) */
  brand?: string;
  launcher?: {
    /** Open's groups in order: [title, web UI / app names]. Replaces the defaults (shared/ui.ts). */
    groups?: [string, string[]][];
    /** Open's columns, each a list of group titles stacked top to bottom (default: one group per column) */
    columns?: string[][];
    /** names left out of Open (still found by search), e.g. the dashboard itself */
    hidden?: string[];
    /** the phone incident hero's eight shortcuts, in order (the ones the lab has) */
    phonePins?: string[];
  };
  /** display names by web UI / app name (adds to uiLabels and the product names) */
  names?: Record<string, string>;
  /** extra search words by name, e.g. { "pve1": "main proxmox" } */
  aliases?: Record<string, string>;
  /** two-character tile monograms by name, when the first two letters collide */
  monograms?: Record<string, string>;
  /** hosts unfolded on the phone's network list at first (default: the first host) */
  openHosts?: string[];
  /** how qBittorrent reaches the internet, shown under it on Media, e.g. 'a VPN container · WireGuard' */
  qbittorrentVia?: string;
}
/** UiConfig resolved against the product defaults (shared/ui.ts): what the page reads. */
export interface UiView {
  title: string; brand: string;
  groups: [string, string[]][]; columns: string[][]; hidden: string[]; phonePins: string[];
  names: Record<string, string>; aliases: Record<string, string>; monograms: Record<string, string>;
  openHosts: string[];
  /** the gateway's tile on the map: monograms[network.gateway.id], else 'GW' */
  gatewayMonogram: string;
  /** UiConfig.qbittorrentVia ('' when not set) */
  qbittorrentVia: string;
  /** '10.20.0': LAN addresses are shown as '.42' */
  lanPrefix: string;
}
export interface PublicEndpointConfig {
  name: string; host: string; via: 'tunnel' | 'port-forward' | 'direct';
  /** via tunnel: the cloudflared job of the tunnel that carries it, when it isn't the main one */
  tunnelJob?: string;
  /** not reachable from outside is red rather than amber (its app's `critical` counts too) */
  critical?: boolean;
  /** HTTP codes that mean healthy (e.g. [401] for Cloudflare Access, [200, 301, 302, 307]). */
  expect: number[];
  /** What's behind it, e.g. 'Seerr · media :5055'. */
  origin: string;
  access?: string; app?: string; path?: string;
  /** port-forward entries aren't probed over HTTP (no safe GET); shown as configured. */
  probe?: boolean;
  /** a port-forward with its own check: 'plex' = Plex's remote-access mapping (adapter plex) */
  check?: 'plex';
}
export interface HostConfig {
  id: string; name: string; type: 'proxmox' | 'unraid' | 'mac'; ip: string; altIp?: string; port?: string; portLabel?: string;
  /** a shorter name for tight spots (the phone's network list); default: name */
  short?: string;
  /** Hardware only (CPU, RAM, disks). OS version and capacity come from live sources. */
  hardware: string; api?: string; pveNode?: string;
  /** the CPU sparkline's least full scale in % (default 40; a desktop that idles higher reads better at 50) */
  cpuScale?: number;
  /** Proxmox: the env prefix of this node's API token (<prefix>_TOKEN_ID, <prefix>_TOKEN_SECRET). Default PVE_<ID>. */
  tokenEnv?: string;
  /** Prometheus node_exporter job for this host (up, memory, load), e.g. node-pve1, node-nas. */
  nodeJob?: string;
}
export interface GuestConfig {
  host: string; vmid: number; name: string; kind: 'vm' | 'lxc'; ip: string; desc?: string;
  services: string[]; devices?: string[];
  /** cAdvisor job for a Docker LXC, e.g. cadvisor-102-media. */
  cadvisor?: string;
  /** false: a stopped state is expected (no attention item). Default true. */
  expectRunning?: boolean;
}
export interface AppConfig {
  name: string; label: string; host: string; url?: string; publicUrl?: string;
  /** Kuma monitor ids that watch this app (worst wins). */
  kuma?: number[];
  critical?: boolean; note?: string;
  /** a tool started by hand when needed (qdirstat): no monitor and usually stopped, so it isn't drawn on the network map
   *  as if it were a running service; it stays in Launch, ⌘K and Links → My apps */
  onDemand?: boolean;
  /** job ids (homelab.json jobs) that also speak for this app, for one no Kuma monitor or probe can watch: worst
   *  wins and the app counts as monitored; a failure is reported by the job's own item, not a second one */
  jobs?: string[];
}
export interface JobConfig {
  id: string; name: string; group: 'backup' | 'automation';
  /** Where it runs and where it writes, e.g. 'NAS → off-site'. */
  where: string; schedule: string;
  /** Older than this = warn. */
  maxAgeH: number;
  signal: 'prometheus' | 'proxmox-vzdump' | 'ntfy' | 'none';
  /** prometheus: expression returning the last-success epoch (seconds). */
  last?: string;
  /** prometheus: expression returning 1 (last run ok) / 0 (failed). Missing series = unknown, not ok. */
  ok?: string;
  /** prometheus: one row per value of this label (e.g. 'source' for Kopia, 'ct' for a per-container job). */
  by?: string;
  /** proxmox-vzdump: host id. */
  node?: string;
  /** ntfy: the topic whose newest message marks a run (title matched by `match`, a case-insensitive regex, when given). */
  topic?: string; match?: string;
  /** a failure is danger rather than warn (the backup of something that matters most). */
  critical?: boolean;
  /** Grafana alertname pattern (case-insensitive regex) for this job's own alerts, when its id doesn't spell them
   *  (db-pull ↔ 'Database Backup Pull Stale'); a firing match folds into the job's item. */
  alert?: string;
  link?: string; runbook?: string;
  /** signal none: why there is no signal and what would add one. */
  note?: string;
  /** Health groups rows that share a family into one line ('Apps → NAS'); a `by` job's family defaults to its name. */
  family?: string;
  /** the job's label inside its family's line ('Paperless'); a `by` row uses its label value. */
  short?: string;
  /** A line of facts on the job's row, from `values`: '{ready}/{total} mounts · {new} new at {at:clock}'. Each
   *  {name} is a value, shown as a number, or with :clock (epoch s → '4:06 AM'), :day ('Oct 29'), :ago ('3 h ago') or
   *  |word (the word instead of a 0: '{paused|none} paused'). A ' · ' part whose value has no series is left out.
   *  Not for `by` jobs. */
  detail?: string;
  /** PromQL per name used in `detail`; each returns one number (the first series counts) */
  values?: Record<string, string>;
}
export interface StorageConfig {
  name: string;
  /** PromQL returning bytes used and bytes in all */
  used: string; total: string;
  /** the line under it (default: what's free) */
  sub?: string;
}

// ---------- snapshot
export interface Kpi { id: string; label: string; value: string; sub: string; tone?: 'pub' | 'danger' | 'warn' }
export interface Attention { id: string; title: string; detail: string; severity: Severity; source: string; since?: number | null; action?: { label: string; href: string } }

export interface SourceView {
  name: string; label: string; conn: Conn;
  /** epoch ms of the last good answer */
  lastOk: number | null; ageSec: number | null; everySec: number; maxAgeSec: number;
  error: string | null;
  /** when not connected: what it needs (e.g. 'a Grafana Viewer service-account token') */
  needs?: string;
}
/** Resources, all nullable: a value we can't read is null, never a guess. */
export interface Res { cpuPct: number | null; memUsed: number | null; memTotal: number | null; swapUsed: number | null; swapTotal: number | null; diskUsed: number | null; diskTotal: number | null; load1: number | null; uptimeSec: number | null }

export interface WebUi {
  name: string; target: string; url: string; public: boolean; status: Status; ms: number | null;
  owner: { kind: 'host' | 'guest'; id: string } | null;
  /** false: no Uptime Kuma monitor watches it (status is then always 'unknown') */
  monitored: boolean;
}
export interface AppView {
  name: string; label: string; host: string; url: string | null; publicUrl: string | null; status: Status; monitored: boolean; critical: boolean; note: string;
}
export interface GuestView {
  id: string; host: string; vmid: number; name: string; kind: 'vm' | 'lxc'; ip: string; type: string;
  /** running containers (cAdvisor), null when not a Docker LXC or no data */
  containers: number | null; services: string[]; devices: string[]; status: Status; public: boolean;
  ui: { name: string; port: string; public: boolean; url: string }[];
  res: Res | null;
  /** true when the guest is in Proxmox but not in homelab.json (shown with an 'undocumented' tag) */
  undocumented: boolean;
  /** true when it's in homelab.json but Proxmox doesn't list it */
  missing: boolean;
  /** H11: apt on this guest (VM 106), when its collector exists */
  updates?: UpdatesView;
}
export interface LeafView {
  key: string; kind: 'vm' | 'lxc' | 'app' | 'role'; tag: string; name: string; count: string; public: boolean; status: Status; guestId?: string; url?: string | null;
  /** false: nothing watches it (drawn as a hollow dot, as in Launch) */
  monitored?: boolean;
}
export interface HostView {
  id: string; name: string; short: string; mono: string; hue: number; ip: string; ipS: string;
  /** live OS/version string (e.g. 'PVE 9.2.20 · kernel 7.0.14'), '—' when unknown */
  os: string; hw: string;
  status: Status; summary: string; listLabel: string; leaves: LeafView[]; url: string | null;
  /** the CPU sparkline's least full scale, % */
  cpuScale: number;
  res: Res | null;
  /** module apt: this host's updates, when its collector exists */
  updates?: UpdatesView;
}
export interface Monitor {
  /** web UI / app key, or 'kuma:<id>' for an unmapped monitor */
  name: string; label: string; kumaId: number | null; status: Status; cells: Status[]; ms: number | null;
  /** from Uptime Kuma's own monitor_uptime_ratio (window 30d / 1d), percent; null when Kuma doesn't report it */
  uptime30: number | null; uptime1: number | null;
  certDays: number | null; downMin?: number; mapped: boolean;
}
export interface JobView {
  id: string; name: string; group: 'backup' | 'automation'; where: string; schedule: string;
  status: Status;
  /** epoch ms of the last success; null = no data */
  lastAt: number | null;
  /** '3 h ago', computed at derive time */
  lastAgo: string;
  /** one line: why it's not ok, or a useful fact ('7/7 guests', '16.4 MB') */
  detail: string;
  /** 14 daily squares, oldest first; null when the source has no history */
  days: Status[] | null;
  signal: JobConfig['signal'];
  link?: string;
  /** a failure is danger (red) rather than warn (amber), the same tier as its Needs attention item */
  critical?: boolean;
  /** JobConfig.family (a `by` job: its name): rows sharing it make one line on Health */
  family?: string;
  /** the row's label inside its family's line: the `by` label value, or JobConfig.short */
  short?: string;
}
export interface Volume {
  name: string; used: string; cap: string; pct: number; sub: string; tone: Tone;
  /** the volume this one is part of ('Unraid array' for its disks and cache): Health draws it as a line under that row */
  under?: string;
  /** its figures can't be vouched for right now (a volume not read for hours): the row shows this instead of a bar */
  missing?: string;
}

// ---------- the collectors of plans H5-H13 (adapter prom-ops). Each area is null until its metrics exist, and its
// measured values are null whenever its collector is stale: nothing old is shown as current.
/** grey 'none' = no data (not monitored, not answering); 'info' never changes the status line */
export type OpsTone = Tone | 'info' | 'none';
/** A row in Health's Power, Unraid disks and Edge lists: dot, name, one sub-line, a value on the right. */
export interface OpsLine { id: string; name: string; sub: string; value: string; tone: OpsTone; title?: string }
/** H5: the server UPS as mf's apcupsd (slave of Unraid's) sees it. */
export interface PowerView {
  name: string; model: string | null;
  /** 'On mains', 'On battery', 'Battery low', 'Replace battery', 'Overload', 'No battery', 'Stale' */
  state: string; tone: Tone;
  /** false: the measured values below are null (collector stale, master lost); `sub` says why */
  fresh: boolean;
  sub: string;
  chargePct: number | null;
  /** on mains the 5-min average (apcupsd's estimate swings 43-53 min), on battery the live value */
  runtimeMin: number | null;
  loadPct: number | null; loadW: number | null; lineV: number | null;
  onBatterySec: number | null;
  /** on battery: seconds until mf's own apcupsd shuts it down (10 min on battery, or 15 min / 30 % left) */
  shutdownSec: number | null;
  /** the host that shuts down (homelab.json ups.host), null when not named */
  shutdownHost: string | null;
  /** history and shutdown thresholds, one line each */
  lines: OpsLine[];
  /** epoch ms of the collector's last run */
  readAt: number | null;
}
/** H6: one Unraid disk's health (fill stays under Storage). */
export interface DiskHealthView {
  disk: string; type: string;
  /** danger: not OK / not mounted; warn: errors, pending, failing SMART attribute or a 7-day rise */
  tone: OpsTone;
  /** 'OK', or Unraid's own word ('DISK_DSBL', 'not mounted') */
  status: string;
  tempC: number | null; spundown: boolean;
  /** 'SMART ok' or what's wrong ('2 pending · 1 CRC') */
  smart: string;
  /** power-on hours from the SMART cache */
  hours: number | null;
}
export interface DisksView {
  /** the array and parity check lines */
  lines: OpsLine[];
  /** a running parity check, 0-1 (null when none runs) */
  parityProgress: number | null;
  /** problems first; [] while stale */
  rows: DiskHealthView[];
  /** why the values are hidden (collector stale or failing) */
  stale: string | null;
  readAt: number | null;
}
/** H11: apt on one host or guest (only those with apt_collector_info). */
export interface UpdatesView {
  id: string; name: string; kind: 'host' | 'guest';
  /** HostView.id or GuestView.id */
  ownerId: string;
  pending: number | null; security: number | null; held: number | null;
  securitySince: number | null; reboot: boolean | null; rebootSince: number | null;
  kernel: { running: string; expected: string } | null;
  /** '18 · 9 security', 'up to date', '—' when the collector is stale */
  value: string;
  /** 'since Oct 5 · no reboot needed', 'reboot needed since Oct 3 (…-20 installed, …-19 running)', 'not answering · last run 3 h ago' */
  sub: string;
  /** info: pending updates or a reboot (the status line ignores them); warn: security > 14 d, reboot > 7 d, collector stale */
  tone: OpsTone;
}
export interface OpsView {
  power: PowerView | null;
  disks: DisksView | null;
  /** H12 tunnels, Caddy, ntfy; problems first */
  edge: OpsLine[] | null;
  updates: UpdatesView[] | null;
  /** areas with nothing to show yet and why: 'not monitored yet' (no metrics), 'not answering' (Prometheus) */
  missing: { id: string; name: string; why: string; needs: string }[];
}

/** Devices: the router's device list (adapter devices), matched against homelab.json by IP. */
export interface DeviceRow {
  /** React key and ⌘K anchor ('dev-<key>'): the MAC, or 'cfg-…' for a config entry the list doesn't have */
  key: string;
  /** config name > the list's name > vendor > MAC */
  name: string;
  /** full address(es), ' · ' between several (a config entry with two); '' when unknown */
  ip: string;
  /** 'vendor · type', or the config's note */
  sub: string;
  vendor: string; mac: string;
  /** infra: its own source first (Proxmox, SNMP, the host probe), else the list's; others: online = active within 30 min */
  status: Status;
  /** epoch ms, from the device list */
  lastActive: number | null;
}
export interface DevicesView {
  /** the device list is fresh; false: only the config's infra and smart-home rows, status from their own sources */
  live: boolean;
  /** when the Mac mini job wrote the list (epoch ms) */
  at: number | null;
  /** null while the list isn't fresh. known: active within 30 days; older: every device not seen for 30 days (not listed) */
  /** segments: one per network.segments entry, in config order */
  counts: { lanOnline: number; lanKnown: number; segments: { id: string; name: string; online: number; known: number }[]; older: number } | null;
  /** infra (config order), home (config order), lan and one `seg:<id>` per segment (online first, then by IP) */
  groups: { id: string; title: string; rows: DeviceRow[] }[];
}

export interface Snapshot {
  at: number;
  /** which integrations are on, missing a key, or off (the page hides what's off) */
  modules: Record<ModuleId, ModuleState>;
  /** names, groups, aliases and the like (homelab.json `ui` over the product defaults) */
  ui: UiView;
  /** build id of the served page; the page reloads itself when it changes */
  build: string;
  mock: boolean;
  incident: boolean;
  /** ?simulateIncident=1: the data is real but one failure is made up (the page says SIMULATED) */
  simulated?: boolean;
  sources: SourceView[];
  fresh: { ok: boolean; stale: string[]; errors: string[] };
  weather: { tempC: number; text: string; place: string } | null;
  status: { tone: Tone; ok: boolean; short: string; label: string; headline: string };
  kpis: Kpi[];
  network: {
    subnet: string;
    /** the router / firewall (homelab.json network.gateway); null when the lab names none */
    gateway: { name: string; ipShort: string; status: Status; wan: Status; devices: number | null; devicesSource: string | null; devicesNote: string } | null;
    /** reachability from outside, from the public probes / Kuma public monitors: down = internet or tunnel down */
    internet: Status;
    /** the switch the hosts hang off; null when the lab names none */
    switch: { name: string; ipShort: string; status: Status; mirror: string | null; firmware: string | null; eol: boolean; aps: number } | null;
    aps: { name: string; port: string; status: Status }[];
    /** other networks behind the gateway (network.segments) */
    segments: { id: string; label: string; status: Status }[];
    publicCount: number;
    /** what carries the public endpoints (network.tunnel), e.g. 'Cloudflare tunnel'; null: no pill */
    tunnelName: string | null;
    /** the tunnel's connections (cloudflared metrics, module edge); absent while not monitored */
    tunnel?: { conns: number | null; status: Status; text: string };
  };
  hosts: HostView[];
  guests: GuestView[];
  uis: WebUi[];
  apps: AppView[];
  attention: Attention[];
  /** recent notifications from the ntfy topics (newest first, last 7 days, kept across restarts); null = not connected */
  activity: { at: number; topic: string; title: string; body: string; level: 'danger' | 'warn' | 'info' | 'ok' }[] | null;
  /** Grafana alerts that are firing now; null = not connected (see sources) */
  alerts: { name: string; severity: Severity; summary: string; since: number | null; url: string }[] | null;
  /** the spotlight app's block (homelab.json spotlight); signals: LAN, Public and its own 'other' signals */
  spotlight: {
    name: string; status: Status;
    signals: { name: string; status: Status }[];
    /** probed: the lab names a probe (spotlight.probeQuery); probeAgeSec null then means no probe data */
    probed: boolean; probeAgeSec: number | null; autoRecoveries: number | null;
    backupAt: number | null; restoreAt: number | null; backupJob: string | null; restoreJob: string | null;
    /** spotlight.backupLabel (optional: an older server sends none, and the page says 'Last backup') */
    backupLabel?: string;
    url: string;
  } | null;
  /** recent[].sub (review finding 16, additive and optional): the line under a Recently added poster, 'S2E5', 'Season 2',
   *  'New show' or a movie's year; an older server sends none and the poster shows only its title.
   *  recent[].key and .addedAt (review 3f, additive and optional): Tautulli's rating key and added_at (epoch ms). The
   *  page needs them to tell an arrival from the list it already shows (a title repeats across one show's episodes,
   *  and the poster is the show's) and to mark what was added in the last hour (NEW); neither can be worked out from
   *  the rest. An older server sends neither: no NEW tags, and arrivals are told apart by title, line and poster. */
  plex: { streams: number | null; movies: number | null; shows: number | null; queued: number | null; nowPlaying: { title: string; sub: string; user: string; progress: number; poster?: string; state: string } | null; others: number; recent: RecentItem[] };
  media: {
    immich: { photos: number; videos: number; sizeGiB: number; users: number; version: string } | null;
    seerr: { pending: number; approved: number; completed: number } | null;
    sonarr: { series: number; queued: number; wanted: number } | null;
    radarr: { movies: number; queued: number | null; missing: number; wanted: number } | null;
    bazarr: { episodes: number; movies: number } | null;
    prowlarr: { indexers: string[] } | null;
    /** books: on disk; booksTotal: monitored; missing: Wanted → Missing */
    chaptarr: { authors: number; books: number; booksTotal: number; missing: number; queued: number } | null;
    /** todayGB (additive, optional): downloaded since local midnight, for the NZBGet view's "qBittorrent today" (the
     *  mirror of "NZBGet today"); the page can't sum it from its 40 s of rate samples, so prom-media asks Prometheus */
    qbit: { leeching: number; seeding: number; conn: 'connected' | 'firewalled' | 'disconnected' | null; todayGB?: number | null } | null;
    nzbget: { todayGB: number; queueGB: number | null; paused: boolean | null } | null;
    alsoRunning: string[];
    /** Library health's change over 7 days (review finding 17): each count now minus its sample from 7 days ago; null
     *  until there are 7 days of samples, or while the count's source isn't fresh. Additive and optional (an older
     *  server sends none; the page reads that as null). It's in the Snapshot because the page can't work it out: it
     *  only ever sees today's counts, so the daily samples are kept by the server (server/trend.ts,
     *  DATA_DIR/library-history.json) where every device and reload reads the same ones. */
    delta7?: Record<LibraryKey, number | null>;
  };
  health: {
    stats: { id: string; label: string; value: string; sub: string; tone?: 'danger' | 'warn' }[];
    monitors: Monitor[];
    /** Kuma monitors that map to no web UI or app; listed, never dropped */
    unmapped: Monitor[];
    jobs: JobView[];
    /** jobs with no machine-readable signal */
    unmonitored: { name: string; where: string; note: string }[];
    storage: Volume[];
    /** updates: apt on that host or guest (H11), shown under the version; guestUpdates: its guests' (VM 106 on mf) */
    versions: { name: string; version: string; badge?: string; live: boolean; asOf?: string; updates?: UpdatesView; guestUpdates?: UpdatesView[] }[];
    exposure: { name: string; host: string; via: PublicEndpointConfig['via']; origin: string; status: Status; code: number | null; access?: string; url: string; /** port-forwards: 'reachable', Plex's reason, or "can't be checked" */ note?: string }[];
    orphans: { host: string; code: number | null }[];
    /** job: the config job that runs this alerting path (the watchdogs); Health shows the job's status on this row */
    alerting: { name: string; where: string; state: string; tone: Tone; job?: string }[];
    /** UPS, Unraid disk health, iCloud, apt updates and edge (plans H5-H13); absent before v3.2 */
    ops?: OpsView;
  };
  home: {
    /** which parts homelab.json's homeAssistant names (a part it doesn't name is left off the House tab) */
    configured: { locks: boolean; garage: boolean; climate: boolean; safety: boolean; appliances: boolean; lights: boolean };
    /** up{job="homeassistant"}: null = Prometheus not answering */
    haUp: boolean | null;
    updates: string[] | null;
    /** setpointRange: [low, high] when the mode has two targets (heat_cool), else null/absent. */
    climate: { name: string; indoor: number; setpoint: number | null; setpointRange?: [number, number] | null; humidity: number | null; outside: number | null; mode: string; action: string | null; available: boolean } | null;
    garage: { open: boolean; sub: string; obstruction: boolean | null; light: boolean | null; available: boolean } | null;
    /** one row per configured light, always; on/brightness null while unavailable or no data */
    lights: { name: string; room: string; on: boolean | null; brightness: number | null; available: boolean }[];
    /** one per configured extra thermostat, always (available false = no data) */
    moreClimates: ({ name: string; indoor: number; setpoint: number | null; setpointRange?: [number, number] | null; humidity: number | null; mode: string; action: string | null; available: boolean } & { battery: number | null })[];
    /** one per configured appliance, always; maintenance = the part closest to due (negative = overdue) */
    appliances: { kind: 'dishwasher' | 'laundry' | 'vacuum' | 'thermostat' | 'bed'; name: string; state: 'running' | 'on' | 'off' | 'cleaning' | 'charging' | 'docked' | 'heating' | 'cooling' | 'idle' | 'no-data'; progress: number | null; remainingMin: number | null; finishAt: number | null; battery: number | null; areaM2: number | null; lastAt: number | null; energyTodayKwh: number | null; maintenance: { name: string; hoursLeft: number } | null; tempC?: number | null; targetC?: number | null; humidity?: number | null; inBed?: boolean | null; sleptMin?: number | null }[];
    /** one row per configured detector, always */
    smoke: { name: string; state: 'clear' | 'alarm' | 'offline' | 'fault' | 'no-data'; detail: string }[];
    /** sensors: which of the lock's helpers homelab.json names (no jam sensor = a jam can't be seen) */
    locks: { name: string; state: 'locked' | 'unlocked' | 'jammed' | 'unavailable' | 'no-data'; since: number | null; battery: number | null; door: 'open' | 'closed' | null; sensors?: { door: boolean; jam: boolean } }[];
    printer: { model: string; available: boolean; toner: { c: number; m: number; y: number; k: number } | null } | null;
    haUrl: string;
  };
  devices: DevicesView;
  links: { group: string; items: { name: string; domain: string; url: string }[] }[];
  /** where the links came from: fromFile false = homelab.json's seed (never saved, or links.json unreadable: error says so) */
  linksMeta: { updatedAt: number | null; fromFile: boolean; error: string | null };
}

export interface RecentItem { title: string; poster?: string; sub?: string; key?: string; addedAt?: number | null }

/** Media → Library health's counts, in row order: Bazarr missing subtitles (episodes), Sonarr wanted, Radarr missing,
 *  Radarr wanted, Chaptarr missing. */
export const LIBRARY_KEYS = ['bazarr', 'sonarrWanted', 'radarrMissing', 'radarrWanted', 'chaptarrMissing'] as const;
export type LibraryKey = (typeof LIBRARY_KEYS)[number];

/** The Links tab as saved (DATA_DIR/links.json) or seeded from homelab.json; url as written (bare domain or http(s) URL). */
export interface LinkGroup { name: string; items: { name: string; url: string }[] }
/** GET /api/links, and the `current` of a 409 */
export interface LinksDoc { groups: LinkGroup[]; updatedAt: number | null; fromFile: boolean; error: string | null }

// ---------- fast series (1 sample/s, ring buffers of 40). null = no data that second (drawn as a gap, readout '—').
export const SERIES_LEN = 40;
/** snapAt: `at` of the server's current snapshot for this stream (rebuilt every 10 s, sent only when it changed),
 *  so the page tells "unchanged" from "the server stopped rebuilding". */
export interface Tick { t: number; cpu: Record<string, number | null>; wanIn: number | null; wanOut: number | null; qbDl: number | null; qbUl: number | null; nzDl: number | null; snapAt?: number | null }
export interface History { cpu: Record<string, (number | null)[]>; wanIn: (number | null)[]; wanOut: (number | null)[]; qbDl: (number | null)[]; qbUl: (number | null)[]; nzDl: (number | null)[] }
export interface Hello { snapshot: Snapshot; history: History; build: string }
