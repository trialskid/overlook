// Prometheus · power, disks, edge (every 30 s): modules ups, unraid, apt and edge. A module whose series don't exist
// yet keeps its Raw key null ('not monitored yet' on the page, never an error and never a made-up value). Timestamps
// become epoch ms; a missing series is null. The metrics (docs/INTEGRATIONS.md):
//   ups     apcupsd_* (an apcupsd textfile collector; apcupsd_exporter covers the basics)
//   unraid  unraid_* (the Unraid health collector: array, parity, disks, SMART)
//   apt     apt_* on targets that also export apt_collector_info
//   edge    cloudflared, Caddy and ntfy scrape jobs (job names from homelab.json prometheus.jobs)
// Any query can be replaced by its key (homelab.json prometheus.queries). Prometheus not answering throws (the source
// goes stale and every area reads 'not answering').
import { many, rows, type Row } from './prometheus.ts';
import { env, type Adapter } from './types.ts';
import { config } from '../config.ts';
import { jobOf } from '../derive/util.ts';
import type { HomelabConfig } from '../../shared/types.ts';
import type { AptRaw, EdgeRaw, Raw, UnraidDiskRaw } from '../raw.ts';

/** Scrape-job selectors from homelab.json prometheus.jobs (cloudflared is a regex: one job per tunnel). */
const sel = (cfg: HomelabConfig) => {
  const NTFY = `job="${jobOf(cfg, 'ntfy', 'ntfy')}"`, CADDY = `job="${jobOf(cfg, 'caddy', 'caddy')}"`, CF = `job=~"${jobOf(cfg, 'cloudflared', 'cloudflared.*')}"`;
  return { NTFY, CADDY, CF, NTFY_REJ: `${NTFY},http_method=~"POST|PUT",http_code=~"4..|5.."` };
};

/** Scalars, aggregated so each is one value (undefined = no series). Two batches keep the URL short. */
export const opsScalars = (cfg: HomelabConfig): Record<string, string>[] => { const { NTFY, CADDY, NTFY_REJ } = sel(cfg); return [{
  // H5 · UPS
  upsUp: 'max(apcupsd_up)', upsFresh: 'min(apcupsd_data_fresh)', upsAge: 'max(apcupsd_data_age_seconds)',
  upsCharge: 'max(apcupsd_battery_charge_percent)', upsLeft: 'max(apcupsd_battery_time_left_seconds)',
  upsLeftAvg: 'max(avg_over_time(apcupsd_battery_time_left_seconds[5m]))',
  upsLoad: 'max(apcupsd_ups_load_percent)', upsLine: 'max(apcupsd_line_volts)', upsOnBatt: 'max(apcupsd_battery_time_on_seconds)',
  upsNomW: 'max(apcupsd_nominal_power_watts)', upsNomV: 'max(apcupsd_line_nominal_volts)',
  upsXferLo: 'max(apcupsd_transfer_low_volts)', upsXferHi: 'max(apcupsd_transfer_high_volts)', upsShutCharge: 'max(apcupsd_shutdown_battery_charge_percent)',
  upsShutLeft: 'max(apcupsd_shutdown_time_left_seconds)', upsShutOnBatt: 'max(apcupsd_shutdown_time_on_battery_seconds)',
  upsTransfers: 'max(apcupsd_battery_transfers_total)', upsLastOn: 'max(apcupsd_last_transfer_on_battery_timestamp_seconds)',
  upsLastOff: 'max(apcupsd_last_transfer_off_battery_timestamp_seconds)', upsStart: 'max(apcupsd_daemon_start_timestamp_seconds)',
  upsCollOk: 'min(apcupsd_collector_success)', upsCollRun: 'max(apcupsd_collector_last_run_timestamp_seconds)',
  upsCollOkAt: 'max(apcupsd_collector_last_success_timestamp_seconds)',
  // H6 · Unraid array and parity
  urOk: 'min(unraid_array_collector_success)', urRun: 'max(unraid_array_collector_last_run_timestamp_seconds)',
  urStarted: 'max(unraid_array_started)', urMaint: 'max(unraid_array_maintenance_mode)', urMounted: 'max(unraid_array_filesystems_mounted)',
  urUnmountable: 'max(unraid_array_filesystems_unmountable)', urMover: 'max(unraid_mover_running)',
  parRunning: 'max(unraid_parity_running)', parPaused: 'max(unraid_parity_paused)', parProgress: 'max(unraid_parity_progress_ratio)',
  parSpeed: 'max(unraid_parity_speed_bytes_per_second)', parLastStart: 'max(unraid_parity_last_start_timestamp_seconds)',
  parLastEnd: 'max(unraid_parity_last_end_timestamp_seconds)', parLastDur: 'max(unraid_parity_last_duration_seconds)',
  parLastErr: 'max(unraid_parity_last_errors)', parLastExit: 'min(unraid_parity_last_exit)',
}, {
  // edge · ntfy and Caddy scrape jobs (rejected = POST/PUT 4xx/5xx plus publish failures, as Grafana's 'ntfy Publish Rejected')
  ntfyUp: `max(up{${NTFY}})`, ntfyOk24: `sum(increase(ntfy_messages_published_success{${NTFY}}[24h]))`,
  ntfyRejHttp24: `sum(increase(ntfy_http_requests_total{${NTFY_REJ}}[24h]))`, ntfyRejFail24: `sum(increase(ntfy_messages_published_failure{${NTFY}}[24h]))`,
  ntfyRejHttp30: `sum(increase(ntfy_http_requests_total{${NTFY_REJ}}[30m]))`, ntfyRejFail30: `sum(increase(ntfy_messages_published_failure{${NTFY}}[30m]))`,
  caddyUp: `max(up{${CADDY}})`, caddyReload: `min(caddy_config_last_reload_successful{${CADDY}})`,
  caddyReloadAt: `max(caddy_config_last_reload_success_timestamp_seconds{${CADDY}})`,
}]; };

