// Modules ups, unraid, apt and edge (adapter prom-ops) → Health's Power, Unraid disks, Edge and Updates views, the
// POWER KPI and their Needs attention items. Same rules as derive.ts: pure and total, nothing old shown as current
// (a stale collector's values are null and say since when), and an area whose metrics don't exist yet is listed as
// 'not monitored yet', never an error. The metrics each module reads are in docs/INTEGRATIONS.md.
import type { DiskHealthView, GuestConfig, HomelabConfig, HostConfig, Kpi, OpsLine, OpsTone, OpsView, PowerView, Snapshot, Tone, UpdatesView } from '../../shared/types.ts';
import type { Raw } from '../raw.ts';
import type { Item } from './attention.ts';
import { arr, clock, day, dur, fin, plural, slug, whereOf } from './util.ts';

/** Grafana's 'UPS Metrics Stale': the collector runs every 60 s */
const UPS_STALE_SEC = 180;
/** the Unraid collector runs every 5 min; 'Unraid Health Metrics Missing' says 20 min */
const UNRAID_STALE_SEC = 20 * 60;
const PARITY_OVERDUE_D = 40;
const APT_STALE_SEC = 2 * 3600, APT_LISTS_OLD_SEC = 3 * 86400, APT_SECURITY_D = 14, APT_REBOOT_D = 7;
/** cloudflared registers 4 connections per connector */
const TUNNEL_FULL = 4;

export interface OpsCtx {
  raw: Raw; cfg: HomelabConfig; now: number;
  /** prom-ops answered within its max age */
  fresh: boolean;
  /** seconds between an epoch-ms time and prom-ops' last answer (ages are judged as of the read) */
  lag: (at: number | null | undefined) => number | null;
}
export interface OpsOut {
  view: OpsView;
  items: Item[];
  /** config job ids whose own item an ops item already explains (the jobs loop skips them) */
  claims: Set<string>;
  kpi: Kpi | null;
  tunnel: Snapshot['network']['tunnel'];
  /** the main tunnel has no connection to Cloudflare (fresh data) */
  mainTunnelDown: boolean;
  /** the other tunnels (cloudflared jobs) with no connection: the endpoints they carry are then explained */
  downTunnels: Set<string>;
  /** updates keyed by HostView.id / GuestView.id */
  updatesBy: Map<string, UpdatesView>;
}

const TONE_RANK: Record<OpsTone, number> = { danger: 0, warn: 1, none: 2, info: 3, ok: 4 };
export const opsFirst = <T extends { tone: OpsTone }>(xs: T[]) => xs.map((x, i) => ({ x, i })).sort((a, b) => TONE_RANK[a.x.tone] - TONE_RANK[b.x.tone] || a.i - b.i).map(e => e.x);
const hours1 = (sec: number) => (sec >= 100 * 3600 ? dur(sec) : `${(sec / 3600).toFixed(1)} h`);
const ipOf = (instance: string) => instance.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

