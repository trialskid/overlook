// Raw adapter data + homelab.json → Snapshot (v3.1 rules: docs/V3.1-LIVE.md).
// Pure and total: the same code runs on mock and live data, so simulateIncident exercises exactly what a
// real outage would. It never throws on missing or partial data and never invents a value: whatever no
// fresh source answered is null, 'unknown' or '—'. Ages are computed here, from epoch ms, on every rebuild.
import { config } from './config.ts';
import type { GuestRaw, KumaMonitorRaw, Raw } from './raw.ts';
import type {
  Tone,
  ModuleId,
  AppConfig, AppView, Conn, GuestConfig, GuestView, HomelabConfig, HostView, JobConfig, JobView, Kpi, LeafView, PublicEndpointConfig,
  LibraryKey, LinksDoc, Res, Snapshot, SourceView, Status, Volume, WebUi,
} from '../shared/types.ts';
import { LIBRARY_KEYS } from '../shared/types.ts';
import { linkView, seedLinks } from '../shared/links.ts';
import { ago, arr, bool, bytes, clock, dur, fin, fmt, gb, hostPort, isLanHost, maxOf, mean, minOf, num1, pctOf, plural, safeUrl, slug, sum, tb, whereOf, worst } from './derive/util.ts';
import { diskTone, memPressure, ratioPct } from '../shared/rules.ts';
import { mapKuma, monitorRow, monitorsForHost, uiAddr } from './derive/kuma.ts';
import { deriveJobs, type JobState } from './derive/jobs.ts';
import { foldGrafana, grafanaSeverity, shipItems, sortItems, statusLine, type Item } from './derive/attention.ts';
import { deriveOps } from './derive/ops.ts';
import { deriveChecks } from './derive/checks.ts';
import { deriveDevices, type InfraDevice } from './derive/devices.ts';
import { allOn, gateRaw } from './modules.ts';
import { resolveUi } from '../shared/ui.ts';

const HOST_KIND: Record<string, string> = { proxmox: 'Proxmox host', unraid: 'Unraid NAS', mac: 'macOS' };
const HOST_LOOK: Record<string, { mono: string; hue: number }> = { proxmox: { mono: 'PX', hue: 50 }, unraid: { mono: 'UN', hue: 25 }, mac: { mono: 'MM', hue: 270 } };
const FRESH = new Set<Conn>(['ok', 'mock']);
const JOB_SOURCE_LABEL: Record<string, string> = { prometheus: 'Prometheus', 'proxmox-vzdump': 'Proxmox', ntfy: 'ntfy', none: '' };
/** the spotlight app's probe runs every minute; older than this and its readiness values no longer count */
const NS_PROBE_MAX_SEC = 180;
/** a Grafana alert about <name> being down (not, say, its backup failing) */
const downAlert = (name: string) => new RegExp(`${name.replace(/[^a-z0-9]+/gi, '.?')}.*(down|unreachable|unavailable|offline|not ready|availability)`, 'i');

/** links: the saved Links list (server/links.ts); delta7: Library health's 7-day changes (server/trend.ts) */
export interface DeriveOpts { mock: boolean; incident: boolean; build: string; links?: LinksDoc; delta7?: Snapshot['media']['delta7']; modules?: Snapshot['modules'] }

/** The access points on a switch port (their port's link state is theirs); ones on a segment share its state. */
const switchAps = (cfg: HomelabConfig) => arr(cfg.network?.accessPoints).filter((a): a is typeof a & { port: string } => !!a?.port && !a.segment && !!cfg.network?.switch);

