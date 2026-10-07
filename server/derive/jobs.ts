// config.jobs → Health → Jobs. The list of expected jobs comes from config, so a job whose metric
// vanished still has a row ('no data') instead of silently dropping out (backup-rows-vanish-and-freeze).
// Ages are computed here from epoch ms on every rebuild, never baked in at poll time.
import type { HomelabConfig, JobConfig, JobView, Status } from '../../shared/types.ts';
import type { JobRaw, Raw } from '../raw.ts';
import { ago, dur, fillDetail, fin } from './util.ts';

/** which adapter feeds a job's signal (its source going stale explains a 'no data' row) */
export const JOB_SOURCE: Record<JobConfig['signal'], string> = { prometheus: 'prom-jobs', 'proxmox-vzdump': 'proxmox', ntfy: 'ntfy', none: '' };

export interface JobState { job: JobConfig; rows: JobView[]; status: Status; source: string }

/** `readAt`: when the source last answered. Overdue is judged as of then, so a source that is a minute behind
 *  (still within its max age) can't make an every-minute job look late; the source's own item covers the lag. */
function rowStatus(r: JobRaw | undefined, job: JobConfig, readAt: number): Status {
  if (!r) return 'unknown';
  if (r.ok === false) return 'down';
  if (r.error) return 'unknown'; // half its signal broke: the other half answering is not 'ok'
  if (fin(r.lastAt) && job.maxAgeH > 0 && readAt - r.lastAt > job.maxAgeH * 3600e3) return 'degraded';
  if (!fin(r.lastAt) && r.ok == null) return 'unknown';
  return 'up';
}

/** `label`: the `by` label value of a per-label row (undefined for a job-level row) */
function row(id: string, name: string, job: JobConfig, r: JobRaw | undefined, now: number, readAt: number, label?: string): JobView {
  const status = rowStatus(r, job, readAt), lastAt = fin(r?.lastAt) ? r!.lastAt : null;
  const why = status === 'down' ? 'last run failed'
    : status === 'degraded' ? `overdue · expected within ${dur(job.maxAgeH * 3600)}`
    : status === 'unknown' ? r?.error ?? 'no data' : '';
  // a state-only signal (e.g. HA's 'backups stale' sensor) has no time to show; say what it reports instead of 'no data'
  const stateOnly = job.signal === 'prometheus' && !job.last && r?.ok != null;
  // the strip's squares are last-success ages sampled every 10 min; today's square follows the row, so a red or
  // overdue row never ends in green
  const tail = r?.days?.[r.days.length - 1];
  const days = r?.days && (status === 'down' || (status === 'degraded' && tail === 'up')) ? [...r.days.slice(0, -1), status] : r?.days ?? null;
  // Health's grouping: rows of one family share a line, each shown by its short label
  const family = job.family || (job.by ? job.name : undefined), short = label ?? job.short;
  return {
    id, name, group: job.group, where: job.where, schedule: job.schedule, status, lastAt, lastAgo: stateOnly ? (r!.ok ? 'current' : 'failing') : ago(lastAt, now),
    detail: [why, r?.detail, label === undefined ? fillDetail(job.detail, r?.values, now) : ''].filter(Boolean).join(' · '), days, signal: job.signal, ...(job.link ? { link: job.link } : {}), ...(job.critical ? { critical: true } : {}),
    ...(family ? { family } : {}), ...(short ? { short } : {}),
  };
}

/** down > degraded > unknown (no data) > up: for a job, a missing row is worse than a healthy one */
export function jobStatus(rows: { status: Status }[]): Status {
  const has = (s: Status) => rows.some(r => r.status === s);
  return !rows.length ? 'unknown' : has('down') ? 'down' : has('degraded') ? 'degraded' : has('unknown') ? 'unknown' : 'up';
}

/** `readAt(source)`: when that adapter last answered (now when unknown, e.g. mock). */
export function deriveJobs(cfg: HomelabConfig, raw: Raw, now: number, readAt: (source: string) => number = () => now) {
  const states: JobState[] = [];
  for (let job of (cfg.jobs ?? []).filter(j => j?.id && j.signal)) { // a half-written entry is skipped, not a throw
    if (job.signal === 'none') continue;
    const at = Math.min(now, readAt(JOB_SOURCE[job.signal]));
    job = { ...job, maxAgeH: Number(job.maxAgeH) || 0 };
    const own = raw.jobs?.[job.id];
    const by = job.by ? Object.entries(raw.jobs ?? {}).filter(([k]) => k.startsWith(`${job.id}:`)).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })) : [];
    const rows = by.map(([k, r]) => { const label = r.label ?? k.slice(job.id.length + 1); return row(k, `${job.name} · ${label}`, job, r, now, at, label); });
    // a job-level entry next to per-label rows (e.g. a backup job's global last-run result) gets its own row first
    if ((own && (!rows.length || own.ok != null || fin(own.lastAt))) || !rows.length) rows.unshift(row(job.id, job.name, job, own, now, at));
    states.push({ job, rows, status: jobStatus(rows), source: JOB_SOURCE[job.signal] });
  }
  return {
    states,
    jobs: states.flatMap(s => s.rows),
    unmonitored: (cfg.jobs ?? []).filter(j => j?.signal === 'none').map(j => ({ name: j.name, where: j.where, note: j.note ?? 'no machine-readable signal' })),
  };
}