const BY_T = '(job, instance, host)';
/** Labelled series. */
export const opsRows = (cfg: HomelabConfig): Record<string, string>[] => { const { CF } = sel(cfg); return [{
  upsInfo: 'apcupsd_ups_info', upsStatus: 'apcupsd_status_info', upsFlag: 'apcupsd_status_flag', upsTransfer: 'apcupsd_last_transfer_info',
  urState: 'unraid_array_state == 1', parAction: 'unraid_parity_correcting',
  dStatus: 'unraid_disk_status == 1', dOk: 'unraid_disk_ok', dTemp: 'unraid_disk_temp_celsius', dErr: 'unraid_disk_errors', dSpun: 'unraid_disk_spundown',
  dFs: 'unraid_disk_fs_mounted', dFail: 'unraid_disk_smart_failing_attributes', dPast: 'unraid_disk_smart_failed_in_past_attributes',
  dRealloc: 'unraid_disk_smart_reallocated', dPend: 'unraid_disk_smart_pending', dOffl: 'unraid_disk_smart_offline_uncorrectable',
  dCrc: 'unraid_disk_smart_crc', dUnc: 'unraid_disk_smart_reported_uncorrect', dPoh: 'unraid_disk_smart_power_on_hours',
  // Grafana's 'Disk Errors or SMART Warning': reallocated / 187 / CRC higher than 7 days ago (nothing until 7 days exist)
  dGrowR: 'unraid_disk_smart_reallocated - unraid_disk_smart_reallocated offset 7d',
  dGrowU: 'unraid_disk_smart_reported_uncorrect - unraid_disk_smart_reported_uncorrect offset 7d',
  dGrowC: 'unraid_disk_smart_crc - unraid_disk_smart_crc offset 7d',
}, {
  aptInfo: 'apt_collector_info', aptPending: `sum by ${BY_T} (apt_upgrades_pending)`, aptHeld: `sum by ${BY_T} (apt_upgrades_held)`,
  aptSec: 'apt_security_upgrades_pending', aptSecSince: 'apt_security_pending_since_timestamp_seconds', aptReboot: 'apt_reboot_required',
  aptRebootSince: 'apt_reboot_required_since_timestamp_seconds', aptKernel: 'apt_kernel_info', aptOk: 'apt_collector_success',
  aptRun: 'apt_collector_last_run_timestamp_seconds', aptCache: 'apt_package_cache_timestamp_seconds',
  tunUp: `up{${CF}}`, tunConns: `max by (job, tunnel) (cloudflared_tunnel_ha_connections{${CF}})`,
  tunLoc: `cloudflared_tunnel_server_locations{${CF}} == 1`, tunBuild: `build_info{${CF}}`,
}]; };

const n = (v: number | undefined) => (v === undefined ? null : v);
const b = (v: number | undefined) => (v === undefined ? null : v === 1);
const ms = (sec: number | undefined) => (sec === undefined || sec <= 0 ? null : Math.round(sec * 1000));
const cnt = (v: number | undefined) => (v === undefined ? null : Math.max(0, Math.round(v)));
const any = (...xs: unknown[]) => xs.some(x => x !== undefined);