export function derive(rawIn: Raw, sources: SourceView[], opts: DeriveOpts, cfg: HomelabConfig = config): Snapshot {
  const raw = gateRaw(rawIn, opts.modules); // a module that's off contributes nothing
  const now = Date.now(), D = cfg.domain, rules = cfg.attentionRules;
  /** a web UI's link (homelab.json uiUrls, else the uiUrl template), null when the lab has no such web UI */
  const uiBase = (name: string): string | null => {
    const t = cfg.webUis?.[name];
    if (typeof t !== 'string') return null;
    const own = cfg.uiUrls?.[name];
    if (typeof own === 'string' && own) return own.replace(/\/+$/, '');
    const { ip, port } = uiAddr(cfg, t);
    return (cfg.uiUrl || 'http://{ip}:{port}').replace(/\{name\}/g, name).replace(/\{domain\}/g, D).replace(/\{ip\}/g, ip).replace(/:?\{port\}/g, port ? `:${port}` : '').replace(/\/+$/, '');
  };
  /** a page of a web UI ('/alerting/list'), null without it */
  const uiAt = (name: string, path = '') => { const b = uiBase(name); return b ? b + path : null; };
  const links = opts.links ?? { groups: seedLinks(cfg), updatedAt: null, fromFile: false, error: null };
  // an entry missing a field it can't do without is skipped, never a throw (a half-edited homelab.json)
  const hostsCfg = arr(cfg.hosts).filter(h => h?.id && h.ip), guestsCfg = arr(cfg.guests).filter(g => g?.host && fin(g.vmid));
  const appsCfg = arr(cfg.apps).filter(a => a?.name), endpoints = arr(cfg.publicEndpoints).filter(e => e?.host && e.name).map(e => ({ ...e, expect: arr(e.expect) }));
  const src = (name: string) => sources.find(s => s.name === name);
  const fresh = (name: string) => { const s = src(name); return !!s && FRESH.has(s.conn); };
  /** when a source last answered: thresholds on "last run" ages are judged as of then (its own lag has its own item) */
  const readAt = (name: string) => { const s = src(name); return s && s.conn === 'ok' && fin(s.lastOk) ? Math.min(now, s.lastOk) : now; };
  const lagSec = (at: number | null | undefined, source: string) => (fin(at) ? Math.max(0, (readAt(source) - at) / 1000) : null);
  const octet = (ip: string | undefined) => (ip ? '.' + String(ip).split('.').pop() : '—');
  const label = (name: string) => cfg.uiLabels?.[name] ?? name;
  const items: Item[] = [];
  const add = (i: Item) => { items.push(i); };
  const kumaAction = uiAt('uptime') ? { label: 'Open Uptime Kuma', href: uiAt('uptime')! } : undefined;
  /** A job item's link: its own (homelab.json), else where its signal lives (a job on the amber line always
   *  has somewhere to go): Prometheus jobs → Grafana's alerts, vzdump → the node's Proxmox (its host's UI),
   *  ntfy → the topic. Called only once `hosts` exists (the jobs loop). */
  const nodeUrl = (id: string) => hosts.find(h => h.id === id)?.url ?? null;
  const jobAction = (j: JobConfig): { label: string; href: string } | undefined =>
    j.link ? { label: 'Open', href: j.link }
      : j.signal === 'prometheus' && uiAt('grafana') ? { label: 'Grafana', href: uiAt('grafana', '/alerting/list')! }
        : j.signal === 'proxmox-vzdump' && j.node && nodeUrl(j.node) ? { label: 'Proxmox', href: nodeUrl(j.node)! }
          : j.signal === 'ntfy' && j.topic && uiAt('ntfy') ? { label: 'ntfy', href: uiAt('ntfy', `/${j.topic}`)! }
            : undefined;
  // UPS, Unraid disk health, apt and tunnels: nothing until their metrics exist
  const ops = deriveOps({ raw, cfg, now, fresh: fresh('prom-ops'), lag: at => lagSec(at, 'prom-ops') });
  // 'not monitored yet' only for areas whose module is on (an off module isn't expected to report)
  const OPS_AREA: Record<string, ModuleId> = { power: 'ups', disks: 'unraid', updates: 'apt', edge: 'edge' };
  if (opts.modules) ops.view.missing = ops.view.missing.filter(m => !OPS_AREA[m.id] || opts.modules![OPS_AREA[m.id]] !== 'off');

  // ---- sources: a stale adapter, or one failing with nothing fresh left, gets one warn item
  const ageOf = (s: SourceView) => (fin(s.lastOk) ? (now - s.lastOk) / 1000 : s.ageSec);
  const badSource = (s: SourceView) => s.conn === 'stale' || (s.conn === 'error' && !(fin(s.lastOk) && fin(ageOf(s)) && ageOf(s)! <= s.maxAgeSec));
  const bad = sources.filter(badSource);
  const freshView = { ok: !bad.length, stale: sources.filter(s => s.conn === 'stale').map(s => s.name), errors: sources.filter(s => s.conn === 'error').map(s => s.name) };
  const forAge = (s: SourceView) => { const a = ageOf(s); return fin(a) ? ` · ${dur(a)}` : ''; };
  if (bad.length > 3) add({
    id: 'sources', kind: 'source', severity: 'warn', rank: 60, source: 'Command Center', since: minOf(bad.map(s => s.lastOk)),
    title: `${bad.length} data sources not answering`, detail: bad.map(s => s.label + forAge(s)).join(', ') + ' · their widgets show —',
  });
  else for (const s of bad) add({
    id: `source-${s.name}`, kind: 'source', severity: 'warn', rank: 60, source: s.label, since: s.lastOk,
    title: `${s.label} not answering${forAge(s)}`,
    detail: [s.error, fin(s.lastOk) ? `last good answer ${ago(s.lastOk, now)}` : 'no good answer since start', 'its widgets show —'].filter(Boolean).join(' · '),
  });
  const grafanaSrc = src('grafana');
  if (grafanaSrc?.conn === 'not-connected') add({
    id: 'grafana-not-connected', severity: 'warn', rank: 70, source: 'Grafana', title: 'Grafana alerts not connected',
    detail: `needs ${grafanaSrc.needs ?? 'a Grafana Viewer service-account token (GRAFANA_URL, GRAFANA_TOKEN)'} · firing Grafana alerts don't reach this page`,
  });

  // ---- Uptime Kuma → web UIs, apps, public endpoints, infra
  const km = mapKuma(raw.kuma, cfg);
  const kumaOn = raw.kuma != null;
  const guestByOctet = (ip: string) => guestsCfg.find(g => octet(g.ip) === ip);
  const gid = (host: string, vmid: number) => `${host}-${vmid}`;
  const ownerOf = (ip: string): WebUi['owner'] => {
    const g = guestByOctet(ip);
    if (g) return { kind: 'guest', id: gid(g.host, g.vmid) };
    const h = hostsCfg.find(x => octet(x.ip) === ip);
    return h ? { kind: 'host', id: h.id } : null;
  };
  // a web UI is public when an endpoint is named after it ('Seerr', 'BookLore', 'Plex remote access')
  const pubWords = new Set(endpoints.map(e => e.name.toLowerCase().split(/\s+/)[0]));
  /** where the UI's app lives when it isn't '/' (Plex: /web/index.html); Kuma still matches the bare host */
  const uiPath = (name: string) => { const p = cfg.uiPaths?.[name]; return typeof p === 'string' && p.startsWith('/') ? p : ''; };
  const uis: WebUi[] = Object.entries(cfg.webUis ?? {}).filter(([, t]) => typeof t === 'string').map(([name, target]) => {
    const ms = km.byKey.get(name) ?? [];
    return {
      name, target, url: `${uiBase(name)!}${uiPath(name)}`, public: pubWords.has(name) || pubWords.has(label(name).toLowerCase()),
      status: worst(ms.map(m => m.status)), ms: maxOf(ms.map(m => m.ms)), owner: ownerOf(target.split(':')[0]), monitored: ms.length > 0,
    };
  });
  // the reverse proxy (homelab.json reverseProxy) fronts every https://*.<domain> UI: when it's down those UIs are down
  // because of it, so one item explains them
  const proxy = cfg.reverseProxy?.name?.trim() || null, proxyKey = proxy ? `infra:${proxy.toLowerCase()}` : null;
  const caddyMs = proxyKey ? km.byKey.get(proxyKey) ?? [] : [];
  const caddyDown = worst(caddyMs.map(m => m.status)) === 'down';
  const viaCaddy = (m: KumaMonitorRaw) => (hostPort(m.url)?.host ?? '').endsWith(`.${D}`);
  const byCaddy = (u: WebUi) => caddyDown && u.status === 'down' && (km.byKey.get(u.name) ?? []).filter(m => m.status === 'down').every(viaCaddy);
  const caddyGuest = (() => {
    const h = caddyMs[0] && (caddyMs[0].hostname ?? hostPort(caddyMs[0].url)?.host);
    return (h ? guestByOctet(octet(h)) : undefined) ?? (proxy ? guestsCfg.find(g => g.services?.some(s => s.toLowerCase() === proxy.toLowerCase())) : undefined);
  })();

  // public endpoints: the LAN-side probe (expected codes) plus any Kuma monitor on the same host
  const probeStatus = (e: PublicEndpointConfig): Status => {
    if (e.probe === false) return 'unknown';
    const p = raw.probes?.[e.host] ?? raw.probes?.[e.host.toLowerCase()];
    return !p ? 'unknown' : fin(p.code) && e.expect.includes(p.code) ? 'up' : 'down';
  };
  const epStatus = (e: PublicEndpointConfig) => (e.probe === false ? 'unknown' : worst([probeStatus(e), ...monitorsForHost(km, e.host).map(m => m.status)]));
  const epWhy = (e: PublicEndpointConfig) => {
    const p = raw.probes?.[e.host];
    const kumaDown = monitorsForHost(km, e.host).filter(m => m.status === 'down').map(m => `Kuma '${m.name}' down`);
    return [p && (p.error ? p.error : fin(p.code) && !e.expect.includes(p.code) ? `HTTP ${p.code}` : ''), ...kumaDown].filter(Boolean).join(' · ') || 'not answering';
  };

  // ---- the spotlight app's readiness (prom-infra, homelab.json spotlight): any 0 = down; a probe older than 3 min =
  // degraded, values ignored
  const spCfg = cfg.spotlight, ns = spCfg?.app ? raw.spotlight : null;
  const nsAge = ns && fin(ns.probeAt) ? Math.max(0, (now - ns.probeAt) / 1000) : null;
  const nsLag = ns ? lagSec(ns.probeAt, 'prom-infra') : null;
  const nsOld = nsLag != null && nsLag > NS_PROBE_MAX_SEC;
  // A public path can drop for a single probe now and then (the CDN, a nightly backup stopping the app). A check only
  // counts as down once every probe in the last 150 s failed; a lone failure is a blip, shown in the spotlight block but
  // not raised (as an alert rule's for-duration would).
  const ready = (v: number | null | undefined, recent?: number | null): Status =>
    nsOld || !fin(v) ? 'unknown' : v > 0 || (fin(recent) && recent > 0) ? 'up' : 'down';
  const blip = (v: number | null | undefined, recent?: number | null) => !nsOld && fin(v) && v <= 0 && fin(recent) && recent > 0;
  const isNs = (a: AppConfig) => !!spCfg?.app && a.name === spCfg.app;
  /** the spotlight's signals by role, each 'up' / 'down' (150 s rule) / 'unknown', and whether it only blipped */
  const spSig = (role: 'lan' | 'public' | 'other') => (spCfg?.signals ?? []).filter(x => (x.role ?? 'other') === role).map(x => {
    const v = ns?.signals?.[x.name];
    return { name: x.name, status: ready(v?.now, v?.recent), blip: blip(v?.now, v?.recent) };
  });

  // ---- jobs (before the apps: an app can take its status from its jobs)
  const { states: jobStates, jobs, unmonitored } = deriveJobs(cfg, raw, now, readAt);
  const jobLast = (id: string) => jobStates.find(s => s.job.id === id)?.rows.find(r => r.lastAt != null)?.lastAt ?? null;

  // ---- apps: worst of their Kuma monitors, the probe of their public host, their jobs and (the spotlight app) its readiness signals
  const appMonitors = (a: AppConfig) => {
    const pub = hostPort(a.publicUrl)?.host;
    const set = new Set([...(km.byKey.get(`app:${a.name}`) ?? []), ...km.all.filter(m => a.kuma?.includes(m.id)), ...(pub ? monitorsForHost(km, pub) : [])]);
    return [...set];
  };
  const appEndpoint = (a: AppConfig) => { const pub = hostPort(a.publicUrl)?.host; return endpoints.find(e => e.app === a.name || (!!pub && e.host.toLowerCase() === pub)); };
  const appSignals = (a: AppConfig) => {
    const ms = appMonitors(a), ep = appEndpoint(a);
    const lan = ms.filter(m => isLanHost(hostPort(m.url)?.host ?? m.hostname ?? '')).map(m => m.status);
    const pub = [...ms.filter(m => !isLanHost(hostPort(m.url)?.host ?? m.hostname ?? '')).map(m => m.status), ep ? probeStatus(ep) : 'unknown'];
    const nsSig = isNs(a) && ns ? { public: spSig('public').map(x => x.status), origin: spSig('lan').map(x => x.status), network: spSig('other').map(x => x.status) } : null;
    const jobs = jobStates.filter(j => arr(a.jobs).includes(j.job.id)).map(j => j.status);
    return { ms, ep, lan: worst([...lan, ...(nsSig?.origin ?? [])]), pub: worst([...pub, ...(nsSig?.public ?? [])]), network: nsSig?.network.length ? worst(nsSig.network) : 'unknown', jobs, stale: isNs(a) && nsOld };
  };
  const apps: AppView[] = appsCfg.map(a => {
    const s = appSignals(a);
    const status = s.stale && worst([s.lan, s.pub]) !== 'down' ? 'degraded' : worst([s.lan, s.pub, s.network, ...s.jobs]);
    const monitored = s.ms.length > 0 || (a.kuma?.length ?? 0) > 0 || (!!s.ep && s.ep.probe !== false) || (isNs(a) && !!ns) || s.jobs.length > 0;
    return { name: a.name, label: a.label, host: a.host, url: a.url ?? null, publicUrl: a.publicUrl ?? null, status: monitored ? status : 'unknown', monitored, critical: !!a.critical, note: a.note ?? '' };
  });

  // ---- guests: the live Proxmox list (templates skipped), enriched by homelab.json
  const live = raw.guests ? Object.values(raw.guests).filter(g => g && !g.template) : null;
  const liveHosts = new Set((live ?? []).map(g => g.host));
  const uiOn = (ip: string) => uis.filter(u => u.target.split(':')[0] === ip).map(u => ({ name: u.name, port: ':' + (u.target.split(':')[1] ?? ''), public: u.public, url: u.url }));
  const makeGuest = (host: string, vmid: number, gc?: GuestConfig, gr?: GuestRaw): GuestView => {
    const ip = gc ? octet(gc.ip) : '—', ui = gc ? uiOn(ip) : [], kind = gr?.kind ?? gc?.kind ?? 'lxc';
    const first = (gc?.desc ?? '').split(/[,·]/)[0].trim();
    // raw.containers is keyed by vmid only: never hand an undocumented guest another host's count
    const ctr = gc ? (gc.cadvisor ? raw.containers?.[vmid] : undefined) : guestsCfg.some(x => x.vmid === vmid) ? undefined : raw.containers?.[vmid];
    return {
      id: gid(host, vmid), host, vmid, name: gr?.name || gc?.name || `${kind} ${vmid}`, kind, ip, type: kind === 'vm' ? (first ? `VM · ${first}` : 'VM') : 'LXC',
      containers: fin(ctr) ? ctr : null, services: gc?.services ?? [], devices: gc?.devices ?? [], status: gr?.status ?? 'unknown', public: ui.some(u => u.public), ui,
      res: gr ? { cpuPct: gr.cpuPct, memUsed: gr.memUsed, memTotal: gr.memTotal, swapUsed: gr.swapUsed, swapTotal: gr.swapTotal, diskUsed: gr.diskUsed, diskTotal: gr.diskTotal, load1: null, uptimeSec: gr.uptimeSec } : null,
      undocumented: !gc, missing: !!gc && !gr && liveHosts.has(host),
    };
  };
  const guests: GuestView[] = [];
  if (live) {
    for (const gr of live) guests.push(makeGuest(gr.host, gr.vmid, guestsCfg.find(c => c.host === gr.host && c.vmid === gr.vmid), gr));
    for (const gc of guestsCfg) if (!live.some(g => g.host === gc.host && g.vmid === gc.vmid)) guests.push(makeGuest(gc.host, gc.vmid, gc));
  } else for (const gc of guestsCfg) guests.push(makeGuest(gc.host, gc.vmid, gc));
  for (const g of guests) { const u = ops.updatesBy.get(g.id); if (u) g.updates = u; }
  const hostIdx = (h: string) => { const i = hostsCfg.findIndex(x => x.id === h); return i < 0 ? 99 : i; };
  guests.sort((a, b) => hostIdx(a.host) - hostIdx(b.host) || a.vmid - b.vmid);
  const running = (g: GuestView) => g.status === 'up';
  const notRunning = (g: GuestView) => g.status === 'down' || g.status === 'degraded';
  const expected = (g: GuestView) => !g.undocumented && guestsCfg.find(c => c.host === g.host && c.vmid === g.vmid)?.expectRunning !== false;

  // ---- hosts and their map leaves
  // Unraid has two views: node_exporter, scraped over the storage link (altIp), and Uptime Kuma on its web UI over the
  // LAN. It is down only when both say so; when they disagree it is 'degraded' and an item names the path that failed.
  const ownUi = (h: { id: string; type: string; ip: string; name: string }) => uis.find(u => u.owner?.kind === 'host' && u.owner.id === h.id && (u.name === h.id || u.name === h.type));
  const split = new Map<string, 'storage' | 'lan'>();
  const combined = new Map<string, Status>();
  for (const h of hostsCfg.filter(x => x.type === 'unraid')) {
    const e = raw.hostStatus?.[h.id] ?? 'unknown', u = ownUi(h);
    const k: Status = u?.monitored && !byCaddy(u) ? u.status : 'unknown';
    if (e === 'down' && k === 'up') split.set(h.id, 'storage');
    if (e === 'up' && k === 'down') split.set(h.id, 'lan');
    combined.set(h.id, split.has(h.id) ? 'degraded' : e === 'unknown' ? (k === 'up' ? 'up' : 'unknown') : e);
  }
  const hostStatus = (id: string): Status => combined.get(id) ?? raw.hostStatus?.[id] ?? 'unknown';
  const hosts: HostView[] = hostsCfg.map(h => {
    const look = HOST_LOOK[h.type] ?? { mono: h.name.slice(0, 2).toUpperCase(), hue: 200 };
    const ip = octet(h.ip), status = hostStatus(h.id);
    const onIp = uis.filter(u => u.target.split(':')[0] === ip);
    const ui = onIp.find(u => u.name === h.id || u.name === h.type || label(u.name) === h.name) ?? (h.type === 'proxmox' ? onIp.find(u => u.target.endsWith(':8006')) : undefined) ?? onIp[0];
    let leaves: LeafView[] = [], summary = '', listLabel = '', os = '—';
    if (h.type === 'proxmox') {
      const v = raw.versions?.[`Proxmox · ${h.name}`] ?? raw.versions?.[h.id];
      if (v) os = /^pve/i.test(v) ? v : `PVE ${v}`;
      const mine = guests.filter(g => g.host === h.id);
      // a leaf goes red when the guest is down or one of its web UIs is (unless Caddy explains it), even if the LXC runs
      const svcDown = (g: GuestView) => uis.some(u => u.owner?.id === g.id && u.status === 'down' && !byCaddy(u)) || (caddyDown && caddyGuest != null && g.id === gid(caddyGuest.host, caddyGuest.vmid));
      leaves = mine.map(g => ({ key: g.id, kind: g.kind, tag: String(g.vmid), name: g.name, count: g.containers ? String(g.containers) : '', public: g.public, status: svcDown(g) ? 'down' : g.status, guestId: g.id, monitored: true }));
      const vm = mine.filter(g => g.kind === 'vm').length, lxc = mine.length - vm;
      const ctrs = mine.map(g => g.containers).filter(fin), parts = [vm && `${vm} VM`, lxc && `${lxc} LXC`].filter(Boolean).join(' · ');
      summary = [parts, ctrs.length && `${sum(ctrs)} ctr`].filter(Boolean).join(' · ') || '—';
      listLabel = parts ? `GUESTS · ${parts}` : 'GUESTS';
    } else if (h.type === 'unraid') {
      const v = raw.unraid?.os ?? raw.versions?.Unraid;
      if (v) os = `Unraid ${v.replace(/^unraid\s*/i, '')}`;
      // an on-demand tool (started by hand, no monitor) isn't drawn as if it were always running
      const mine = apps.filter(a => a.host === h.id && !appsCfg.find(c => c.name === a.name)?.onDemand);
      leaves = mine.map(a => ({ key: `app-${slug(a.name)}`, kind: 'app', tag: '▣', name: a.label, count: '', public: !!a.publicUrl, status: a.status, url: a.publicUrl ?? a.url, monitored: a.monitored }));
      summary = `${raw.unraid && fin(raw.unraid.arrayTB) ? tb(raw.unraid.arrayTB) : '—'} · ${plural(mine.length, 'app')}`;
      listLabel = 'APPS';
    } else if (h.type === 'mac') {
      os = 'macOS';
      leaves = arr(cfg.macRoles).map(r => ({ key: `role-${slug(r)}`, kind: 'role', tag: '>_', name: r, count: '', public: false, status, monitored: true }));
      summary = (cfg.macRoles ?? []).join(' · ') || '—';
      listLabel = 'ROLES';
    }
    return {
      id: h.id, name: h.name, short: h.short || h.name, mono: look.mono, hue: look.hue, ip: h.ip, ipS: [ip, h.portLabel ?? h.port].filter(Boolean).join(' · '),
      os, hw: h.hardware, status, summary, listLabel, leaves, cpuScale: h.cpuScale ?? (h.type === 'mac' ? 50 : 40), url: h.type === 'mac' ? null : ui?.url ?? null, res: raw.hostRes?.[h.id] ?? null,
      ...(ops.updatesBy.get(h.id) ? { updates: ops.updatesBy.get(h.id) } : {}),
    };
  });

  // ================= Needs attention =================
  const RULE_DISK = { warn: rules?.diskWarnPct ?? 85, danger: rules?.diskDangerPct ?? 95 };
  // Unraid fills its data disks one after another by design, so single disks never raise anything:
  // only the array as a whole (arrayWarnPct) and the cache (cacheWarnPct) do.
  const ARRAY_WARN = rules?.arrayWarnPct ?? 95, CACHE_WARN = rules?.cacheWarnPct ?? 90;
  const fillTone = (used: number | null | undefined, total: number | null | undefined, warn: number): 'ok' | 'warn' => ((ratioPct(used, total) ?? 0) >= warn ? 'warn' : 'ok');
  const hostById = (id: string) => hostsCfg.find(h => h.id === id);
  const hostDown = (id: string) => hostStatus(id) === 'down';

  // -- smoke / CO (life safety first)
  const ha = raw.ha;
  for (const d of arr(ha?.smoke)) {
    if (d.state === 'alarm') add({ id: `smoke-${slug(d.name)}`, severity: 'danger', rank: 0, source: 'Home Assistant', title: `${d.name}: ALARM`, detail: d.detail || 'smoke or CO detected', dupe: { name: /smoke|co alarm|carbon/i } });
    else if (d.state === 'offline' || d.state === 'fault' || (d.state === 'no-data' && ha?.up === true))
      add({ id: `smoke-${slug(d.name)}`, severity: 'warn', rank: 52, source: 'Home Assistant', title: `${d.name} ${d.state === 'fault' ? 'reports a fault' : d.state === 'offline' ? 'is offline' : 'has no data'}`, detail: d.detail || 'it may not alert', dupe: { name: /smoke|kidde|detector/i } });
  }

  // -- internet / tunnel: every tunnel probe failing is one item, not one per app
  // only what the main tunnel carries: an endpoint on another tunnel (tunnelJob) keeps answering when the main one fails
  const tunnel = endpoints.filter(e => e.via === 'tunnel' && !e.tunnelJob && e.probe !== false);
  const tunnelSt = tunnel.map(epStatus);
  const allTunnelDown = tunnel.length >= 2 && tunnelSt.every(s => s === 'down');
  const net = raw.network;
  // with cloudflared's metrics (H12) the tunnel's own item says '0 connections'; probes failing while it holds
  // connections point at the edge, DNS or the origins instead
  const tunnelConns = ops.tunnel?.conns;
  if ((allTunnelDown && !ops.mainTunnelDown) || net?.wanUp === false) add({
    id: 'internet', severity: 'danger', rank: 3, source: net?.wanUp === false ? 'Gateway (SNMP)' : 'Public probes',
    title: net?.wanUp === false ? `Internet down: ${cfg.network?.gateway?.name ?? 'the gateway'}'s WAN link is down` : fin(tunnelConns) && tunnelConns > 0 ? 'Public endpoints failing, tunnel connected' : `Internet or ${cfg.network?.tunnel ?? 'tunnel'} down`,
    detail: !allTunnelDown ? 'the WAN interface reports link down'
      : fin(tunnelConns) && tunnelConns > 0 ? `all ${tunnel.length} public endpoints failing while cloudflared holds ${tunnelConns} connections · the edge, DNS or the origins`
        : `all ${tunnel.length} public endpoints failing · the LAN itself still answers`,
    since: minOf(tunnel.flatMap(e => monitorsForHost(km, e.host).map(m => m.downSince))),
  });

  // -- Caddy and web UIs
  if (caddyDown) add({
    id: 'caddy-down', severity: 'danger', rank: 5, source: 'Uptime Kuma', since: minOf(caddyMs.map(m => m.downSince)), action: kumaAction, dupe: { name: new RegExp(`${proxy}|reverse.?proxy`, 'i') },
    title: `${proxy} is down`,
    detail: `every https://*.${D} web UI goes through it · ${plural(uis.filter(byCaddy).length, 'web UI')} unreachable because of it${caddyGuest ? ` · runs on ${caddyGuest.name}` : ''}`,
  });
  const guestName = (id: string) => guests.find(g => g.id === id)?.name ?? id;
  for (const u of uis) {
    if (u.status !== 'down' || byCaddy(u)) continue;
    const ms = km.byKey.get(u.name) ?? [], since = minOf(ms.filter(m => m.status === 'down').map(m => m.downSince));
    if (u.owner?.kind === 'host' && hostDown(u.owner.id)) continue; // the host item covers its own UI
    if (u.owner?.kind === 'host' && split.get(u.owner.id) === 'lan' && ownUi(hostById(u.owner.id)!) === u) continue; // so does the LAN-path item
    add({
      id: `down-${u.name}`, kind: 'ui', severity: 'danger', rank: 20, source: 'Uptime Kuma', since, action: kumaAction, dupe: { name: downAlert(label(u.name)) },
      title: `${label(u.name)} is down`,
      detail: [hostPort(u.url)?.host ?? u.target, since != null ? `no response for ${dur((now - since) / 1000)}` : 'not responding', u.owner && (u.owner.kind === 'guest' ? guestName(u.owner.id) : hostById(u.owner.id)?.name)].filter(Boolean).join(' · '),
    });
  }
  // other infra checks and monitors that map to nothing still count when they're down
  for (const [k, ms] of km.byKey) {
    if (!k.startsWith('infra:') || k === proxyKey || worst(ms.map(m => m.status)) !== 'down') continue;
    if (ms.some(m => endpoints.some(e => e.host.toLowerCase() === hostPort(m.url)?.host))) continue; // reported with its endpoint
    add({ id: `kuma-${slug(k)}`, severity: 'danger', rank: 30, source: 'Uptime Kuma', since: minOf(ms.map(m => m.downSince)), action: kumaAction, title: `${ms[0].name} is down`, detail: ms.map(m => safeUrl(m.url) || m.hostname).filter(Boolean).join(' · ') || k });
  }
  for (const m of km.unmapped) if (m.status === 'down') add({
    id: `kuma-${m.id}`, severity: 'danger', rank: 30, source: 'Uptime Kuma', since: m.downSince, action: kumaAction,
    title: `${m.name} is down`, detail: `${safeUrl(m.url) || m.hostname || ''} · Kuma monitor ${m.id}, not mapped to a web UI or app`.replace(/^ · /, ''),
  });

  // -- hosts
  for (const h of hosts) {
    const hc = hostById(h.id)!, ips = [hc.ip, hc.altIp ?? ''].filter(Boolean); // Prometheus scrapes Unraid on its altIp
    if (h.status === 'down') add({
      id: `host-${h.id}`, severity: 'danger', rank: 10, source: hc.type === 'proxmox' ? 'Proxmox API' : hc.type === 'unraid' ? 'Prometheus · node exporter · Uptime Kuma' : 'Mac probe',
      title: `${h.name} is down`, dupe: { name: /down|unreachable|offline|target missing/i, label: ips },
      detail: `${hc.ip} · ${hc.type === 'proxmox' ? 'Proxmox API not answering · its guests read unknown' : hc.type === 'unraid' ? 'node exporter and web UI both down · NAS shares and Unraid apps' : 'not answering'}`,
    });
    const ui = ownUi(hc);
    if (split.get(h.id) === 'storage') add({
      id: `path-${h.id}`, severity: 'warn', rank: 12, source: 'Prometheus · node exporter', dupe: { name: /target.*down|scrape|node.?exporter|unraid/i, label: ips },
      title: `${h.name}: node exporter not answering over the storage link`,
      detail: `Prometheus gets no answer from ${hc.altIp ?? hc.ip}:9100, while the web UI answers on the LAN (${hc.ip}) · the storage link to mf (NFS) or node_exporter itself · array and disk figures read —`,
    });
    if (split.get(h.id) === 'lan') add({
      id: `path-${h.id}`, severity: 'warn', rank: 12, source: 'Uptime Kuma', action: kumaAction, dupe: { name: downAlert(label(ui?.name ?? h.id)), label: ips },
      title: `${h.name}: web UI not answering on the LAN`,
      detail: `Uptime Kuma can't reach ${ui ? hostPort(ui.url)?.host ?? ui.target : hc.ip}; node_exporter still answers over the storage link (${hc.altIp ?? hc.ip}), so the NAS itself is up`,
    });
    const memP = ratioPct(h.res?.memUsed, h.res?.memTotal);
    if (h.status !== 'down' && memP != null && memP >= 90) add({ id: `ram-${h.id}`, severity: 'warn', rank: 55, source: 'Proxmox API', title: `${h.name} RAM at ${Math.floor(memP)}%`, detail: `${bytes(h.res!.memUsed)} of ${bytes(h.res!.memTotal)} in use`, dupe: { name: /ram|memory/i, label: ips } });
    else if (h.status !== 'down' && memPressure(h.res)) add(pressureItem(`ram-${h.id}`, h.name, h.res!, 'Proxmox API', ips));
    const rootTone = hc.type === 'proxmox' ? diskTone(h.res?.diskUsed, h.res?.diskTotal, RULE_DISK.warn, RULE_DISK.danger) : 'ok';
    if (rootTone !== 'ok') add({ id: `root-${h.id}`, severity: rootTone === 'danger' ? 'danger' : 'warn', rank: 50, source: 'Proxmox API', title: `${h.name} root disk ${pctOf(h.res?.diskUsed, h.res?.diskTotal)}% full`, detail: `${bytes(h.res!.diskUsed)} of ${bytes(h.res!.diskTotal)}`, dupe: { name: /disk|filesystem|rootfs/i, label: ips } });
  }

  // -- guests
  const undocumented: GuestView[] = [];
  for (const g of guests) {
    if (hostDown(g.host)) continue; // the host item explains every guest on it
    const where = `${g.kind === 'vm' ? 'VM' : 'CT'} ${g.vmid} on ${hostById(g.host)?.name ?? g.host}`;
    if (g.undocumented) undocumented.push(g);
    if (g.missing) add({ id: `missing-${g.id}`, severity: 'info', rank: 95, source: 'Proxmox API', title: `${g.name} is not in Proxmox`, detail: `${where} is in homelab.json but Proxmox doesn't list it · remove it from config if it's gone` });
    if (notRunning(g)) {
      const exp = expected(g);
      add({ id: `guest-${g.id}`, severity: exp ? 'danger' : 'info', rank: 15, source: 'Proxmox API', title: `${g.name} is not running`, detail: `${where} · Proxmox says ${g.status === 'degraded' ? 'paused' : 'stopped'}${exp ? '' : g.undocumented ? ' · undocumented guest' : ' · expected'}` });
    }
    // running guests: LXC root disks and VM disks (guest agent); the same tiers colour the page's bars
    const gip = guestsCfg.find(c => c.host === g.host && c.vmid === g.vmid)?.ip ?? g.name;
    const diskT = running(g) ? diskTone(g.res?.diskUsed, g.res?.diskTotal, RULE_DISK.warn, RULE_DISK.danger) : 'ok';
    if (diskT !== 'ok') add({ id: `disk-${g.id}`, severity: diskT === 'danger' ? 'danger' : 'warn', rank: 50, source: 'Proxmox API', title: `${g.name} ${g.kind === 'vm' ? 'disk' : 'root disk'} ${pctOf(g.res?.diskUsed, g.res?.diskTotal)}% full`, detail: `${where} · ${bytes(g.res!.diskUsed)} of ${bytes(g.res!.diskTotal)}`, dupe: { name: /disk|filesystem|rootfs/i, label: gip } });
    if (running(g) && memPressure(g.res)) add(pressureItem(`mem-${g.id}`, g.name, g.res!, 'Proxmox API', [gip], where));
  }
  if (undocumented.length) add({ id: 'undocumented', severity: 'info', rank: 95, source: 'Proxmox API', title: `${plural(undocumented.length, 'guest')} not in homelab.json`, detail: undocumented.map(g => `${g.name} (${g.vmid})`).join(', ') + ' · add services and IP to config' });

  // -- apps (the spotlight first) and public endpoints
  const handledEp = new Set<string>();
  for (const a of appsCfg) {
    const v = apps.find(x => x.name === a.name)!, s = appSignals(a);
    if (s.ep) handledEp.add(s.ep.host);
    if (v.status !== 'down' && v.status !== 'degraded') continue;
    const own = worst([s.lan, s.pub, s.network]);
    if (s.jobs.length && own !== 'down' && own !== 'degraded' && !s.stale) continue; // its jobs' own items say what's wrong
    const lanOk = s.lan !== 'down' && s.network !== 'down';
    if ((allTunnelDown || ops.mainTunnelDown) && lanOk && !s.stale) continue; // the internet or tunnel item explains it
    const failed = [s.lan === 'down' && 'LAN check down', s.pub === 'down' && 'public URL failing', s.network === 'down' && 'container network not ready', s.stale && `availability probe ${dur(nsLag!)} old`].filter(Boolean) as string[];
    if (s.stale && v.status === 'degraded' && spCfg?.probeJob && jobStates.some(j => j.job.id === spCfg.probeJob && j.status !== 'up')) continue; // the probe job's item says it
    const crit = !!a.critical;
    add({
      id: `app-${slug(a.name)}`, severity: v.status === 'degraded' ? 'warn' : crit ? 'danger' : 'warn', rank: isNs(a) ? 6 : 45,
      source: isNs(a) ? 'Readiness probe · Uptime Kuma' : 'Uptime Kuma · public probe', dupe: { name: downAlert(a.name) },
      title: v.status === 'degraded' ? `${a.label}: status unknown` : s.lan === 'down' ? `${a.label} is down` : s.network === 'down' ? `${a.label} not ready` : `${a.label} not reachable from outside`,
      detail: [...failed, a.publicUrl?.replace(/^https?:\/\//, '') ?? a.url ?? '', a.note ?? ''].filter(Boolean).join(' · '),
      since: minOf(s.ms.filter(m => m.status === 'down').map(m => m.downSince)),
      ...(a.publicUrl || a.url ? { action: { label: `Open ${a.label}`, href: (a.publicUrl ?? a.url)! } } : {}),
    });
  }
  if (!allTunnelDown) for (const e of endpoints) {
    if (handledEp.has(e.host) || e.probe === false || epStatus(e) !== 'down') continue;
    if (e.via === 'tunnel' && (e.tunnelJob ? ops.downTunnels.has(e.tunnelJob) : ops.mainTunnelDown)) continue; // the tunnel item explains it
    const crit = !!e.critical || appsCfg.some(a => a.name === e.app && a.critical);
    add({
      id: `public-${slug(e.host)}`, severity: crit ? 'danger' : 'warn', rank: 25, source: 'Public probe', since: minOf(monitorsForHost(km, e.host).map(m => m.downSince)),
      title: `${e.name} not reachable from outside`, detail: `${e.host} · ${epWhy(e)} · ${e.origin}`, action: { label: 'Open', href: `https://${e.host}` },
    });
  }

  // -- Home Assistant: locks, exporter, updates
  for (const l of arr(ha?.locks)) {
    if (l.state === 'jammed') add({ id: `lock-${slug(l.name)}`, severity: 'danger', rank: 8, source: 'Home Assistant', since: l.since, title: `${l.name} lock is jammed`, detail: 'the bolt may not be thrown · check the door', dupe: { name: /jam/i } });
    else if (l.state === 'unavailable') add({ id: `lock-${slug(l.name)}`, severity: 'warn', rank: 52, source: 'Home Assistant', since: l.since, title: `${l.name} lock unavailable`, detail: 'Home Assistant has lost the lock (Z-Wave)', dupe: { name: /lock.*(unavailable|offline|dead)/i } });
    // HA's exporter reads an 'open' lock as locked: a locked lock next to an open door is worth a look
    else if (l.state === 'locked' && l.door === 'open') add({ id: `lock-${slug(l.name)}`, severity: 'warn', rank: 9, source: 'Home Assistant', since: l.since, title: `${l.name} reads locked, but the door is open`, detail: 'Home Assistant\'s exporter reports an open (unlatched) lock as locked · check the door' });
    if (fin(l.battery) && l.battery < (rules?.lockBatteryWarnPct ?? 25)) add({ id: `lockbat-${slug(l.name)}`, severity: 'warn', rank: 56, source: 'Home Assistant', title: `${l.name} lock battery ${Math.round(l.battery)}%`, detail: `below ${rules?.lockBatteryWarnPct ?? 25}% · replace soon`, dupe: { name: /lock.*batter|batter.*lock/i } });
  }
  if (ha?.up === false && ha.downFor2m !== false) add({ id: 'ha-exporter', severity: 'warn', rank: 54, source: 'Prometheus · Home Assistant', title: 'Home Assistant not answering', detail: 'Prometheus can\'t reach it for 2 min or more · the House tab shows no data', dupe: { name: /home.?assistant/i } });
  const haUpdates = arr(ha?.updates);
  if (haUpdates.length) add({ id: 'ha-updates', severity: 'info', rank: 92, source: 'Home Assistant', title: `${plural(haUpdates.length, 'Home Assistant update')} available`, detail: haUpdates.slice(0, 6).join(', '), ...(cfg.webUis?.homeassistant ? { action: { label: 'Open Home Assistant', href: `https://homeassistant.${D}/config/updates` } } : {}) });

  // -- jobs: a failure is warn (danger for critical jobs); 'no data' only when its source is fresh (else the source item says it)
  for (const s of jobStates) {
    if (s.status === 'up' || ops.claims.has(s.job.id)) continue; // a claimed job: an ops item says it more precisely
    const badRows = s.rows.filter(r => r.status !== 'up'), j = s.job, one = s.rows.length === 1;
    // rows that fail the same way read as one part: '102, 103, 105: last run failed · last success 2 d ago'
    const groups = new Map<string, JobView[]>();
    for (const r of badRows) groups.set(r.detail || r.status, [...(groups.get(r.detail || r.status) ?? []), r]);
    const part = ([why, rs]: [string, JobView[]]) => {
      const lo = minOf(rs.map(r => r.lastAt)), hi = maxOf(rs.map(r => r.lastAt));
      const last = hi == null ? '' : lo === hi || ago(lo, now) === ago(hi, now) ? ` · last success ${ago(hi, now)}` : ` · last success ${dur((now - hi) / 1000)} to ${ago(lo, now)}`;
      return `${one ? '' : `${rs.map(r => r.name.replace(`${j.name} · `, '')).join(', ')}: `}${why}${last}`;
    };
    const parts = [...groups];
    const act = jobAction(j);
    const base = { source: JOB_SOURCE_LABEL[j.signal] || 'Jobs', dupe: { name: jobAlert(j) }, ...(act ? { action: act } : {}) };
    if (s.status === 'unknown') {
      if (!fresh(s.source) || (j.signal === 'proxmox-vzdump' && j.node && hostDown(j.node))) continue; // the source or host item says it
      const broke = badRows.find(r => /signal failed/.test(r.detail))?.detail;
      add({ ...base, id: `job-${j.id}`, severity: 'warn', rank: 58, since: null, title: broke ? `${j.name}: check broken` : `${j.name}: no data`, detail: `${j.where} · ${broke ?? (j.signal === 'ntfy' ? `no message on '${j.topic}'` : 'its metric is missing')}` });
      continue;
    }
    // failed: it broke after the newest success; overdue: since the oldest row passed its max age
    const newest = maxOf(badRows.map(r => r.lastAt)), oldest = minOf(badRows.map(r => r.lastAt));
    add({
      ...base, id: `job-${j.id}`, severity: j.critical ? 'danger' : 'warn', rank: j.critical ? 35 : s.status === 'down' ? 46 : 57, // a failed run before a disk filling up
      since: s.status === 'down' ? newest : oldest != null ? oldest + j.maxAgeH * 3600e3 : null,
      title: s.status === 'down' ? `${j.name} failed` : `${j.name} is overdue`,
      detail: [j.where, ...parts.slice(0, 3).map(part), parts.length > 3 ? `+${parts.length - 3} more` : ''].filter(Boolean).join(' · '),
    });
  }

  // -- UPS, Unraid disk health, apt, tunnels (before the disk-fill items: Grafana's disk-health
  // alerts fold into their own items first)
  items.push(...ops.items);
  const checks = deriveChecks(cfg, raw, { prom: fresh('prom-checks'), kuma: fresh('kuma') }, now);
  items.push(...checks.items);

  // -- storage, certificates, NFS, pipelines, network gear
  const un = raw.unraid;
  // compared unrounded (84.6 % is not 85 %); the text shows the floor, so it never reads above the threshold it missed
  const arrayPct = un ? pctOf(un.arrayUsedTB, un.arrayTB) : null, arrayT = un ? fillTone(un.arrayUsedTB, un.arrayTB, ARRAY_WARN) : 'ok';
  const disks = arr(raw.unraidDisks).map(d => ({ ...d, pct: pctOf(d.usedTB, d.totalTB), ratio: ratioPct(d.usedTB, d.totalTB), tone: 'ok' as const }));
  if (arrayT === 'warn') add({ id: 'array', severity: 'warn', rank: 50, source: 'Prometheus · node exporter', title: `Unraid array is ${arrayPct}% full`, detail: `${tb(Math.max(0, un!.arrayTB - un!.arrayUsedTB))} free · warns from ${ARRAY_WARN}%`, dupe: { name: /array.*capacity|capacity.*array/i } });
  const cachePct = un && fin(un.cacheGB) && un.cacheGB > 0 ? pctOf(un.cacheUsedGB, un.cacheGB) : null;
  if (un && fillTone(un.cacheUsedGB, un.cacheGB, CACHE_WARN) === 'warn') add({ id: 'cache', severity: 'warn', rank: 50, source: 'Prometheus · node exporter', title: `Unraid cache is ${cachePct}% full`, detail: `${gb(Math.max(0, un.cacheGB - un.cacheUsedGB))} free · warns from ${CACHE_WARN}%`, dupe: { name: /cache.*capacity|capacity.*cache/i } });
  const certMs = km.all.filter(m => fin(m.certDays) && (hostPort(m.url)?.host ?? '').endsWith(`.${D}`)); // the lab's own wildcard (its reverse proxy renews it); certs on someone else's edge aren't the lab's to act on
  const certMin = minOf(certMs.map(m => m.certDays));
  if (certMin != null && certMin <= (rules?.certWarnDays ?? 14)) add({ id: 'cert', severity: 'warn', rank: 53, source: 'Uptime Kuma', title: `*.${D} certificate expires in ${plural(Math.max(0, Math.floor(certMin)), 'day')}`, detail: `Caddy should have renewed it at 30 days · ${plural(certMs.filter(m => m.certDays! <= (rules?.certWarnDays ?? 14)).length, 'monitor')} see it`, dupe: { name: /cert/i } });
  const gwC = cfg.network?.gateway, swC = cfg.network?.switch, segC = arr(cfg.network?.segments);
  if (gwC && net?.gwUp === false && net.wanUp !== false) add({ id: 'gateway', severity: 'warn', rank: 52, source: 'Prometheus · SNMP', title: `${gwC.name} not answering SNMP`, detail: `${gwC.ip} · router state unknown` });
  if (swC && net?.switchUp === false) add({ id: 'switch', severity: 'warn', rank: 52, source: 'Prometheus · SNMP', title: `${swC.name} switch not answering SNMP`, detail: `${swC.ip} · port states unknown` });
  for (const ap of switchAps(cfg)) if (net?.ports?.[ap.port] === false) add({ id: `ap-${slug(ap.name)}`, severity: 'warn', rank: 52, source: 'Prometheus · SNMP', title: `${ap.name} is offline`, detail: `switch port ${ap.port} is down · ${ap.ip}` });
  for (const sg of segC) if (net?.segments?.[sg.id] === false) add({ id: `segment-${slug(sg.id)}`, severity: 'warn', rank: 58, source: 'Prometheus · SNMP', title: `${sg.name} network is down`, detail: `${gwC?.name ?? 'gateway'} ${sg.gatewayIf ?? ''} link down`.replace(/ +/g, ' ') });
  if (raw.ntfyUp === false) add({ id: 'ntfy', severity: 'warn', rank: 51, source: 'ntfy', title: 'ntfy not answering its health check', detail: 'push alerts from Kuma and Grafana may not reach the phone', dupe: { name: /ntfy/i } });
  // -- Prometheus scrape targets: one item per exporter that stopped answering (one item above 3); a job another item
  // already explains (host down, gateway or switch SNMP, Home Assistant) is left to it
  const targets = Array.isArray(raw.promTargets) ? raw.promTargets : null;
  const downTargets = arr(targets).filter(t => t && typeof t.job === 'string' && !t.up);
  const explained = new Set<string>([
    ...(net?.gwUp === false && gwC?.snmpJob ? [gwC.snmpJob] : []), ...(net?.switchUp === false && swC?.snmpJob ? [swC.snmpJob] : []), ...(ha?.up === false ? ['homeassistant'] : []),
    ...hostsCfg.filter(h => h.nodeJob && (hostDown(h.id) || split.get(h.id) === 'storage')).map(h => h.nodeJob!),
  ]);
  const byJob = new Map<string, typeof downTargets>();
  for (const t of downTargets) if (!explained.has(t.job)) byJob.set(t.job, [...(byJob.get(t.job) ?? []), t]);
  const jobWhat = (job: string) => { const g = guestsCfg.find(x => x.cadvisor === job), h = hostsCfg.find(x => x.nodeJob === job); return g ? `${g.name}'s container counts` : h ? `${h.name}'s metrics` : ''; };
  if (byJob.size > 3) add({ id: 'targets', severity: 'warn', rank: 48, source: 'Prometheus', title: `${byJob.size} Prometheus targets down`, detail: `${[...byJob.keys()].join(', ')} · their metrics read —`, dupe: { name: /target.*(down|missing)|scrape/i } });
  else for (const [job, ts] of byJob) add({
    id: `target-${slug(job)}`, severity: 'warn', rank: 48, source: 'Prometheus', title: `Prometheus target ${job} down`, dupe: { name: /target.*(down|missing)|scrape/i, label: job },
    detail: [ts.map(t => t.instance).filter(Boolean).join(', '), ts[0].error, jobWhat(job) && `${jobWhat(job)} read —`].filter(Boolean).join(' · '),
  });
  if (raw.wud && raw.wud.updates > (rules?.wudUpdatesAbove ?? 0)) add({ id: 'wud', severity: 'info', rank: 91, source: 'WUD', title: `${plural(raw.wud.updates, 'Docker image update')} available`, detail: 'app containers · What\'s Up Docker · monthly window', ...(cfg.webUis?.wud ? { action: { label: 'Open WUD', href: `https://wud.${D}` } } : {}) });

  // -- info: known, chronic or cosmetic; never changes the status line
  if (swC?.eol) add({ id: 'switch-eol', severity: 'info', rank: 90, source: 'homelab.json', title: `${swC.model || swC.name} firmware is end of life`, detail: `${swC.firmware ?? 'its firmware'} · no further security updates` });
  for (const h of cfg.retiredHosts ?? []) { const p = raw.probes?.[h]; if (p && fin(p.code)) add({ id: `orphan-${slug(h)}`, severity: 'info', rank: 91, source: 'Public probe', title: 'Retired hostname still answers', detail: `${h} → HTTP ${p.code} · delete its DNS record` }); }
  if (raw.bazarr && raw.bazarr.episodes > (rules?.bazarrMissingSubtitlesAbove ?? Infinity)) add({ id: 'bazarr', severity: 'info', rank: 93, source: 'Bazarr', title: `${fmt(raw.bazarr.episodes)} episode${raw.bazarr.episodes === 1 ? '' : 's'}${raw.bazarr.movies ? ` and ${fmt(raw.bazarr.movies)} movie${raw.bazarr.movies === 1 ? '' : 's'}` : ''} missing subtitles`, detail: 'Bazarr', ...(cfg.webUis?.bazarr ? { action: { label: 'Open Bazarr', href: `https://bazarr.${D}` } } : {}) });
  if (km.unmapped.length) add({ id: 'kuma-unmapped', severity: 'info', rank: 96, source: 'Uptime Kuma', title: `${plural(km.unmapped.length, 'Kuma monitor')} not mapped`, detail: km.unmapped.map(m => m.name).join(', ') + ' · add them to kumaAliases' });

  // -- Grafana: firing alerts, minus the ones a CC rule above already reports
  const grafanaOk = fresh('grafana') && Array.isArray(raw.grafana);
  const grafanaUrl = uiAt('grafana', '/alerting/list') ?? '';
  // Plex's own remote-access check (its port-forward has no safe GET)
  const plexNow = fresh('plex') ? raw.plex : null;
  if (plexNow && !plexNow.mapped && endpoints.some(e => e.check === 'plex')) add({ id: 'plex-remote', severity: 'warn', rank: 58, source: 'Plex', title: 'Plex remote access is down', detail: `${plexNow.error || plexNow.state || 'not mapped'} · streams outside the house won't connect · port-forward WAN TCP ${plexNow.publicPort ?? 32400}` });
  if (grafanaOk) items.push(...foldGrafana(items, raw.grafana!, grafanaUrl));

  // ================= status line, KPIs =================
  const sorted = sortItems(items, now);
  const hostsUp = hosts.filter(h => h.status === 'up').length;
  // no cAdvisor answering at all is '—', not 0 (an up cAdvisor with nothing running does read 0)
  const ctrTotal = raw.containers && Object.keys(raw.containers).length ? sum(Object.values(raw.containers)) : null;
  // a running Docker LXC whose cAdvisor isn't answering is left out of the sum: say so instead of a quietly low total
  const ctrMissing = raw.containers ? guests.filter(g => running(g) && guestsCfg.some(c => c.host === g.host && c.vmid === g.vmid && c.cadvisor) && !fin(raw.containers?.[g.vmid])) : [];
  const guestsRunning = guests.filter(running).length;
  const status = statusLine(sorted, `${raw.hostStatus ? hostsUp : '—'} hosts, ${raw.guests ? guestsRunning : '—'} guests, ${ctrTotal ?? '—'} containers up`);

  const typeCount = (t: string) => hostsCfg.filter(h => h.type === t).length;
  const hostMix = [['proxmox', 'Proxmox'], ['unraid', 'Unraid'], ['mac', 'Mac']].map(([t, n]) => { const c = typeCount(t); return c > 1 ? `${c}× ${n}` : c ? n : ''; }).filter(Boolean).join(' · ');
  const monitoredUis = uis.filter(u => u.monitored), downUis = uis.filter(u => u.status === 'down');
  const probed = endpoints.filter(e => e.probe !== false), epDown = probed.filter(e => epStatus(e) === 'down');
  const epUp = probed.filter(e => epStatus(e) === 'up').length;
  const arrayTone = arrayT;
  // ---- Devices: the router's device list, with the infra homelab.json knows (its own source's status first)
  const gwCfg = cfg.network?.gateway, swCfg = cfg.network?.switch;
  const infra: InfraDevice[] = [
    ...(gwCfg?.ip ? [{ name: gwCfg.name, ip: gwCfg.ip, sub: gwCfg.kind ?? 'router · firewall', status: bool(net?.gwUp) }] : []),
    ...(swCfg?.ip ? [{ name: swCfg.name, ip: swCfg.ip, sub: swCfg.model ?? 'switch', status: bool(net?.switchUp) }] : []),
    ...arr(cfg.network?.accessPoints).filter(a => a?.ip).map(a => ({ name: a.name, ip: a.ip, sub: `access point · ${a.model}`, status: bool(a.segment ? net?.segments?.[a.segment] : a.port ? net?.ports?.[a.port] : null) })),
    ...hosts.map(h => ({ name: h.name, ip: h.ip, sub: HOST_KIND[hostById(h.id)?.type ?? ''] ?? 'host', status: h.status })),
    ...guestsCfg.filter(gc => gc.ip).map(gc => ({
      name: gc.name, ip: gc.ip, sub: `${gc.kind === 'vm' ? 'VM' : 'CT'} ${gc.vmid} on ${hostById(gc.host)?.name ?? gc.host}`, status: guests.find(x => x.id === gid(gc.host, gc.vmid))?.status ?? 'unknown',
    })),
  ];
  const devices = deriveDevices({ raw, cfg, now, fresh: fresh('devices'), infra });
  const kpis: Kpi[] = [
    { id: 'hosts', label: 'HOSTS', value: raw.hostStatus ? `${hostsUp}/${hosts.length}` : '—', sub: hostMix, ...(hosts.some(h => h.status === 'down') ? { tone: 'danger' as const } : {}) },
    {
      id: 'guests', label: 'GUESTS', value: raw.guests ? `${guestsRunning}/${guests.filter(g => !g.missing).length}` : '—',
      sub: raw.guests ? `${guests.filter(g => g.kind === 'vm' && running(g)).length} VM · ${guests.filter(g => g.kind === 'lxc' && running(g)).length} LXC running` : 'Proxmox not answering',
      ...(guests.some(g => notRunning(g) && expected(g)) ? { tone: 'danger' as const } : {}),
    },
    {
      id: 'containers', label: 'CONTAINERS', value: ctrTotal != null ? String(ctrTotal) : '—',
      sub: ctrMissing.length ? `partial · ${ctrMissing.map(g => g.name).join(', ')} not counted (cAdvisor)` : 'Docker LXCs',
      ...(ctrMissing.length && ctrTotal != null ? { tone: 'warn' as const } : {}),
    },
    {
      id: 'uis', label: 'WEB UIS', value: kumaOn ? `${monitoredUis.length - downUis.length}/${monitoredUis.length}` : '—',
      sub: !kumaOn ? 'Uptime Kuma not answering' : downUis.length === 1 ? `${label(downUis[0].name)} not responding` : downUis.length ? `${downUis.length} not responding` : uis.length > monitoredUis.length ? `${uis.length - monitoredUis.length} without a monitor` : '',
      ...(downUis.length ? { tone: 'danger' as const } : {}),
    },
    // x/y like Web UIs: probed endpoints that answer / probed (no data or degraded never counts as up); the unprobed port
    // forwards are named in the sub-line
    {
      id: 'public', label: 'PUBLIC', value: raw.probes ? `${epUp}/${probed.length}` : '—',
      sub: epDown.length ? `${plural(epDown.length, 'endpoint')} failing` : !raw.probes ? 'public probes not answering'
        : epUp < probed.length ? `${probed.length - epUp} not confirmed up` : `${epUp} reachable${endpoints.length > probed.length ? ` · ${endpoints.length - probed.length} not probed` : ''}`,
      tone: epDown.length ? 'danger' : 'pub',
    },
    {
      id: 'array', label: 'ARRAY', value: un && fin(un.arrayUsedTB) && fin(un.arrayTB) ? `${num1(un.arrayUsedTB)}/${num1(un.arrayTB)} TB` : '—',
      sub: arrayPct == null ? 'Unraid not answering' : `${arrayPct}% used`,
      ...(arrayTone !== 'ok' ? { tone: arrayTone } : {}),
    },
    ...(ops.kpi ? [ops.kpi] : []),
    // the device list while it's fresh (online now), else the deviceCount query's
    { id: 'lan', label: 'LAN DEVICES', value: devices.counts ? String(devices.counts.lanOnline) : fin(raw.lanDevices) ? String(raw.lanDevices) : '—', sub: '' },
  ];

  // ================= health =================
  const uptimeMonitors = [
    ...uis.map(u => monitorRow(u.name, label(u.name) !== u.name ? label(u.name) : km.byKey.get(u.name)?.[0]?.name ?? u.name, km.byKey.get(u.name) ?? [], true, now)),
    // apps, public endpoints and infra checks that Kuma watches get rows too (Nightscout's strip belongs here)
    ...[...km.byKey].filter(([k]) => !cfg.webUis?.[k]).map(([k, ms]) => {
      const app = k.startsWith('app:') ? appsCfg.find(a => `app:${a.name}` === k) : undefined;
      const ep = k.startsWith('public:') ? endpoints.find(e => `public:${e.host.toLowerCase()}` === k) : undefined;
      return monitorRow(k, app?.label ?? (ep ? `${ep.name} · public` : ms[0].name), ms, true, now);
    }),
  ];
  const unmappedRows = km.unmapped.map(m => monitorRow(`kuma:${m.id}`, m.name, [m], false, now));
  const allUp = km.all.filter(m => m.status === 'up').length, allDown = km.all.filter(m => m.status === 'down');
  const up30 = mean(km.all.map(m => m.up30d).filter(fin).map(v => v * 100));
  const firing = grafanaOk ? raw.grafana! : null;
  const firingSev = (firing ?? []).map(a => grafanaSeverity(a.severity, a.labels ?? {}));
  const backupStates = jobStates.filter(s => s.job.group === 'backup'), backupRows = jobs.filter(j => j.group === 'backup');
  // 'no data' because the source itself is down is said once, by the source item; here it only explains the count
  const blind = backupStates.filter(s => s.status === 'unknown' && !fresh(s.source));
  const backupBad = backupStates.filter(s => s.status !== 'up' && !blind.includes(s));
  const firstBad = backupBad.find(s => s.status === 'down') ?? backupBad.find(s => s.status === 'degraded') ?? backupBad[0];
  const badWord = (s: JobState) => (s.status === 'down' ? 'failed' : s.status === 'degraded' ? 'overdue' : 'no data');
  const stats: Snapshot['health']['stats'] = [
    {
      id: 'mon', label: 'MONITORS UP', value: kumaOn ? `${allUp}/${km.all.length}` : '—',
      sub: !kumaOn ? 'Uptime Kuma not answering' : allDown.length === 1 ? `${allDown[0].name} not responding` : allDown.length ? `${allDown.length} not responding` : km.unmapped.length ? `${km.unmapped.length} not mapped` : 'all responding',
      ...(allDown.length ? { tone: 'danger' as const } : {}),
    },
    { id: 'up30', label: 'UPTIME · 30 DAYS', value: up30 != null ? `${up30.toFixed(2)}%` : '—', sub: `Uptime Kuma · ${plural(km.all.filter(m => fin(m.up30d)).length, 'monitor')}` },
    {
      // review finding 14: replaces median latency, which the page keeps neutral (Kuma's status decides) and so could
      // never ask anything. Info alerts never change the status line, so they're only named in the sub-line.
      id: 'alerts', label: 'ALERTS FIRING', value: firing ? String(firingSev.filter(v => v !== 'info').length) : '—',
      sub: !firing ? `Grafana ${src('grafana')?.conn === 'not-connected' ? 'not connected' : 'not answering'}` : (() => {
        const real = firing.filter((_, i) => firingSev[i] !== 'info'), info = firing.length - real.length;
        return real.length ? [real[0].name, real.length > 1 && `+${real.length - 1}`, info && `${info} info`].filter(Boolean).join(' · ') : info ? `nothing firing · ${info} info` : 'nothing firing';
      })(),
      ...(firingSev.includes('danger') ? { tone: 'danger' as const } : firingSev.includes('warn') ? { tone: 'warn' as const } : {}),
    },
    {
      // rows, like the Backups list below it (Kopia's sources count one each)
      id: 'bk', label: 'BACKUPS', value: backupRows.length ? `${backupRows.filter(r => r.status === 'up').length}/${backupRows.length}` : '—',
      sub: firstBad ? `${firstBad.job.name} ${badWord(firstBad)}${backupBad.length > 1 ? ` · +${backupBad.length - 1}` : ''}`
        : blind.length ? `${plural(blind.length, 'job')} without data · source not answering` : backupStates.length ? 'all fresh' : 'no backup jobs',
      // same tiers as Needs attention: red only for a critical job (Nightscout) failed or overdue
      ...(backupBad.length ? { tone: backupBad.some(s => s.job.critical && (s.status === 'down' || s.status === 'degraded')) ? 'danger' as const : 'warn' as const } : {}),
    },
  ];

  const vol = (name: string, used: number, total: number, usedS: string, capS: string, sub: string): Volume =>
    ({ name, used: usedS, cap: capS, pct: pctOf(used, total) ?? 0, sub, tone: diskTone(used, total, RULE_DISK.warn, RULE_DISK.danger) });
  const storage: Volume[] = [];
  // the disks and the cache sit under the array row on Health (one short line each)
  const ARRAY = 'Unraid array';
  if (un && fin(un.arrayTB)) storage.push({ ...vol(ARRAY, un.arrayUsedTB, un.arrayTB, tb(un.arrayUsedTB), tb(un.arrayTB), `${tb(Math.max(0, un.arrayTB - un.arrayUsedTB))} free`), tone: arrayT });
  for (const d of disks) storage.push({ ...vol(`Unraid ${d.disk}`, d.usedTB, d.totalTB, tb(d.usedTB), tb(d.totalTB), `${tb(Math.max(0, d.totalTB - d.usedTB))} free`), tone: 'ok', under: ARRAY });
  if (un && fin(un.cacheGB) && un.cacheGB > 0) storage.push({ ...vol('Unraid cache', un.cacheUsedGB, un.cacheGB, gb(un.cacheUsedGB), gb(un.cacheGB), `${gb(Math.max(0, un.cacheGB - un.cacheUsedGB))} free`), tone: fillTone(un.cacheUsedGB, un.cacheGB, CACHE_WARN), under: ARRAY });
  for (const p of Object.values(raw.pveStorage ?? {})) if (p && fin(p.totalGB) && p.totalGB > 0) storage.push(vol(p.label, p.usedGB, p.totalGB, gb(p.usedGB), gb(p.totalGB), p.sub));
  // homelab.json storage: rows read from Prometheus (an off-site box); one without both figures is left out
  if (fresh('prom-checks')) for (const sc of arr(cfg.storage)) {
    const r = raw.storage?.[sc?.name];
    if (r && fin(r.used) && fin(r.total) && r.total > 0) storage.push(vol(sc.name, r.used, r.total, bytes(r.used), bytes(r.total), sc.sub ?? `${bytes(Math.max(0, r.total - r.used))} free`));
  }
  for (const h of hosts) { const r = h.res, p = hostById(h.id)?.type === 'proxmox' ? ratioPct(r?.diskUsed, r?.diskTotal) : null; if (p != null && p >= 70) storage.push(vol(`${h.name} root`, r!.diskUsed!, r!.diskTotal!, bytes(r!.diskUsed), bytes(r!.diskTotal), 'host root filesystem')); }
  for (const g of guests) { const p = g.kind === 'lxc' ? ratioPct(g.res?.diskUsed, g.res?.diskTotal) : null; if (p != null && p >= 70) storage.push(vol(`${g.name} root`, g.res!.diskUsed!, g.res!.diskTotal!, bytes(g.res!.diskUsed), bytes(g.res!.diskTotal), `CT ${g.vmid} root disk`)); }

  const order = ['Proxmox', 'Unraid', 'Grafana', 'Immich'];
  const liveVersions: Snapshot['health']['versions'] = Object.entries(raw.versions ?? {}).filter(([, v]) => !!v).map(([name, version]) => ({ name, version, live: true }));
  if (raw.immich?.version && !liveVersions.some(v => v.name === 'Immich')) liveVersions.push({ name: 'Immich', version: raw.immich.version, live: true });
  const rankOf = (n: string) => { const i = order.findIndex(o => n.startsWith(o)); return i < 0 ? order.length : i; };
  liveVersions.sort((a, b) => rankOf(a.name) - rankOf(b.name) || a.name.localeCompare(b.name));
  const haUpdate = haUpdates.some(u => /core|operating.?system|\bos\b/i.test(u));
  // apt (H11): a host's version row carries its updates and its guests' (one line, so Software doesn't outgrow its band);
  // anything without such a row gets a live kernel row of its own
  for (const h of hostsCfg) {
    const v = liveVersions.find(x => x.name === `Proxmox · ${h.name}`), u = ops.updatesBy.get(h.id);
    if (!v || !u) continue;
    v.updates = u;
    const gs = (ops.view.updates ?? []).filter(x => x.kind === 'guest' && guests.find(g => g.id === x.ownerId)?.host === h.id);
    if (gs.length) v.guestUpdates = gs;
  }
  for (const u of ops.view.updates ?? []) {
    if (liveVersions.some(v => v.updates === u || v.guestUpdates?.includes(u))) continue;
    const g = u.kind === 'guest' ? guests.find(x => x.id === u.ownerId) : undefined;
    liveVersions.push({ name: g ? `${g.name} · ${g.kind === 'vm' ? 'VM' : 'CT'} ${g.vmid}` : u.name, version: u.kernel ? `kernel ${u.kernel.running.replace(/-generic$/, '')}` : '—', live: true, updates: u });
  }
  const versions = [
    ...liveVersions,
    ...(cfg.versions ?? []).filter(([n]) => !liveVersions.some(v => v.name === n)).map(([name, version, badge, asOf]) => {
      const b = /home.?assistant/i.test(name) && haUpdate ? 'UPDATE' : badge;
      return { name, version, ...(b ? { badge: b } : {}), live: false, asOf };
    }),
  ];

  // port-forwards have no safe GET; Plex's own check speaks for its forward, the rest say so
  const fwd = (e: PublicEndpointConfig): { status: Status; note: string } | null => (e.via !== 'port-forward' ? null
    : e.check === 'plex' ? (!plexNow ? { status: 'unknown', note: src('plex')?.conn === 'not-connected' ? 'no Plex token' : 'Plex not answering' }
      : plexNow.mapped ? { status: 'up', note: 'reachable' } : { status: 'down', note: plexNow.error || plexNow.state || 'not mapped' })
      : { status: 'unknown', note: "can't be checked" });
  const exposure = endpoints.map(e => { const f = fwd(e); return {
    name: e.name, host: e.host, via: e.via, origin: e.origin, status: f ? f.status : epStatus(e), code: raw.probes?.[e.host]?.code ?? null,
    ...(e.access ? { access: e.access } : {}), url: e.probe === false ? '' : `https://${e.host}`, ...(f ? { note: f.note } : {}),
  }; });
  const orphans = (cfg.retiredHosts ?? []).filter(h => fin(raw.probes?.[h]?.code)).map(h => ({ host: h, code: raw.probes![h].code }));

  const connState = (name: string, fallback: string) => { const s = src(name); return !s ? fallback : s.conn === 'not-connected' ? 'not connected' : FRESH.has(s.conn) ? fallback : 'not answering'; };
  // where each runs (the guest whose services name it), and only the ones whose module is on
  const at = (re: RegExp, what: string) => [whereOf(cfg, re), what].filter(Boolean).join(' · ');
  const mod = (m: ModuleId) => (opts.modules?.[m] ?? 'on') !== 'off';
  const alerting: Snapshot['health']['alerting'] = [
    ...(mod('kuma') ? [{ name: 'Uptime Kuma', where: at(/uptime.?kuma/i, kumaOn ? plural(km.all.length, 'monitor') : ''), state: kumaOn ? (allDown.length ? `${allDown.length} down` : 'all up') : connState('kuma', 'not answering'), tone: (!kumaOn ? 'warn' : allDown.length ? 'danger' : 'ok') as Tone }] : []),
    ...(mod('grafana') ? [{
      name: 'Grafana', where: at(/grafana/i, 'alert rules'), state: firing ? (firing.length ? `${firing.length} firing` : 'nothing firing') : connState('grafana', 'not answering'),
      tone: (!firing ? 'warn' : firingSev.includes('danger') ? 'danger' : firingSev.includes('warn') ? 'warn' : 'ok') as Tone,
    }] : []),
    ...(mod('ntfy') ? [{ name: 'ntfy', where: at(/^ntfy/i, 'push alerts'), state: raw.ntfyUp == null ? connState('ntfy', 'not answering') : raw.ntfyUp ? 'up' : 'not answering', tone: (raw.ntfyUp ? 'ok' : raw.ntfyUp === false ? 'danger' : 'warn') as Tone }] : []),
    ...(mod('prometheus') ? [{
      name: 'Prometheus targets', where: at(/prometheus/i, 'every exporter it scrapes'),
      state: targets ? (downTargets.length ? `${downTargets.length} of ${targets.length} down: ${[...new Set(downTargets.map(t => t.job))].join(', ')}` : `all ${targets.length} up`) : connState('prom-infra', 'not answering'),
      tone: (targets && !downTargets.length ? 'ok' : 'warn') as Tone,
    }] : []),
    ...checks.rows,
    ...(mod('wud') ? [{ name: 'WUD', where: 'container updates', state: raw.wud ? (raw.wud.updates ? plural(raw.wud.updates, 'update') : 'up to date') : connState('wud', 'not answering'), tone: (raw.wud ? (raw.wud.updates > (rules?.wudUpdatesAbove ?? 0) ? 'warn' : 'ok') : 'warn') as Tone }] : []),
  ];

  const activity = Array.isArray(raw.activity) ? [...raw.activity].sort((a, b) => b.at - a.at).slice(0, 30).map(m => ({ at: m.at, topic: m.topic, title: plainTitle(m.title), body: m.body, level: ntfyLevel(m) })) : null;

  // ---- the spotlight block
  const nsApp = appsCfg.find(isNs);
  const nsSig = nsApp ? appSignals(nsApp) : null;
  /** a blip shows as 'degraded' here (amber dot) without touching the status line */
  const shown = (st: Status, sigs: { blip: boolean }[]) => (st === 'up' && sigs.some(x => x.blip) ? 'degraded' : st);
  const spotlight: Snapshot['spotlight'] = nsApp && nsSig ? {
    name: nsApp.label, status: apps.find(a => a.name === nsApp.name)!.status,
    signals: [
      { name: 'LAN', status: shown(nsSig.lan, spSig('lan')) }, { name: 'Public', status: shown(nsSig.pub, spSig('public')) },
      ...spSig('other').map(x => ({ name: x.name, status: shown(x.status, [x]) })),
    ],
    probed: !!spCfg?.probeQuery, probeAgeSec: nsAge == null ? null : Math.round(nsAge), autoRecoveries: ns && fin(ns.recoveries) ? ns.recoveries : null,
    backupAt: spCfg?.backupJob ? jobLast(spCfg.backupJob) : null, restoreAt: spCfg?.restoreJob ? jobLast(spCfg.restoreJob) : null,
    backupJob: spCfg?.backupJob ?? null, restoreJob: spCfg?.restoreJob ?? null, ...(spCfg?.backupLabel ? { backupLabel: spCfg.backupLabel } : {}), url: nsApp.publicUrl ?? nsApp.url ?? '',
  } : null;

  // ---- network
  const aps = switchAps(cfg);
  const internet: Status = net?.wanUp === false || allTunnelDown || ops.mainTunnelDown ? 'down' : tunnelSt.includes('up') ? 'up' : 'unknown';

  // ---- home (display-only: real HA state, nothing here can act on a device)
  const hac = cfg.homeAssistant;
  const noHa = ha ? 'no data from Home Assistant' : 'Home Assistant data not available';
  const g = ha?.garage;

  const sb = raw.seerr, so = raw.sonarr, ra = raw.radarr;
  return {
    at: now, modules: opts.modules ?? allOn(), ui: resolveUi(cfg), build: opts.build, mock: opts.mock, incident: status.tone === 'danger', ...(opts.incident ? { simulated: true } : {}),
    sources, fresh: freshView,
    weather: raw.weather ? { ...raw.weather, place: cfg.location?.name ?? '' } : null,
    status, kpis,
    network: {
      subnet: cfg.network?.subnet ?? '',
      gateway: gwC ? {
        name: gwC.name, ipShort: octet(gwC.ip), status: gwC.snmpJob ? bool(net?.gwUp) : 'unknown', wan: gwC.snmpJob && gwC.wanIf ? bool(net?.wanUp) : 'unknown',
        devices: fin(raw.lanDevices) ? raw.lanDevices : null, devicesSource: fin(raw.lanDevices) ? cfg.network?.deviceCount?.source ?? null : null,
        devicesNote: cfg.network?.deviceCount?.note ?? 'active on the LAN',
      } : null,
      internet,
      switch: swC ? { name: swC.name, ipShort: octet(swC.ip), status: swC.snmpJob ? bool(net?.switchUp) : 'unknown', mirror: swC.mirrorPort || null, firmware: swC.firmware ?? null, eol: !!swC.eol, aps: aps.length } : null,
      aps: aps.map(a => ({ name: a.name, port: a.port, status: bool(net?.ports?.[a.port]) })),
      segments: segC.map(sg => {
        const ap = arr(cfg.network?.accessPoints).find(a => a.segment === sg.id);
        return { id: sg.id, label: ap ? `${ap.name} · ${ap.short ?? ap.model}` : sg.name, status: sg.gatewayIf && gwC?.snmpJob ? bool(net?.segments?.[sg.id]) : 'unknown' };
      }),
      publicCount: endpoints.length,
      tunnelName: cfg.network?.tunnel ?? null,
      ...(ops.tunnel ? { tunnel: ops.tunnel } : {}),
    },
    hosts, guests, uis, apps,
    attention: shipItems(sorted),
    activity,
    alerts: firing ? firing.map(a => ({ name: a.name, severity: grafanaSeverity(a.severity, a.labels ?? {}), summary: a.summary, since: a.since, url: a.path ? new URL(a.path, grafanaUrl).toString() : grafanaUrl })) : null,
    spotlight,
    plex: {
      streams: raw.tautulli?.streams ?? null, movies: raw.plexLibrary?.movies ?? null, shows: raw.plexLibrary?.shows ?? null,
      queued: so || ra ? (so?.queued ?? 0) + (ra?.queued ?? 0) : null, nowPlaying: raw.tautulli?.nowPlaying ?? null, others: raw.tautulli?.others ?? 0, recent: raw.tautulli?.recent ?? [],
    },
    media: { immich: raw.immich, seerr: sb, sonarr: so, radarr: ra, bazarr: raw.bazarr, prowlarr: raw.prowlarr, chaptarr: raw.chaptarr, qbit: raw.qbit, nzbget: raw.nzbget, alsoRunning: cfg.mediaAlsoRunning ?? [],
      delta7: opts.delta7 ?? (Object.fromEntries(LIBRARY_KEYS.map(k => [k, null])) as Record<LibraryKey, null>) },
    health: {
      stats, monitors: uptimeMonitors, unmapped: unmappedRows, jobs, storage, versions, exposure, orphans, alerting,
      unmonitored,
      ops: ops.view,
    },
    home: {
      configured: {
        locks: arr(hac?.locks).length > 0, garage: !!hac?.garage, climate: !!hac?.climate || arr(hac?.moreClimates).length > 0,
        safety: arr(hac?.smoke).length > 0 || !!hac?.printer, appliances: arr(hac?.appliances).length > 0, lights: arr(hac?.lights).length > 0,
      },
      haUp: ha ? ha.up : null,
      updates: ha ? haUpdates : null,
      climate: ha?.climate ? { ...ha.climate, outside: raw.weather?.tempC ?? null } : null,
      garage: g ? { open: g.open, sub: g.available === false ? 'Unavailable in Home Assistant' : `${g.open ? 'Open' : 'Closed'}${fin(g.since) ? ` since ${clock(g.since, now)}` : ''}`, obstruction: g.obstruction, light: g.light, available: g.available } : null,
      moreClimates: ha?.moreClimates ?? arr(hac?.moreClimates).map(c => ({ name: c.name, indoor: NaN, setpoint: null, setpointRange: null, humidity: null, mode: '—', action: null, available: false, battery: null })),
      lights: ha?.lights ?? arr(hac?.lights).map(l => ({ name: l.name, room: l.room, on: null, brightness: null, available: false })),
      appliances: ha?.appliances ?? arr(hac?.appliances).map(a => ({ kind: a.kind, name: a.name, state: 'no-data' as const, progress: null, remainingMin: null, finishAt: null, battery: null, areaM2: null, lastAt: null, energyTodayKwh: null, maintenance: null })),
      smoke: (hac?.smoke ?? []).map(d => arr(ha?.smoke).find(x => x.name === d.name) ?? { name: d.name, state: 'no-data' as const, detail: noHa }),
      locks: arr(hac?.locks).map(l => ({
        ...(arr(ha?.locks).find(x => x.name === l.name) ?? { name: l.name, state: 'no-data' as const, since: null, battery: null, door: null }),
        sensors: { door: !!l.door, jam: !!l.jammed },
      })),
      printer: hac?.printer ? { model: hac.printer.model, available: ha?.printer?.available ?? false, toner: ha?.printer?.toner ?? null } : null,
      haUrl: uiAt('homeassistant') ?? '',
    },
    devices,
    // the saved list (DATA_DIR/links.json, server/links.ts) when index.ts passes it, else homelab.json's seed
    links: links.groups.map(g => ({ group: g.name, items: g.items.map(l => linkView(l.name, l.url)) })),
    linksMeta: { updatedAt: links.updatedAt, fromFile: links.fromFile, error: links.error },
  };
}

/** A job's own Grafana alerts: its `alert` pattern from homelab.json, else its id's words ('appdata' ↔ 'Appdata Backup Failed'). */
function jobAlert(j: JobConfig): RegExp {
  if (j.alert) try { return new RegExp(j.alert, 'i'); } catch { /* a bad pattern falls back to the id */ }
  return new RegExp(String(j.id).split(/[-_]/).join('[\\s_-]*'), 'i');
}

/** Grafana's 'Swap High with Low Memory Headroom' as an item (shared/rules.ts memPressure). */
function pressureItem(id: string, name: string, r: Res, source: string, labels: string[], where = ''): Item {
  const pct = (u: number | null, t: number | null) => Math.floor(ratioPct(u, t) ?? 0);
  return {
    id, severity: 'warn', rank: 55, source, title: `${name}: memory pressure`, dupe: { name: /swap|memory/i, label: labels },
    detail: [where, `memory ${pct(r.memUsed, r.memTotal)}% used and swap ${pct(r.swapUsed, r.swapTotal)}% · it is swapping`].filter(Boolean).join(' · '),
  };
}

/** '🚨 [FIRING:1] …' → '[FIRING:1] …': the feed's dot already carries the level, and the page uses no emoji */
const plainTitle = (t: string) => String(t ?? '').replace(/^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u, '');

/** ntfy message → feed level. RESOLVED is checked first: Grafana's resolved messages repeat the alert's words. */
function ntfyLevel(m: { title: string; body: string; priority: number; tags: string[] }): 'danger' | 'warn' | 'info' | 'ok' {
  const t = m.title ?? '', tags = (m.tags ?? []).join(' ');
  if (/resolved|restored|recovered|✅|\[pass\]|\bok\b/i.test(t) || /white_check_mark|heavy_check_mark/.test(tags)) return 'ok';
  const firing = /firing/i.test(t);
  if (m.priority >= 5 || (firing && /critical/i.test(t))) return 'danger';
  if (firing && /\b(info|maintenance)\b/i.test(t)) return 'info';
  if (m.priority === 4 || firing || /fail|error/i.test(t)) return 'warn';
  return 'info';
}

