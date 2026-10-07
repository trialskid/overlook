// Prometheus · infrastructure (every 15 s): Unraid's node_exporter (up, memory, load, uptime, array and cache
// fill, per-disk fill, OS), cAdvisor container counts per Docker LXC, a LAN device count, SNMP state of
// the gateway and the switch (their snmp_exporter jobs from homelab.json), the spotlight app's readiness signals, and the health of
// every scrape target (so an exporter that stops answering is
// named, not just missing). A missing series is null (never a guessed 0); Prometheus not answering throws.
import { config } from '../config.ts';
import { isOne, many, orNull, rows, targets, toMs } from './prometheus.ts';
import { env, type Adapter } from './types.ts';
import type { Raw } from '../raw.ts';
import type { Status } from '../../shared/types.ts';

const TB = 1e12, GB = 1e9; // decimal units, as the disks are labelled (the array is 51 TB, i.e. 46.4 TiB)
const DISK = '/mnt/disk[0-9]+';
/** the best of the last 150 s: a bare selector gets the exact window, any other expression a 15 s subquery */
const SELECTOR = /^[A-Za-z_:][\w:]*(\{[^{}]*\})?$/;
export const recentQ = (q: string) => (SELECTOR.test(q.trim()) ? `max(max_over_time(${q.trim()}[150s]))` : `max_over_time((max(${q}))[150s:15s])`);