export function deriveOps(c: OpsCtx): OpsOut {
  const { raw, cfg, now, fresh, lag } = c;
  const items: Item[] = [], claims = new Set<string>(), missing: OpsView['missing'] = [];
  const add = (i: Item) => { items.push(i); };
  const targets = Array.isArray(raw.promTargets) ? raw.promTargets : null;
  /** why an area has nothing: Prometheus itself, the exporter its textfile rides on, or no metrics yet */
  const absent = (id: string, name: string, needs: string, job?: string) => {
    const t = job ? targets?.filter(x => x.job === job) : undefined;
    const why = !fresh ? 'Prometheus not answering' : t?.length && t.every(x => !x.up) ? `${job} not answering` : 'not monitored yet';
    missing.push({ id, name, why, needs });
  };
  const jobCovers = (re: RegExp) => arr(cfg.jobs).some(j => j?.signal === 'prometheus' && re.test(`${j.last ?? ''} ${j.ok ?? ''}`));
  const coveringJob = (re: RegExp) => arr(cfg.jobs).find(j => j?.signal === 'prometheus' && re.test(`${j.last ?? ''} ${j.ok ?? ''}`))?.id;
  const unraidHost = arr(cfg.hosts).find(x => x?.type === 'unraid');
  const unraidDown = !!unraidHost && raw.hostStatus?.[unraidHost.id] === 'down';
  // the UPS: what the lab calls it, and the host whose apcupsd reports it (it shuts down on its own thresholds)
  const upsName = cfg.ups?.name?.trim() || 'UPS', upsHost = arr(cfg.hosts).find(x => x?.id === cfg.ups?.host);
  const upsOn = upsHost ? ` on ${upsHost.name}` : '', upsSrc = `Prometheus · apcupsd${upsHost ? ` (${upsHost.name})` : ''}`, shutWho = upsHost?.name ?? 'the host';
  const readClock = (at: number | null) => (at == null ? 'never' : clock(at, now));

  // ================= ups =================
  let power: PowerView | null = null, kpi: Kpi | null = null;
  const u = fresh ? raw.ups : null;
  if (!u) absent('power', upsName, `apcupsd metrics${upsOn}`, upsHost?.nodeJob);
  else {
    const runLag = lag(u.collectorRunAt);
    // 'collector' problems are the ups-collector job's to report once homelab.json has it; 'data' ones are ours
    const collectorWhy = u.collectorOk === false ? "the collector's last run failed" : runLag == null ? 'the collector has not run' : runLag > UPS_STALE_SEC ? `the collector last ran ${dur(runLag)} ago` : null;
    const dataWhy = collectorWhy ? null : u.up === false ? `apcupsd${upsOn} isn't answering` : u.flags.comm_lost ? `${shutWho} lost its UPS master (COMMLOST)`
      : u.dataFresh === false ? `the master's data is ${fin(u.dataAgeSec) ? dur(u.dataAgeSec) : 'too'} old` : null;
    const ok = !collectorWhy && !dataWhy;
    const name = upsName, model = u.model;
    const onBatt = ok && u.flags.on_battery === true;
    const runtimeSec = !ok ? null : onBatt ? u.timeLeftSec : u.timeLeftAvgSec ?? u.timeLeftSec;
    const runtimeMin = fin(runtimeSec) ? runtimeSec / 60 : null, charge = ok ? u.chargePct : null;
    const low = ok && (u.flags.low_battery === true || (fin(charge) && charge < 50) || (fin(runtimeMin) && runtimeMin < 15));
    const replace = ok && u.flags.replace_battery === true, overload = ok && u.flags.overload === true, noBatt = ok && u.flags.battery_present === false;
    const onBattSec = onBatt && fin(u.onBatterySec) ? u.onBatterySec : null;
    const until = onBatt ? [
      fin(u.shutdownOnBatterySec) && fin(onBattSec) ? u.shutdownOnBatterySec - onBattSec : null,
      fin(u.timeLeftSec) && fin(u.shutdownTimeLeftSec) ? u.timeLeftSec - u.shutdownTimeLeftSec : null,
    ].filter(fin) : [];
    const shutdownSec = until.length ? Math.max(0, Math.min(...until)) : null;
    const state = !ok ? 'Stale' : low ? 'Battery low' : onBatt ? 'On battery' : replace ? 'Replace battery' : overload ? 'Overload' : noBatt ? 'No battery' : 'On mains';
    const tone: Tone = !ok ? 'warn' : low || onBatt ? 'danger' : replace || overload || noBatt ? 'warn' : 'ok';
    const loadW = ok && fin(u.loadPct) && fin(u.nominalW) ? (u.loadPct * u.nominalW) / 100 : null;
    const sub = !ok ? `${collectorWhy ?? dataWhy} · values hidden until it reads again`
      : onBatt ? `${dur(onBattSec ?? 0)} on battery${shutdownSec != null ? ` · ${shutWho} shuts down in ${dur(shutdownSec)}` : ''}`
        : `apcupsd ${u.status ?? 'ONLINE'}`;
    const masterIp = u.master?.replace(/:\d+$/, '') ?? '';
    const masterHost = arr(cfg.hosts).find(x => x?.ip === masterIp || x?.altIp === masterIp);
    const later = [fin(u.shutdownTimeLeftSec) && `${dur(u.shutdownTimeLeftSec)} left`, fin(u.shutdownChargePct) && `${Math.round(u.shutdownChargePct)}%`].filter(Boolean).join(' or ');
    // facts only from apcupsd itself (no hand-typed thresholds): the master, the mains window, history, the host's own triggers
    const lines: OpsLine[] = [
      ...(u.master ? [{ id: 'ups-master', name: 'Master', value: masterHost?.name ?? masterIp, sub: `${u.master}${upsHost ? ` · ${upsHost.name} is its client` : ''}`, tone: 'none' as const }] : []),
      ...(fin(u.transferLowV) && fin(u.transferHighV) ? [{ id: 'ups-mains', name: 'Mains window', value: `${Math.round(u.transferLowV)}–${Math.round(u.transferHighV)} V`, sub: `${fin(u.nominalV) ? `nominal ${Math.round(u.nominalV)} V · ` : ''}outside it the UPS runs on battery`, tone: 'none' as const }] : []),
      {
        id: 'ups-transfer', name: 'Last on battery', tone: 'none',
        value: u.lastOnBatteryAt ? readClock(u.lastOnBatteryAt) : 'never',
        sub: [u.lastTransferReason, fin(u.transfers) ? `${plural(u.transfers, 'transfer')} since ${u.daemonStartAt ? day(u.daemonStartAt) : 'apcupsd started'} (apcupsd's start)` : ''].filter(Boolean).join(' · ') || 'since apcupsd started',
      },
      ...(fin(u.shutdownOnBatterySec) ? [{ id: 'ups-shutdown', name: `${upsHost?.name ?? 'Host'} shuts down`, value: `after ${dur(u.shutdownOnBatterySec)}`, sub: `on battery${later ? `, or at ${later}` : ''} · its apcupsd`, tone: 'none' as const }] : []),
    ];
    power = {
      name, model, state, tone, fresh: ok, sub, chargePct: charge, runtimeMin, loadPct: ok ? u.loadPct : null, loadW, lineV: ok ? u.lineV : null,
      onBatterySec: onBattSec, shutdownSec, shutdownHost: upsHost?.name ?? null, lines, readAt: u.collectorRunAt,
    };
    kpi = {
      id: 'power', label: 'POWER', value: ok ? state : '—',
      sub: ok ? [fin(charge) && `${Math.round(charge)}%`, fin(runtimeMin) && `${Math.floor(runtimeMin)} min`, fin(loadW) && `${Math.round(loadW)} W`].filter(Boolean).join(' · ') || upsName : `${upsName} · stale`,
      ...(tone !== 'ok' ? { tone } : {}),
    };
    const upsDupe = (re: RegExp) => ({ name: re });
    if (onBatt || low) add({
      id: 'ups', severity: 'danger', rank: 2, source: upsSrc, dupe: upsDupe(/^ups (on battery|battery low)/i),
      since: onBattSec != null ? now - onBattSec * 1000 : u.lastOnBatteryAt,
      title: onBatt ? `${upsName} on battery${fin(runtimeMin) ? ` · ${Math.floor(runtimeMin)} min left` : ''}` : `${upsName} battery low`,
      detail: [onBatt && shutdownSec != null ? `${shutWho} shuts down in ${dur(shutdownSec)}` : '', fin(charge) ? `charge ${Math.round(charge)}%` : '', fin(runtimeMin) ? `runtime ${Math.floor(runtimeMin)} min` : '',
        onBatt ? 'hosts shut down on their own thresholds' : 'another outage now would shut hosts down early'].filter(Boolean).join(' · '),
    });
    else if (replace || overload || noBatt) add({
      id: 'ups', severity: 'warn', rank: 53, source: upsSrc, dupe: upsDupe(/^ups needs attention/i),
      title: `${upsName}: ${replace ? 'replace the battery' : overload ? 'overloaded' : 'no battery'}`, detail: `${model ?? 'UPS'} · apcupsd ${u.status ?? ''}`.trim(),
    });
    if (!ok && !(collectorWhy && jobCovers(/apcupsd_collector/))) add({
      id: 'ups-stale', severity: 'warn', rank: 61, source: upsSrc, dupe: upsDupe(/^ups metrics stale/i), since: u.collectorRunAt,
      title: `${upsName} state unknown`, detail: `${collectorWhy ?? dataWhy} · charge and runtime read —`,
    });
  }

  // ================= unraid: array, parity, disks =================
  const h = fresh ? raw.unraidHealth : null;
  let disks: OpsView['disks'] = null;
  if (!h) absent('disks', 'Unraid disk health', 'the Unraid health collector', unraidHost?.nodeJob);
  else {
    const runLag = lag(h.collectorRunAt);
    const stale = h.collectorOk === false ? "the collector's last run failed" : runLag == null ? 'no run yet' : runLag > UNRAID_STALE_SEC ? `not read for ${dur(runLag)}` : null;
    const lines: OpsLine[] = [], rows: DiskHealthView[] = [];
    let parityProgress: number | null = null;
    const cover = coveringJob(/unraid_array_collector/);
    if (stale) {
      if (!unraidDown && !cover) add({
        id: 'unraid-health-stale', severity: 'warn', rank: 61, source: 'Prometheus · Unraid health', dupe: { name: /unraid health metrics missing/i }, since: h.collectorRunAt,
        title: 'Unraid disk health not read', detail: `${stale} · array, disk and parity figures read —`,
      });
    } else {
      // -- array
      const st = h.state ?? (h.started ? 'STARTED' : h.started === false ? 'STOPPED' : null);
      const arrayBad = h.started === false ? `Unraid array is ${(st ?? 'stopped').toLowerCase()}` : h.maintenance ? 'Unraid array in maintenance mode' : fin(h.unmountable) && h.unmountable > 0 ? `Unraid: ${plural(h.unmountable, 'filesystem')} unmountable` : null;
      lines.push({
        id: 'array', name: 'Array', tone: arrayBad ? 'danger' : h.started ? 'ok' : 'none',
        value: arrayBad ? (h.maintenance ? 'Maintenance' : h.started === false ? 'Stopped' : 'Unmountable') : h.started ? 'Started' : '—',
        sub: [fin(h.mounted) && `${h.mounted} filesystems mounted`, fin(h.unmountable) && h.unmountable > 0 && `${h.unmountable} unmountable`, h.mover && 'mover running'].filter(Boolean).join(' · ') || 'state unknown',
      });
      if (arrayBad) add({
        id: 'unraid-array', severity: 'danger', rank: 11, source: 'Prometheus · Unraid health', dupe: { name: /unraid array not started/i },
        title: arrayBad, detail: `state ${st ?? '—'} · its shares and apps depend on it`,
      });
      // -- parity
      const p = h.parity;
      if (p.running) {
        parityProgress = fin(p.progress) ? Math.max(0, Math.min(1, p.progress)) : null;
        const pct = parityProgress != null ? `${Math.floor(parityProgress * 100)}%` : '';
        const speed = fin(p.speedBps) && p.speedBps > 0 ? `${Math.round(p.speedBps / 1e6)} MB/s` : '';
        const started = p.lastStartAt && p.lastEndAt && p.lastStartAt > p.lastEndAt ? `started ${clock(p.lastStartAt, now)}` : '';
        lines.push({ id: 'parity', name: 'Parity check', tone: 'info', value: p.paused ? `paused ${pct}`.trim() : pct || 'running', sub: [p.paused ? 'paused' : 'running', speed, started].filter(Boolean).join(' · '), ...(p.action ? { title: `mdResyncAction: ${p.action}` } : {}) });
        add({ id: 'parity-running', severity: 'info', rank: 88, source: 'Prometheus · Unraid health', title: `Parity check ${p.paused ? 'paused' : 'running'}${pct ? ` · ${pct}` : ''}`, detail: [speed, started, 'the array is slower until it finishes'].filter(Boolean).join(' · ') });
      } else if (p.lastEndAt) {
        const errs = fin(p.lastErrors) && p.lastErrors > 0, badExit = fin(p.lastExit) && p.lastExit !== 0 && p.lastExit !== -4;
        const ageD = (lag(p.lastEndAt) ?? 0) / 86400, overdue = ageD > PARITY_OVERDUE_D;
        const how = p.lastExit === -4 ? 'cancelled' : badExit ? `exit ${p.lastExit}` : 'finished';
        lines.push({
          id: 'parity', name: 'Parity check', tone: errs || badExit ? 'danger' : overdue ? 'warn' : 'ok',
          value: `${day(p.lastEndAt)} · ${fin(p.lastErrors) ? plural(p.lastErrors, 'error') : 'errors —'}`,
          sub: [how, fin(p.lastDurationSec) && hours1(p.lastDurationSec), overdue && `${Math.floor(ageD)} days ago`].filter(Boolean).join(' · '),
        });
        if (errs || badExit) add({
          id: 'parity', severity: 'danger', rank: 36, source: 'Prometheus · Unraid health', dupe: { name: /parity check errors/i }, since: p.lastEndAt,
          title: errs ? `Last parity check found ${plural(p.lastErrors!, 'error')}` : `Last parity check ended with exit ${p.lastExit}`,
          detail: `${day(p.lastEndAt)} · ${fin(p.lastDurationSec) ? hours1(p.lastDurationSec) : ''} · check the array's disks and run a non-correcting check`.replace(' ·  ·', ' ·'),
        });
        else if (overdue) add({
          id: 'parity', severity: 'warn', rank: 57, source: 'Prometheus · Unraid health', dupe: { name: /parity check overdue/i }, since: p.lastEndAt + PARITY_OVERDUE_D * 86400e3,
          title: `No parity check in ${Math.floor(ageD)} days`, detail: `last one ${day(p.lastEndAt)}`,
        });
      } else lines.push({ id: 'parity', name: 'Parity check', tone: 'none', value: 'none recorded', sub: 'no finished check in mdstat yet' });
      // -- disks (problems first; temperatures neutral: there is no temperature rule, on purpose)
      for (const d of arr(h.disks)) {
        const status = d.ok === false || (d.status && d.status !== 'DISK_OK') ? (d.status ?? 'not OK') : h.started && d.fsMounted === false ? 'not mounted' : d.status ? 'OK' : '—';
        const notOk = status !== 'OK' && status !== '—';
        const smartBad = [fin(d.errors) && d.errors > 0 && `${plural(d.errors, 'error')}`, fin(d.pending) && d.pending > 0 && `${d.pending} pending`,
          fin(d.offlineUncorrectable) && d.offlineUncorrectable > 0 && `${d.offlineUncorrectable} uncorrectable`, fin(d.failingNow) && d.failingNow > 0 && `${plural(d.failingNow, 'attribute')} failing`,
          fin(d.grown) && d.grown > 0 && `+${d.grown} in 7 d`].filter(Boolean) as string[];
        const noSmart = [d.reallocated, d.pending, d.crc, d.powerOnHours].every(x => x == null);
        const notes = [fin(d.reallocated) && d.reallocated > 0 && `${d.reallocated} reallocated`, fin(d.crc) && d.crc > 0 && `${d.crc} CRC`, fin(d.failedPast) && d.failedPast > 0 && `${d.failedPast} failed in the past`].filter(Boolean) as string[];
        const smart = smartBad.length ? smartBad.join(' · ') : noSmart ? (fin(d.errors) ? 'no SMART data' : '—') : ['SMART ok', ...notes].join(' · ');
        const tone: OpsTone = notOk ? 'danger' : smartBad.length ? 'warn' : status === 'OK' ? 'ok' : 'none';
        rows.push({ disk: d.disk, type: d.type, tone, status, tempC: d.tempC, spundown: d.spundown === true, smart, hours: d.powerOnHours });
        if (notOk) add({
          id: `udisk-${slug(d.disk)}`, severity: 'danger', rank: 13, source: 'Prometheus · Unraid health', dupe: { name: /disk not ok/i, label: d.disk },
          title: `Unraid ${d.disk}: ${status}`, detail: `${d.type || 'disk'} · ${status === 'not mounted' ? 'its filesystem is not mounted while the array runs' : 'Unraid no longer trusts this disk; the array may be running unprotected'} · open Main in Unraid`,
        });
        else if (smartBad.length) add({
          id: `usmart-${slug(d.disk)}`, severity: 'warn', rank: 50, source: 'Prometheus · Unraid health', dupe: { name: /disk errors|smart/i, label: d.disk },
          title: `Unraid ${d.disk}: ${smartBad[0]}`, detail: [d.type, ...smartBad.slice(1), fin(d.powerOnHours) && `${(d.powerOnHours / 8766).toFixed(1)} years powered on`].filter(Boolean).join(' · '),
        });
      }
    }
    disks = { lines, parityProgress, rows: opsFirst(rows), stale: stale ? `${stale}${h.collectorRunAt ? ` · last read ${readClock(h.collectorRunAt)}` : ''}` : null, readAt: h.collectorRunAt };
  }

  // ================= apt =================
  const hostsCfg = arr(cfg.hosts).filter(x => x?.id), guestsCfg = arr(cfg.guests).filter(g => g?.host && fin(g.vmid));
  const owner = (job: string, instance: string, host: string | null): { kind: 'host' | 'guest'; id: string; name: string } => {
    const ip = ipOf(instance);
    const hc: HostConfig | undefined = hostsCfg.find(x => x.ip === ip || x.altIp === ip) ?? hostsCfg.find(x => x.nodeJob && x.nodeJob === job);
    if (hc) return { kind: 'host', id: hc.id, name: hc.name };
    const gc: GuestConfig | undefined = guestsCfg.find(g => g.ip === ip);
    if (gc) return { kind: 'guest', id: `${gc.host}-${gc.vmid}`, name: gc.name };
    return { kind: 'host', id: slug(host ?? (ip || job)), name: host ?? (ip || job) };
  };
  const apt = fresh ? arr(raw.apt) : [];
  const updates: UpdatesView[] = [], updatesBy = new Map<string, UpdatesView>();
  const staleHosts: { u: UpdatesView; why: string; labels: string[] }[] = [];
  for (const a of apt) {
    const o = owner(a.job, a.instance, a.host), labels = [a.host, ipOf(a.instance)].filter((x): x is string => !!x);
    const runLag = lag(a.collectorRunAt), cacheLag = lag(a.cacheAt);
    const stale = a.collectorOk === false ? 'its last run failed' : runLag == null ? 'no run yet' : runLag > APT_STALE_SEC ? `last run ${dur(runLag)} ago` : null;
    const listsOld = !stale && cacheLag != null && cacheLag > APT_LISTS_OLD_SEC;
    const secLag = lag(a.securitySince), rebootLag = lag(a.rebootSince);
    const secOld = !stale && fin(a.security) && a.security > 0 && secLag != null && secLag > APT_SECURITY_D * 86400;
    const rebootOld = !stale && a.reboot === true && rebootLag != null && rebootLag > APT_REBOOT_D * 86400;
    const kernelNote = a.kernel && a.kernel.expected !== a.kernel.running ? ` (${a.kernel.expected} installed)` : '';
    const pend = a.pending ?? 0, sec = a.security ?? 0;
    const value = stale ? '—' : !pend && !sec ? 'up to date' : sec ? `${pend} · ${sec} security` : plural(pend, 'update');
    const sub = stale ? `not answering · ${stale}` : [
      sec && a.securitySince ? `security since ${day(a.securitySince)}` : '',
      a.reboot ? `reboot needed${a.rebootSince ? ` since ${day(a.rebootSince)}` : ''}${kernelNote}` : a.reboot === false ? 'no reboot needed' : '',
      fin(a.held) && a.held > 0 ? `${a.held} held` : '', listsOld ? `package lists ${dur(cacheLag!)} old` : '',
    ].filter(Boolean).join(' · ') || 'apt';
    const tone: OpsTone = stale || listsOld || secOld || rebootOld ? 'warn' : pend || sec || a.reboot ? 'info' : 'ok';
    const view: UpdatesView = {
      id: `${o.kind}-${o.id}`, name: o.name, kind: o.kind, ownerId: o.id, pending: stale ? null : a.pending, security: stale ? null : a.security, held: stale ? null : a.held,
      securitySince: stale ? null : a.securitySince, reboot: stale ? null : a.reboot, rebootSince: stale ? null : a.rebootSince, kernel: stale ? null : a.kernel, value, sub, tone,
    };
    updates.push(view); updatesBy.set(o.id, view);
    const src = 'Prometheus · apt';
    if (stale || listsOld) staleHosts.push({ u: view, why: stale ?? `package lists ${dur(cacheLag!)} old (pve-daily-update or apt-daily stopped?)`, labels });
    if (secOld) add({
      id: `apt-sec-${slug(o.id)}`, severity: 'warn', rank: 64, source: src, dupe: { name: /security updates pending/i, label: labels }, since: a.securitySince! + APT_SECURITY_D * 86400e3,
      title: `${o.name}: ${plural(sec, 'security update')} waiting ${Math.floor(secLag! / 86400)} days`, detail: `pending since ${day(a.securitySince!)} · ${plural(pend, 'update')} in all ${cfg.apt?.window ? ` · apply them in the ${cfg.apt.window}` : ''}`,
    });
    if (rebootOld) add({
      id: `apt-reboot-${slug(o.id)}`, severity: 'warn', rank: 66, source: src, dupe: { name: /reboot required/i, label: labels }, since: a.rebootSince! + APT_REBOOT_D * 86400e3,
      title: `${o.name} needs a reboot`, detail: `since ${day(a.rebootSince!)}${kernelNote} · the new kernel isn't running yet`,
    });
  }
  if (staleHosts.length > 3) add({ id: 'apt-stale', severity: 'warn', rank: 61, source: 'Prometheus · apt', dupe: { name: /apt metrics collector/i }, title: `Updates collector not answering on ${staleHosts.length} hosts`, detail: staleHosts.map(s => s.u.name).join(', ') + ' · their update counts read —' });
  else for (const s of staleHosts) if (!(s.u.kind === 'host' && raw.hostStatus?.[s.u.ownerId] === 'down')) add({
    id: `apt-stale-${slug(s.u.ownerId)}`, severity: 'warn', rank: 61, source: 'Prometheus · apt', dupe: { name: /apt metrics collector/i, label: s.labels },
    title: `${s.u.name}: updates collector not answering`, detail: `${s.why} · its update counts read —`,
  });
  const pendingHosts = updates.filter(x => (x.pending ?? 0) > 0 || (x.security ?? 0) > 0 || x.reboot);
  if (pendingHosts.length) add({
    id: 'apt-updates', severity: 'info', rank: 92, source: 'Prometheus · apt',
    title: `System package updates on ${plural(pendingHosts.length, 'host')}`,
    detail: pendingHosts.map(x => `${x.name} ${x.pending ?? 0}${x.security ? ` (${x.security} security)` : ''}${x.reboot ? ', reboot' : ''}`).join(' · ') + (cfg.apt?.window ? ` · ${cfg.apt.window}` : ''),
  });
  if (!apt.length) absent('updates', 'Updates (apt)', 'the apt textfile collector (apt_collector_info)');

  // ================= edge: tunnels, Caddy, ntfy =================
  const edge: OpsLine[] = [];
  const e = fresh ? raw.edge : null;
  let mainTunnelDown = false, tunnel: OpsOut['tunnel'];
  const downTunnels = new Set<string>();
  const tunnelName = cfg.network?.tunnel ?? 'Tunnel', cfWhere = whereOf(cfg, /cloudflared/i);
  if (!e) absent('edge', 'Tunnels, Caddy, ntfy', 'cloudflared, Caddy and ntfy scrape jobs');
  else {
    for (const t of arr(e.tunnels)) {
      // the main tunnel carries the public endpoints (network.tunnel names it); others carry what names their job
      const main = t.main === true, name = main ? tunnelName : `${t.tunnel[0].toUpperCase()}${t.tunnel.slice(1)} tunnel`;
      const carried = arr(cfg.publicEndpoints).filter(x => x?.via === 'tunnel' && (main ? !x.tunnelJob : x.tunnelJob === t.job)).map(x => x.host);
      const conns = t.up === false ? null : t.conns;
      const tone: OpsTone = t.up === false ? 'warn' : conns == null ? 'none' : conns === 0 ? (main ? 'danger' : 'warn') : conns < 2 ? 'warn' : 'ok';
      edge.push({
        id: `tunnel-${slug(t.tunnel)}`, name, tone, value: t.up === false ? 'not answering' : conns == null ? '—' : `${conns}/${TUNNEL_FULL}`,
        sub: [main ? cfWhere : t.job, t.locations.length ? t.locations.join(', ') : conns === 0 ? 'no edge connection' : ''].filter(Boolean).join(' · '),
        ...(t.version ? { title: `cloudflared ${t.version} · ${t.job}` } : {}),
      });
      if (main) tunnel = { conns, status: conns == null ? 'unknown' : conns === 0 ? 'down' : conns < 2 ? 'degraded' : 'up', text: conns == null ? '—' : `${conns}/${TUNNEL_FULL}` };
      if (conns === 0 && main) mainTunnelDown = true;
      if (conns === 0 && !main) downTunnels.add(t.job);
      const src = `Prometheus · cloudflared${main && cfWhere ? ` (${cfWhere})` : main ? '' : ` (${t.job})`}`;
      if (conns === 0 && main && raw.network?.wanUp !== false) add({
        id: 'tunnel-main', severity: 'danger', rank: 4, source: src, dupe: { name: /cloudflared tunnel down|cloudflare tunnel/i },
        title: `${tunnelName} down: 0 connections`, detail: `cloudflared${cfWhere ? ` on ${cfWhere}` : ''} has no connection to Cloudflare · every public endpoint behind it is unreachable · the LAN still answers`,
      });
      else if (conns === 0) add({
        id: `tunnel-${slug(t.tunnel)}`, severity: 'warn', rank: 47, source: src, dupe: { name: /tunnel down/i, label: t.job },
        title: `${name} down: 0 connections`, detail: carried.length ? `${carried.join(', ')} unreachable from outside` : 'what it carries is unreachable from outside',
      });
      else if (fin(conns) && conns < 2) add({
        id: `tunnel-${slug(t.tunnel)}`, severity: 'warn', rank: 47, source: src, dupe: { name: /tunnel degraded/i, label: t.job },
        title: `${name} degraded: ${conns} of ${TUNNEL_FULL} connections`, detail: `one more drop and ${main ? 'every public endpoint' : 'what it carries'} goes down · cloudflared reconnects on its own`,
      });
    }
    const cd = e.caddy;
    if (cd) {
      edge.push({
        id: 'caddy', name: 'Caddy', tone: cd.up === false ? 'warn' : cd.reloadOk === false ? 'warn' : cd.reloadOk ? 'ok' : 'none',
        value: cd.up === false ? 'not answering' : cd.reloadOk === false ? 'reload failed' : cd.reloadOk ? 'config ok' : '—',
        sub: [[whereOf(cfg, /caddy/i), 'reverse proxy'].filter(Boolean).join(' · '), cd.reloadAt ? `last reload ${readClock(cd.reloadAt)}` : ''].filter(Boolean).join(' · '),
      });
      if (cd.up !== false && cd.reloadOk === false) add({ id: 'caddy-reload', severity: 'warn', rank: 52, source: 'Prometheus · Caddy', dupe: { name: /caddy config reload/i }, title: 'Caddy config reload failed', detail: `Caddy kept running its previous config · check the Caddyfile${whereOf(cfg, /caddy/i) ? ` on ${whereOf(cfg, /caddy/i)}` : ''} (caddy validate)` });
    }
    const nt = e.ntfy;
    if (nt) {
      const rej30 = nt.rejected30m ?? 0, bad = nt.up !== false && rej30 > 1.5;
      edge.push({
        id: 'ntfy', name: 'ntfy', tone: nt.up === false ? 'warn' : bad ? 'warn' : nt.up ? 'ok' : 'none',
        value: nt.up === false ? 'not answering' : bad ? `${rej30} rejected` : 'up',
        sub: [whereOf(cfg, /^ntfy/i), fin(nt.delivered24h) ? `${nt.delivered24h} sent` : '', fin(nt.rejected24h) ? `${nt.rejected24h} rejected` : ''].filter(Boolean).join(' · ') + (fin(nt.delivered24h) || fin(nt.rejected24h) ? ' in 24 h' : ''),
      });
      if (bad) add({ id: 'ntfy-rejected', severity: 'warn', rank: 51, source: 'Prometheus · ntfy', dupe: { name: /ntfy publish rejected/i }, title: `ntfy rejected ${plural(rej30, 'publish', 'publishes')} in 30 min`, detail: "a sender's token or topic is wrong · its pushes are lost (MAM watchdog, Kuma, scripts)" });
    }
  }

  const view: OpsView = {
    power, disks, edge: edge.length ? opsFirst(edge) : null, updates: updates.length ? opsFirst(updates) : null, missing,
  };
  return { view, items, claims, kpi, tunnel, mainTunnelDown, downTunnels, updatesBy };
}
