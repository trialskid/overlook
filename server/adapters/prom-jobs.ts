// Prometheus · jobs & backups (every 60 s): every config.jobs entry with signal 'prometheus'.
//   last: last-success epoch (s) → lastAt (ms); ok: 1 / 0 → true / false. A missing series is null (no data).
//   by:   one row per value of that label, keyed `${id}:${value}`; an `ok` series without the label applies to
//         every row of the job (so homelab.json can give a per-container backup job a per-row ok: its global last_run_success
//         would mark every CT failed when one did). Several series for one row read as the worst: the oldest
//         last, the lowest ok.
// 14-day strips: a range query of time() - (last) at 1 d steps, recomputed every 10 min and dropped once
// older than 30 min: 'up' when the age was under maxAgeH, 'degraded' over it, 'unknown' with no value.
// A job whose own expression fails at run time (a 422 from Prometheus) carries `error`: its rows read 'unknown'
// with the reason, never green because the last-success half still answers.
// values: a job's `values` (one number each, the first series; not for `by` jobs) for its detail line, rendered by derive.
// Writes Raw.jobs, a MERGE key: proxmox adds vzdump-*, ntfy adds its own jobs.
import { config } from '../config.ts';
import { ranges, rowsAndErrors, toMs, type Row } from './prometheus.ts';
import { env, type Adapter } from './types.ts';
import type { JobRaw, Raw } from '../raw.ts';
import type { JobConfig, Status } from '../../shared/types.ts';

const DAY = 86400, STRIP_EVERY = 10 * 60e3, STRIP_MAX_AGE = 30 * 60e3;
type Rows = Record<string, JobRaw & { label?: string }>;
let strips: { at: number; sig: string; days: Record<string, Status[]> } | null = null;

/** the worst value per row: min by (label) for `by` jobs, min over everything otherwise */
const worst = (j: JobConfig, e: string) => (j.by ? `min by (${j.by}) (${e})` : `min(${e})`);
const rowKey = (j: JobConfig, m: Record<string, string>) => (j.by && m[j.by] ? `${j.id}:${m[j.by]}` : j.id);

async function refreshStrips(jobs: JobConfig[], sig: string) {
  const want = jobs.filter(j => j.last && j.maxAgeH > 0);
  const end = Math.floor(Date.now() / 1000), start = end - 13 * DAY;
  const r = await ranges(Object.fromEntries(want.map(j => [`days:${j.id}`, `time() - ${worst(j, j.last!)}`])), 13 * DAY, DAY, end);
  const days: Record<string, Status[]> = {};
  for (const j of want) {
    for (const s of r[`days:${j.id}`] ?? []) {
      const at = new Map(s.v.map(([t, v]) => [Math.round(t), v]));
      days[rowKey(j, s.m)] = Array.from({ length: 14 }, (_, d) => {
        const age = at.get(start + d * DAY);
        return age == null ? 'unknown' : age < j.maxAgeH * 3600 ? 'up' : 'degraded';
      });
    }
  }
  strips = { at: Date.now(), sig, days };
}

export const promJobs: Adapter = {
  name: 'prom-jobs',
  label: 'Prometheus · jobs & backups',
  every: 60_000,
  needs: 'PROMETHEUS_URL in .env',
  configured: () => !!env('PROMETHEUS_URL'),
  async run() {
    const jobs = config.jobs.filter(j => j.signal === 'prometheus' && (j.last || j.ok));
    const qs: Record<string, string> = {};
    const vals = (j: JobConfig) => (j.by ? [] : Object.entries(j.values ?? {}).filter(([k, q]) => k && typeof q === 'string' && q));
    for (const j of jobs) {
      if (j.last) qs[`last:${j.id}`] = worst(j, j.last);
      if (j.ok) qs[`ok:${j.id}`] = worst(j, j.ok);
      for (const [k, q] of vals(j)) qs[`val:${j.id}:${k}`] = q;
    }
    const { out: r, failed } = await rowsAndErrors(qs);

    // strips: at most every 10 min; a failed refresh keeps the old ones until they are 30 min old
    const sig = JSON.stringify(jobs.map(j => [j.id, j.last, j.by, j.maxAgeH]));
    if (!strips || strips.sig !== sig || Date.now() - strips.at >= STRIP_EVERY)
      await refreshStrips(jobs, sig).catch(e => console.warn(`[prom-jobs] strips: ${(e as Error).message}`));
    const fresh = strips && strips.sig === sig && Date.now() - strips.at <= STRIP_MAX_AGE ? strips.days : null;

    const out: Rows = {};
    for (const j of jobs) {
      const last: Row[] = r[`last:${j.id}`] ?? [], ok: Row[] = r[`ok:${j.id}`] ?? [];
      const err = [failed[`ok:${j.id}`] && `ok signal failed: ${failed[`ok:${j.id}`]}`, failed[`last:${j.id}`] && `last-success signal failed: ${failed[`last:${j.id}`]}`].filter(Boolean).join(' · ');
      const days = (key: string) => (j.last && j.maxAgeH > 0 && fresh ? fresh[key] ?? Array(14).fill('unknown') : null);
      const allOk = ok.find(x => !j.by || !x.m[j.by]); // an ok series without the `by` label covers every row
      const keys = new Map<string, string | undefined>(); // row key → label value
      for (const x of [...last, ...ok]) if (!j.by || x.m[j.by]) keys.set(rowKey(j, x.m), j.by ? x.m[j.by] : undefined);
      if (!keys.size) keys.set(j.id, undefined); // nothing at all: one explicit no-data row
      for (const [key, value] of keys) {
        const l = last.find(x => rowKey(j, x.m) === key), o = ok.find(x => j.by && value !== undefined && x.m[j.by] === value) ?? allOk;
        const values = key === j.id && vals(j).length ? { values: Object.fromEntries(vals(j).map(([k]) => [k, r[`val:${j.id}:${k}`]?.[0]?.v ?? null])) } : {};
        out[key] = {
          ...values, lastAt: l ? toMs(l.v) : null, ok: o ? o.v >= 1 : null,
          days: days(key), ...(value !== undefined ? { label: value } : {}), ...(err ? { error: err } : {}),
        };
      }
    }
    return { jobs: out } satisfies Partial<Raw>;
  },
};
