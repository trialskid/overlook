// Proxmox VE API (every host of type proxmox with `api` and `pveNode`) with read-only PVEAuditor tokens. GET only.
// Every 15 s: node status (host resources, versions) and the live guest list with resources.
// Slower and cached, never fatal: VM memory (60 s) and VM disks through the guest agent (5 min), the
// guest storage pool (60 s), and the nightly vzdump result (5 min). A cached value outlives a failed refresh by
// 90 s at most (the adapter's own max age), a VM reboot drops its cached memory and disks, and a node that
// didn't answer this poll contributes no storage pool or vzdump row. A node that fails 3 polls in a row
// is 'down', fewer is 'unknown'; its last-known guests stay listed as 'unknown' rather than vanishing.
import { getJSON } from '../http.ts';
import { config } from '../config.ts';
import { env, trimUrl, type Adapter } from './types.ts';
import type { GuestRaw, JobRaw, Raw, ResRaw } from '../raw.ts';
import type { HostConfig, Status } from '../../shared/types.ts';

/** The host's env prefix: its `tokenEnv`, else PVE_<ID> ('pve-1' → PVE_PVE_1); its token is <prefix>_TOKEN_ID / _SECRET. */
export const tokenPrefix = (h: HostConfig) => h.tokenEnv?.trim() || `PVE_${h.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
const pre = tokenPrefix;
export const pveHosts = () => config.hosts.filter(h => h.type === 'proxmox' && h.api && h.pveNode && env(`${pre(h)}_TOKEN_ID`));

/** Any API path on the host, e.g. '/cluster/backup'. */
export function pveApi<T = any>(h: HostConfig, path: string, timeout = 6000): Promise<T> {
  return getJSON<{ data: T }>(`${trimUrl(h.api!)}/api2/json${path}`, {
    headers: { Authorization: `PVEAPIToken=${env(`${pre(h)}_TOKEN_ID`)}=${env(`${pre(h)}_TOKEN_SECRET`)}` }, insecure: true, timeout,
  }).then(r => r.data);
}
export const pveGet = <T = any>(h: HostConfig, path: string, timeout = 6000) => pveApi<T>(h, `/nodes/${h.pveNode}${path}`, timeout);

const MIN = 60e3, DAY = 86400e3;
const num = (v: unknown) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
/** one line for the log; http.ts keeps headers (the token) out of its errors */
const why = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0].slice(0, 160);
const warned = new Map<string, string>();
const warn = (key: string, e: unknown) => { const m = why(e); if (warned.get(key) !== m) console.warn(`[proxmox] ${key}: ${m}`); warned.set(key, m); };
const quiet = (key: string) => warned.delete(key);

/** after a failed refresh, the last good value is shown this long at most (= the adapter's max age) */
const FAIL_KEEP = 90e3;
/** A value refreshed at most every `every` ms and dropped once older than `keep`, or FAIL_KEEP after a failed
 *  refresh (it is retried a minute later at most). clear() forgets it (a VM reboot). */
class Slow<T> {
  private v: T | undefined; private at = 0; private failedAt = 0; private tried = 0; private busy: Promise<void> | null = null;
  constructor(private key: string, private every: number, private keep: number) {}
  refresh(load: () => Promise<T>): Promise<void> {
    if (this.busy || Date.now() - this.tried < (this.failedAt ? Math.min(this.every, MIN) : this.every)) return this.busy ?? Promise.resolve();
    this.tried = Date.now();
    return this.busy = load().then(
      v => { this.v = v; this.at = Date.now(); this.failedAt = 0; quiet(this.key); },
      e => { this.failedAt ||= Date.now(); warn(this.key, e); },
    ).finally(() => { this.busy = null; });
  }
  get(): T | undefined {
    const now = Date.now();
    return this.v !== undefined && now - this.at <= this.keep && !(this.failedAt && now - this.failedAt > FAIL_KEEP) ? this.v : undefined;
  }
  clear() { this.v = undefined; this.at = 0; this.failedAt = 0; this.tried = 0; }
}
const slows = new Map<string, Slow<any>>();
const slow = <T>(key: string, every: number, keep: number): Slow<T> => {
  let s = slows.get(key);
  if (!s) slows.set(key, s = new Slow<T>(key, every, keep));
  return s;
};
/** Waits for the slow refreshes, but never holds the 15 s poll for longer than `ms` (late ones land next poll). */
const within = (ms: number, ps: Promise<unknown>[]) => Promise.race([Promise.allSettled(ps), new Promise(r => setTimeout(r, ms).unref())]);

// ---- per node: consecutive failures and the last guest list it answered with
const fails = new Map<string, number>();
const lastGuests = new Map<string, Record<string, GuestRaw>>();

const gStatus = (s: string): Status => (s === 'running' ? 'up' : s === 'stopped' ? 'down' : 'unknown');
const pct = (v: unknown) => (num(v) == null ? null : Number(v) * 100);
const unknownGuest = (g: GuestRaw): GuestRaw => ({ ...g, status: 'unknown', cpuPct: null, memUsed: null, diskUsed: null, swapUsed: null, uptimeSec: null });

function lxcGuest(h: HostConfig, g: any): GuestRaw {
  const on = g.status === 'running';
  return {
    host: h.id, vmid: Number(g.vmid), name: g.name ?? `CT ${g.vmid}`, kind: 'lxc', status: gStatus(g.status), template: Number(g.template) === 1,
    cpuPct: on ? pct(g.cpu) : null, memUsed: on ? num(g.mem) : null, memTotal: num(g.maxmem) || null,
    diskUsed: on ? num(g.disk) : null, diskTotal: num(g.maxdisk) || null, swapUsed: on ? num(g.swap) : null, swapTotal: num(g.maxswap),
    uptimeSec: on ? num(g.uptime) : null,
  };
}

type VmCur = { mem: number | null; agent: boolean };
type Fs = { used: number; total: number } | null;
/** guest agent filesystems with a real disk behind them (not zram, tmpfs or HAOS's read-only erofs root), each device once */
function fsSum(r: any): Fs {
  const seen = new Set<string>(); let used = 0, total = 0;
  for (const f of (Array.isArray(r) ? r : r?.result) ?? []) {
    if (!f?.disk?.length || /^(erofs|squashfs|iso9660|tmpfs|devtmpfs|overlay)$/.test(f.type) || !(f['total-bytes'] > 0) || seen.has(f.name)) continue;
    seen.add(f.name); used += Number(f['used-bytes']) || 0; total += Number(f['total-bytes']);
  }
  return total ? { used, total } : null;
}

function vmGuest(h: HostConfig, g: any): GuestRaw {
  const on = g.status === 'running', key = `${h.id}:${g.vmid}`;
  // /qemu's `mem` is the host's view (guest page cache included); ballooninfo is the guest's own total - free
  const cur = slow<VmCur>(`${key} status`, MIN, 5 * MIN).get(), fs = slow<Fs>(`${key} fsinfo`, 5 * MIN, 15 * MIN).get();
  return {
    host: h.id, vmid: Number(g.vmid), name: g.name ?? `VM ${g.vmid}`, kind: 'vm', status: gStatus(g.status), template: Number(g.template) === 1,
    cpuPct: on ? pct(g.cpu) : null, memUsed: on ? cur?.mem ?? null : null, memTotal: num(g.maxmem) || null,
    diskUsed: on ? fs?.used ?? null : null, diskTotal: fs?.total ?? (num(g.maxdisk) || null), swapUsed: null, swapTotal: null,
    uptimeSec: on ? num(g.uptime) : null,
  };
}

/** uptime per VM at the last poll: a smaller one means it rebooted, so its cached memory and disks are dropped */
const uptimes = new Map<string, number>();
/** Starts the slow per-VM refreshes that are due (running VMs only; the agent only when it's enabled). */
function vmRefreshes(h: HostConfig, qemu: any[]): Promise<void>[] {
  return qemu.filter(g => g.status === 'running' && Number(g.template) !== 1).flatMap(g => {
    const key = `${h.id}:${g.vmid}`, cur = slow<VmCur>(`${key} status`, MIN, 5 * MIN);
    const up = num(g.uptime), was = uptimes.get(key);
    if (up != null) { if (was != null && up < was) { cur.clear(); slow<Fs>(`${key} fsinfo`, 5 * MIN, 15 * MIN).clear(); } uptimes.set(key, up); }
    const out = [cur.refresh(() => pveGet<any>(h, `/qemu/${g.vmid}/status/current`, 5000).then(s => {
      const b = s.ballooninfo, t = num(b?.total_mem), f = num(b?.free_mem);
      return { mem: t != null && f != null && t > 0 ? t - f : null, agent: Number(s.agent) === 1 };
    }))];
    if (cur.get()?.agent) out.push(slow<Fs>(`${key} fsinfo`, 5 * MIN, 15 * MIN).refresh(() => pveGet<any>(h, `/qemu/${g.vmid}/agent/get-fsinfo`, 8000).then(fsSum)));
    return out;
  });
}

// ---- storage: content-filtered, because PVE activates and stats every storage that matches before filtering by
// id, and a backup storage can be a hard NFS mount (a slow NAS must never make the node look down)
type Pool = { storage: string; used: number; total: number };
const poolOf = (h: HostConfig) => slow<Pool | null>(`${h.id} storage`, MIN, 5 * MIN);
const loadPool = (h: HostConfig) => pveGet<any[]>(h, '/storage?content=images,rootdir', 5000).then(list => {
  const p = list.filter(s => s.active && s.enabled !== 0 && s.total).sort((a, b) => b.total - a.total)[0];
  return p ? { storage: String(p.storage), used: Number(p.used), total: Number(p.total) } : null;
});

// ---- vzdump: the node's backup job (from /cluster/backup), its runs in the task list, and the newest run's log
const isOk = (s: string) => s === 'OK' || /^WARNINGS/.test(s);
const vzOf = (h: HostConfig) => slow<JobRaw>(`${h.id} vzdump`, 5 * MIN, 15 * MIN);
const logs = new Map<string, { upid: string; detail: string }>();
const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

type Listed = { vmid: number; template: boolean };
async function loadVzdump(h: HostConfig, guests: Listed[], cfgSchedule: string): Promise<JobRaw> {
  const [tasks, jobs, missing] = await Promise.all([
    pveGet<any[]>(h, '/tasks?typefilter=vzdump&limit=50'),
    pveApi<any[]>(h, '/cluster/backup').catch(() => [] as any[]),
    pveApi<any[]>(h, '/cluster/backup-info/not-backed-up').catch(() => [] as any[]),
  ]);
  const job = jobs.find(j => j.type === 'vzdump' && Number(j.enabled ?? 1) !== 0 && (!j.node || j.node === h.pveNode));
  const live = guests.filter(g => !g.template).map(g => g.vmid);
  const excl = new Set(String(job?.exclude ?? '').split(/[,\s]+/).filter(Boolean).map(Number));
  const want: number[] | null = !job ? null : Number(job.all) === 1 ? live.filter(v => !excl.has(v)) : job.vmid ? String(job.vmid).split(/[,\s]+/).filter(Boolean).map(Number) : null;
  // a run of a multi-guest job has an empty task id; manual one-guest backups (and recovery copies) carry the vmid
  const runs = tasks.filter(t => !want || (t.id ?? '') === (want.length === 1 ? String(want[0]) : '')).sort((a, b) => b.starttime - a.starttime);
  const done = runs.filter(t => t.endtime && t.status);
  const newest = done[0], lastOk = done.find(t => isOk(t.status));

  let detail = newest ? '' : 'no run in the task list';
  if (newest) {
    const cached = logs.get(h.id);
    if (cached && cached.upid === newest.upid) detail = cached.detail;
    else {
      const mins = Math.max(1, Math.round((newest.endtime - newest.starttime) / 60));
      try {
        const log = await pveGet<{ t: string }[]>(h, `/tasks/${encodeURIComponent(newest.upid)}/log?limit=2000`);
        const ids = (re: RegExp) => new Set(log.flatMap(l => [...(l.t ?? '').matchAll(re)].map(m => Number(m[1]))));
        const fin = ids(/Finished Backup of VM (\d+)/g), bad = [...ids(/ERROR: Backup of VM (\d+) failed/g)];
        const of = want ?? [...ids(/Starting Backup of VM (\d+)/g)];
        detail = [`${of.filter(v => fin.has(v)).length}/${plural(of.length, 'guest')}`, `${mins} min`,
          bad.length ? `VM ${bad.join(', ')} failed` : !isOk(newest.status) ? newest.status : '',
          /^WARNINGS/.test(newest.status) ? newest.status.toLowerCase() : ''].filter(Boolean).join(' · ');
      } catch (e) { warn(`${h.id} vzdump log`, e); detail = [isOk(newest.status) ? 'finished' : newest.status, `${mins} min`].join(' · '); }
      logs.set(h.id, { upid: newest.upid, detail });
    }
  }
  const left = missing.filter(m => m?.vmid != null && !guests.find(g => g.vmid === Number(m.vmid))?.template).map(m => m.vmid);
  if (left.length) detail += `${detail ? ' · ' : ''}VM ${left.join(', ')} in no backup job`;

  // 14 daily squares: OK → up, warnings → degraded, failed → down; no run → degraded for a daily job once the day is over
  const daily = job ? !/[a-z-]/i.test(String(job.schedule ?? '').replace(/daily/i, '')) : /nightly|daily/i.test(cfgSchedule);
  // before the oldest run we can see (the job may not have existed yet), a missing run says nothing
  const today = dayStart(Date.now()), oldest = runs.length ? Math.min(...runs.map(t => t.starttime * 1000)) : Infinity;
  const nextRun = num(job?.['next-run']);
  const days: Status[] = Array.from({ length: 14 }, (_, i) => {
    const from = dayStart(today - (13 - i) * DAY + 12 * 3600e3), to = dayStart(from + DAY + 12 * 3600e3); // DST-safe day edges
    const that = done.filter(t => t.starttime * 1000 >= from && t.starttime * 1000 < to);
    if (that.some(t => !isOk(t.status))) return 'down';
    if (that.some(t => /^WARNINGS/.test(t.status))) return 'degraded';
    if (that.length) return 'up';
    if (!daily || to <= oldest || runs.some(t => !t.status && t.starttime * 1000 >= from && t.starttime * 1000 < to)) return 'unknown'; // or it's running now
    if (from === today) return nextRun != null && nextRun * 1000 >= to ? 'degraded' : 'unknown'; // today's run missed, or not due yet
    return 'degraded';
  });
  return { lastAt: lastOk ? lastOk.endtime * 1000 : null, ok: newest ? isOk(newest.status) : null, detail, days };
}

const kernel = (k: unknown) => String(k ?? '').match(/Linux (\S+)/)?.[1]?.replace(/-pve$/, '') ?? null;

export const proxmox: Adapter = {
  name: 'proxmox',
  label: 'Proxmox API',
  every: 15_000,
  get needs() { return `a PVEAuditor API token per node (${config.hosts.filter(h => h.type === 'proxmox').map(h => `${tokenPrefix(h)}_TOKEN_ID/SECRET`).join(', ') || 'PVE_<HOST ID>_TOKEN_ID/SECRET'})`; },
  configured: () => pveHosts().length > 0,
  async run() {
    const hosts = pveHosts();
    const polled = await Promise.all(hosts.map(async h => {
      const [st, qemu, lxc, ver] = await Promise.allSettled([pveGet<any>(h, '/status'), pveGet<any[]>(h, '/qemu'), pveGet<any[]>(h, '/lxc'), pveGet<any>(h, '/version')]);
      return { h, st, qemu, lxc, ver, ok: [st, qemu, lxc].some(r => r.status === 'fulfilled') };
    }));
    let lastErr: unknown = null;
    const pending: Promise<unknown>[] = [];
    for (const { h, st, qemu, lxc, ok } of polled) {
      for (const [what, r] of [['status', st], ['qemu', qemu], ['lxc', lxc]] as const)
        if (r.status === 'rejected') { warn(`${h.id} ${what}`, r.reason); lastErr = r.reason; } else quiet(`${h.id} ${what}`);
      fails.set(h.id, ok ? 0 : (fails.get(h.id) ?? 0) + 1);
      if (!ok) continue;
      // slow parts: started now, read from their caches below (a refresh that's still running lands next poll)
      if (qemu.status === 'fulfilled') pending.push(...vmRefreshes(h, qemu.value));
      pending.push(poolOf(h).refresh(() => loadPool(h)));
      const cfgJob = config.jobs.find(j => j.signal === 'proxmox-vzdump' && j.node === h.id);
      const listed = [qemu, lxc].flatMap(r => (r.status === 'fulfilled' ? r.value : [])).map(g => ({ vmid: Number(g.vmid), template: Number(g.template) === 1 }));
      if (cfgJob && lxc.status === 'fulfilled' && qemu.status === 'fulfilled') pending.push(vzOf(h).refresh(() => loadVzdump(h, listed, cfgJob.schedule)));
    }
    if (!polled.some(p => p.ok)) throw new Error(`no Proxmox node answered (${why(lastErr)})`);
    await within(5000, pending);

    const hostStatus: Record<string, Status> = {}, hostRes: Record<string, ResRaw> = {}, guests: Record<string, GuestRaw> = {};
    const pveStorage: NonNullable<Raw['pveStorage']> = {}, versions: Record<string, string> = {}, jobs: Record<string, JobRaw> = {};
    for (const { h, st, qemu, lxc, ver, ok } of polled) {
      const n = fails.get(h.id) ?? 0;
      hostStatus[h.id] = n === 0 ? 'up' : n >= 3 ? 'down' : 'unknown';

      // guests: a list that didn't answer this poll keeps its last-known members, as 'unknown'
      const prev = Object.values(lastGuests.get(h.id) ?? {}), cur: Record<string, GuestRaw> = {};
      const add = (g: GuestRaw) => { cur[`${h.id}:${g.vmid}`] = g; };
      if (qemu.status === 'fulfilled') qemu.value.forEach(g => add(vmGuest(h, g))); else prev.filter(g => g.kind === 'vm').forEach(g => add(unknownGuest(g)));
      if (lxc.status === 'fulfilled') lxc.value.forEach(g => add(lxcGuest(h, g))); else prev.filter(g => g.kind === 'lxc').forEach(g => add(unknownGuest(g)));
      lastGuests.set(h.id, cur);
      Object.assign(guests, cur);

      if (st.status === 'fulfilled') {
        const s = st.value;
        hostRes[h.id] = {
          cpuPct: pct(s.cpu), memUsed: num(s.memory?.used), memTotal: num(s.memory?.total), swapUsed: num(s.swap?.used), swapTotal: num(s.swap?.total),
          diskUsed: num(s.rootfs?.used), diskTotal: num(s.rootfs?.total), load1: num(s.loadavg?.[0]), uptimeSec: num(s.uptime),
        };
      }
      const v = ver.status === 'fulfilled' && ver.value?.version ? String(ver.value.version) : st.status === 'fulfilled' ? String(st.value.pveversion ?? '').split('/')[1] : null;
      const k = st.status === 'fulfilled' ? kernel(st.value.kversion) : null;
      if (v) versions[`Proxmox · ${h.name}`] = k ? `${v} · kernel ${k}` : v;

      // a node that didn't answer this poll shows no pool or backup result (its cache would read as current)
      if (!ok) continue;
      const pool = poolOf(h).get(), count = Object.values(cur).filter(g => !g.template).length;
      if (pool) pveStorage[h.id] = { label: `${h.name} · ${pool.storage}`, usedGB: pool.used / 1e9, totalGB: pool.total / 1e9, sub: plural(count, 'guest') };
      const vz = vzOf(h).get();
      if (vz) for (const j of config.jobs.filter(j => j.signal === 'proxmox-vzdump' && j.node === h.id)) jobs[j.id] = vz;
    }
    return { hostStatus, hostRes, guests, pveStorage, versions, jobs };
  },
};