/** Pure: Prometheus answers → this adapter's slice. Exported for the tests (no network). */
export function opsFromProm(v: Record<string, number | undefined>, r: Record<string, Row[] | undefined>, cfg: Pick<HomelabConfig, 'edge'> = config): Partial<Raw> {
  const out: Partial<Raw> = { ups: null, unraidHealth: null, apt: null, edge: null };

  // ---- ups
  if (any(v.upsUp, v.upsCollRun, v.upsCollOk)) {
    const flags: Record<string, boolean> = {};
    for (const x of r.upsFlag ?? []) if (x.m.flag) flags[x.m.flag] = x.v === 1;
    const info = r.upsInfo?.[0]?.m;
    out.ups = {
      up: b(v.upsUp), dataFresh: b(v.upsFresh), dataAgeSec: n(v.upsAge), model: info?.model || null, upsName: info?.ups_name || null, master: info?.master || null,
      nominalV: n(v.upsNomV), transferLowV: n(v.upsXferLo), transferHighV: n(v.upsXferHi),
      status: r.upsStatus?.find(x => x.v === 1)?.m.status ?? null, flags,
      chargePct: n(v.upsCharge), timeLeftSec: n(v.upsLeft), timeLeftAvgSec: n(v.upsLeftAvg), loadPct: n(v.upsLoad), lineV: n(v.upsLine), onBatterySec: n(v.upsOnBatt),
      nominalW: n(v.upsNomW), shutdownChargePct: n(v.upsShutCharge), shutdownTimeLeftSec: n(v.upsShutLeft), shutdownOnBatterySec: n(v.upsShutOnBatt),
      transfers: cnt(v.upsTransfers), lastOnBatteryAt: ms(v.upsLastOn), lastOffBatteryAt: ms(v.upsLastOff),
      lastTransferReason: r.upsTransfer?.[0]?.m.reason || null, daemonStartAt: ms(v.upsStart),
      collectorOk: b(v.upsCollOk), collectorRunAt: ms(v.upsCollRun), collectorOkAt: ms(v.upsCollOkAt),
    };
  }

  // ---- unraid: array, parity, disks
  if (any(v.urOk, v.urRun, v.urStarted) || (r.dStatus?.length ?? 0) > 0) {
    const byDisk = (k: string) => new Map((r[k] ?? []).filter(x => x.m.disk).map(x => [x.m.disk, x]));
    const maps = Object.fromEntries(['dOk', 'dTemp', 'dErr', 'dSpun', 'dFs', 'dFail', 'dPast', 'dRealloc', 'dPend', 'dOffl', 'dCrc', 'dUnc', 'dPoh', 'dGrowR', 'dGrowU', 'dGrowC'].map(k => [k, byDisk(k)]));
    const names = new Map<string, string>(); // disk → type, in the collector's order
    for (const k of ['dStatus', 'dOk', 'dTemp']) for (const x of r[k] ?? []) if (x.m.disk && !names.has(x.m.disk)) names.set(x.m.disk, x.m.type || '');
    const val = (k: string, d: string) => maps[k].get(d)?.v;
    const status = new Map((r.dStatus ?? []).filter(x => x.m.disk).map(x => [x.m.disk, x.m.status || null]));
    const disks: UnraidDiskRaw[] = [...names].map(([disk, type]) => {
      const grows = ['dGrowR', 'dGrowU', 'dGrowC'].map(k => val(k, disk)).filter((x): x is number => x !== undefined);
      return {
        disk, type, status: status.get(disk) ?? null, ok: b(val('dOk', disk)), tempC: n(val('dTemp', disk)), errors: cnt(val('dErr', disk)),
        spundown: b(val('dSpun', disk)), fsMounted: b(val('dFs', disk)), failingNow: cnt(val('dFail', disk)), failedPast: cnt(val('dPast', disk)),
        reallocated: cnt(val('dRealloc', disk)), pending: cnt(val('dPend', disk)), offlineUncorrectable: cnt(val('dOffl', disk)), crc: cnt(val('dCrc', disk)),
        reportedUncorrect: cnt(val('dUnc', disk)), grown: grows.length ? Math.max(0, ...grows) : null, powerOnHours: n(val('dPoh', disk)),
      };
    });
    out.unraidHealth = {
      collectorOk: b(v.urOk), collectorRunAt: ms(v.urRun), started: b(v.urStarted), state: r.urState?.[0]?.m.state ?? null, maintenance: b(v.urMaint),
      mounted: cnt(v.urMounted), unmountable: cnt(v.urUnmountable), mover: b(v.urMover),
      parity: {
        running: b(v.parRunning), paused: b(v.parPaused), progress: n(v.parProgress), speedBps: n(v.parSpeed), action: r.parAction?.[0]?.m.action ?? null,
        lastStartAt: ms(v.parLastStart), lastEndAt: ms(v.parLastEnd), lastDurationSec: n(v.parLastDur), lastErrors: cnt(v.parLastErr),
        lastExit: v.parLastExit === undefined ? null : Math.round(v.parLastExit),
      },
      disks,
    };
  }


  // ---- apt, one entry per target that runs the collector
  const key = (m: Record<string, string>) => `${m.job ?? ''}|${m.instance ?? ''}`;
  const at = (k: string) => new Map((r[k] ?? []).map(x => [key(x.m), x]));
  const A = Object.fromEntries(['aptPending', 'aptHeld', 'aptSec', 'aptSecSince', 'aptReboot', 'aptRebootSince', 'aptKernel', 'aptOk', 'aptRun', 'aptCache'].map(k => [k, at(k)]));
  const apt: AptRaw[] = [], seen = new Set<string>();
  for (const x of r.aptInfo ?? []) {
    const k = key(x.m);
    if (seen.has(k)) continue;
    seen.add(k);
    const g = (f: string) => A[f].get(k)?.v, kern = A.aptKernel.get(k)?.m;
    apt.push({
      job: x.m.job ?? '', instance: x.m.instance ?? '', host: x.m.host ?? null,
      pending: cnt(g('aptPending')), held: cnt(g('aptHeld')), security: cnt(g('aptSec')), securitySince: ms(g('aptSecSince')),
      reboot: b(g('aptReboot')), rebootSince: ms(g('aptRebootSince')), kernel: kern?.running ? { running: kern.running, expected: kern.expected ?? kern.running } : null,
      collectorOk: b(g('aptOk')), collectorRunAt: ms(g('aptRun')), cacheAt: ms(g('aptCache')),
    });
  }
  out.apt = apt.length ? apt : null;


  // ---- edge: tunnels, ntfy, Caddy
  const tunnels: EdgeRaw['tunnels'] = [];
  const tunnelOf = (m: Record<string, string>) => m.tunnel || m.job || 'tunnel';
  const jobs = new Set([...(r.tunUp ?? []), ...(r.tunConns ?? [])].map(x => x.m.job).filter(Boolean));
  for (const job of jobs) {
    const up = r.tunUp?.find(x => x.m.job === job), c = r.tunConns?.find(x => x.m.job === job);
    tunnels.push({
      job, tunnel: tunnelOf((up ?? c)!.m), main: false, up: up ? up.v === 1 : null, conns: c ? Math.round(c.v) : null,
      locations: [...new Set((r.tunLoc ?? []).filter(x => x.m.job === job).map(x => x.m.edge_location).filter(Boolean))].sort(),
      version: r.tunBuild?.find(x => x.m.job === job)?.m.version ?? null,
    });
  }
  // the main tunnel (homelab.json edge.mainTunnelJob, else the first by job name) carries the public endpoints; it leads
  tunnels.sort((a, b2) => a.job.localeCompare(b2.job));
  const mainJob = cfg.edge?.mainTunnelJob && tunnels.some(t => t.job === cfg.edge!.mainTunnelJob) ? cfg.edge.mainTunnelJob : tunnels[0]?.job;
  for (const t of tunnels) t.main = t.job === mainJob;
  tunnels.sort((a, b2) => Number(b2.main) - Number(a.main));
  const sumOf = (a: number | undefined, c: number | undefined) => (a === undefined && c === undefined ? null : Math.max(0, Math.round((a ?? 0) + (c ?? 0))));
  const ntfy = v.ntfyUp === undefined ? null : {
    up: b(v.ntfyUp), delivered24h: cnt(v.ntfyOk24),
    // no 4xx/5xx series at all while ntfy itself is scraped means none happened
    rejected24h: sumOf(v.ntfyRejHttp24, v.ntfyRejFail24) ?? (v.ntfyUp === 1 ? 0 : null),
    rejected30m: sumOf(v.ntfyRejHttp30, v.ntfyRejFail30) ?? (v.ntfyUp === 1 ? 0 : null),
  };
  const caddy = v.caddyUp === undefined ? null : { up: b(v.caddyUp), reloadOk: b(v.caddyReload), reloadAt: ms(v.caddyReloadAt) };
  out.edge = tunnels.length || ntfy || caddy ? { tunnels, ntfy, caddy } : null;
  return out;
}

export const promOps: Adapter = {
  name: 'prom-ops',
  label: 'Prometheus · power, disks, edge',
  every: 30_000,
  needs: 'PROMETHEUS_URL in .env',
  configured: () => !!env('PROMETHEUS_URL'),
  async run() {
    // homelab.json prometheus.queries replaces any query by its key (e.g. a UPS read from another exporter)
    const over = (qs: Record<string, string>) => Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, config.prometheus?.queries?.[k] ?? q]));
    const S = opsScalars(config).map(over), R = opsRows(config).map(over);
    const [v1, v2, r1, r2] = await Promise.all([many(S[0]), many(S[1]), rows(R[0]), rows(R[1])]);
    return opsFromProm({ ...v1, ...v2 }, { ...r1, ...r2 }, config);
  },
};