export const promInfra: Adapter = {
  name: 'prom-infra',
  label: 'Prometheus · infrastructure',
  every: 15_000,
  needs: 'PROMETHEUS_URL in .env',
  configured: () => !!env('PROMETHEUS_URL'),
  async run() {
    const un = config.hosts.find(h => h.type === 'unraid');
    const nj = `job="${un?.nodeJob ?? 'node-unraid'}"`;
    const gw = config.network?.gateway, sw = config.network?.switch;
    const gwJob = gw?.snmpJob ? `job="${gw.snmpJob}"` : null, swJob = sw?.snmpJob ? `job="${sw.snmpJob}"` : null;
    const segs = (config.network?.segments ?? []).filter(x => x.gatewayIf && gwJob);
    const count = config.network?.deviceCount?.query;
    const spot = (config.spotlight?.signals ?? []).filter(x => x?.name && x.query);
    const [v, r, tg] = await Promise.all([
      many({
        up: `up{${nj}}`,
        memTotal: `node_memory_MemTotal_bytes{${nj}}`, memAvail: `node_memory_MemAvailable_bytes{${nj}}`,
        swapTotal: `node_memory_SwapTotal_bytes{${nj}}`, swapFree: `node_memory_SwapFree_bytes{${nj}}`,
        load1: `node_load1{${nj}}`, boot: `node_boot_time_seconds{${nj}}`,
        arraySize: `sum(node_filesystem_size_bytes{${nj},mountpoint=~"${DISK}"})`, arrayAvail: `sum(node_filesystem_avail_bytes{${nj},mountpoint=~"${DISK}"})`,
        cacheSize: `sum(node_filesystem_size_bytes{${nj},mountpoint="/mnt/cache"})`, cacheAvail: `sum(node_filesystem_avail_bytes{${nj},mountpoint="/mnt/cache"})`,
        // a LAN device count (network.deviceCount, e.g. ntopng's); its exporter drops the series when it is down
        ...(count ? { lan: count } : {}),
        ...(gwJob ? { gwUp: `max(up{${gwJob}})` } : {}), ...(swJob ? { switchUp: `max(up{${swJob}})` } : {}),
        ...(gwJob && gw?.wanIf ? { wan: `max(ifOperStatus{${gwJob},ifName="${gw.wanIf}"})` } : {}), // 1 up, 2 down, 7 lowerLayerDown …
        ...Object.fromEntries(segs.map(x => [`seg:${x.id}`, `max(ifOperStatus{${gwJob},ifName="${x.gatewayIf}"})`])),
        // the spotlight app's signals: now, and the best of the last 150 s (a lone failed probe is a blip)
        ...Object.fromEntries(spot.flatMap((x, i) => [[`sp${i}`, `max(${x.query})`], [`sp${i}r`, recentQ(x.query)]])),
        ...(config.spotlight?.probeQuery ? { spProbe: `max(${config.spotlight.probeQuery})` } : {}),
        ...(config.spotlight?.recoveriesQuery ? { spRec: `max(${config.spotlight.recoveriesQuery})` } : {}),
      }),
      rows({
        // containers seen in the last minute per cAdvisor job; a cAdvisor that is up with none running reads 0
        ctr: 'count by (job) (time() - container_last_seen{name!="",job=~"cadvisor-.*"} < 60) or sum by (job) (up{job=~"cadvisor-.*"} == 1) * 0',
        size: `node_filesystem_size_bytes{${nj},mountpoint=~"${DISK}"}`, avail: `node_filesystem_avail_bytes{${nj},mountpoint=~"${DISK}"}`,
        os: `node_os_info{${nj}}`, uname: `node_uname_info{${nj}}`,
        ...(swJob ? { ports: `ifOperStatus{${swJob}}` } : {}),
      }),
      targets().catch(e => { console.warn(`[prom-infra] targets: ${(e as Error).message}`); return null; }),
    ]);
    const out: Partial<Raw> = { promTargets: tg };

    // ---- Unraid
    if (un) {
      const status: Status = v.up === 1 ? 'up' : v.up === 0 ? 'down' : 'unknown';
      out.hostStatus = { [un.id]: status };
      out.hostRes = {
        [un.id]: {
          cpuPct: null, // live.ts samples CPU every second
          memTotal: orNull(v.memTotal), memUsed: v.memTotal !== undefined && v.memAvail !== undefined ? v.memTotal - v.memAvail : null,
          swapTotal: orNull(v.swapTotal), swapUsed: v.swapTotal !== undefined && v.swapFree !== undefined ? v.swapTotal - v.swapFree : null,
          diskUsed: null, diskTotal: null, // the array is in `unraid`; the root fs is RAM
          load1: orNull(v.load1), uptimeSec: v.boot !== undefined ? Math.max(0, Math.round(Date.now() / 1000 - v.boot)) : null,
        },
      };
      const ver = r.os?.[0]?.m.version_id ?? null, kernel = r.uname?.[0]?.m.release?.replace(/-Unraid$/i, '') ?? null;
      out.versions = ver ? { Unraid: ver } : {};
      const { arraySize: as, arrayAvail: aa, cacheSize: cs, cacheAvail: ca } = v;
      out.unraid = as !== undefined && aa !== undefined && cs !== undefined && ca !== undefined ? {
        arrayTB: as / TB, arrayUsedTB: (as - aa) / TB, cacheGB: cs / GB, cacheUsedGB: (cs - ca) / GB,
        os: ver ? `Unraid ${ver}${kernel ? ` · kernel ${kernel}` : ''}` : null,
      } : null;
      const avail = new Map((r.avail ?? []).map(x => [x.m.mountpoint, x.v]));
      const disks = (r.size ?? []).filter(x => avail.has(x.m.mountpoint)).map(x => ({
        disk: x.m.mountpoint.replace('/mnt/', ''), totalTB: x.v / TB, usedTB: (x.v - avail.get(x.m.mountpoint)!) / TB,
      }));
      out.unraidDisks = disks.length ? disks.sort((a, b) => Number(a.disk.slice(4)) - Number(b.disk.slice(4))) : null;
    }

    // ---- containers per Docker LXC: job → vmid from homelab.json, else the digits in the job name
    const containers: Record<number, number> = {};
    for (const x of r.ctr ?? []) {
      const vmid = config.guests.find(g => g.cadvisor === x.m.job)?.vmid ?? Number(x.m.job?.match(/cadvisor-(\d+)/)?.[1]);
      if (vmid) containers[vmid] = x.v;
    }
    out.containers = containers;
    out.lanDevices = orNull(v.lan);

    // ---- network
    const ports: Record<string, boolean> = {};
    for (const x of r.ports ?? []) ports[x.m.ifName] = x.v === 1;
    out.network = {
      gwUp: isOne(v.gwUp), switchUp: isOne(v.switchUp), ports, wanUp: isOne(v.wan),
      segments: Object.fromEntries(segs.map(x => [x.id, isOne(v[`seg:${x.id}`])])),
    };

    // ---- the spotlight app's readiness probe
    const sig = Object.fromEntries(spot.map((x, i) => [x.name, { now: orNull(v[`sp${i}`]), recent: orNull(v[`sp${i}r`]) }]));
    out.spotlight = spot.length || v.spProbe !== undefined ? { signals: sig, probeAt: toMs(v.spProbe), recoveries: orNull(v.spRec) } : null;
    return out;
  },
};
