// homelab.json `restore` (module restore, adapter prom-restore) → the Restore tab: every copy, its age, its proof and
// what a restore costs. Look only: it raises no Needs attention items (jobs and Grafana already do) and nothing on it
// acts. Never stale, never guessed: an item whose read is missing says "can't read now", one that reads 0 'none found'.
import type { HomelabConfig, RestoreItemView, RestoreView } from '../../shared/types.ts';
import type { Raw } from '../raw.ts';
import type { JobState } from './jobs.ts';
import { JOB_SOURCE } from './jobs.ts';
import { arr, fin, minOf } from './util.ts';

export const RESTORE_NOTE = 'Look only: nothing here restores anything.';
export const RESTORE_MAX_AGE_H = 30;
export const CANT_READ = "can't read now";
export const NONE_FOUND = 'none found';

/** `lastOk(source)`: when that source last answered (epoch ms; null when it isn't fresh). */
export function deriveRestore(cfg: Pick<HomelabConfig, 'restore'>, raw: Raw, jobStates: JobState[], lastOk: (source: string) => number | null, now: number): RestoreView | null {
  const rc = cfg.restore, list = arr(rc?.items);
  if (!list.length) return null;
  const used = new Set<string>();
  const items: RestoreItemView[] = [];
  list.forEach((it, i) => {
    if (!it?.id || !it.name) return; // a half-written entry is skipped (its number stays its position)
    const n = i + 1, ms: number[] = [];
    let zero = false, missing = false;
    if (it.newest) {
      used.add('prom-restore');
      const vals = raw.restore?.[it.id]?.newest;
      if (!vals) missing = true; // the query failed, or Prometheus isn't fresh: no part of this item is guessed
      else for (const v of vals) { if (!fin(v)) continue; if (v <= 0) zero = true; else ms.push(v * 1000); }
    }
    for (const id of arr(it.jobs)) {
      const st = jobStates.find(s => s.job.id === id);
      if (st) used.add(JOB_SOURCE[st.job.signal]);
      const at = minOf(arr(st?.rows).map(r => r.lastAt)); // a `by` job counts once, by its oldest row
      if (fin(at)) ms.push(at);
    }
    const read = missing ? 0 : ms.length + (zero ? 1 : 0);
    const why = missing || !read ? CANT_READ : zero ? NONE_FOUND : null;
    const newest = why ? null : Math.min(...ms);
    const maxAgeH = fin(it.maxAgeH) && it.maxAgeH > 0 ? it.maxAgeH : RESTORE_MAX_AGE_H;
    const expected = fin(it.expect) && it.expect > 0 ? it.expect : null;
    if (it.proofAt) used.add('prom-restore');
    const proofRead = raw.restore?.[it.id]?.proofAt;
    const fill = (t: string, enc: boolean) => t.replace(/\{n\}/g, String(n)).replace(/\{id\}/g, enc ? encodeURIComponent(it.id) : it.id);
    const a = it.ask === false ? null : rc?.ask;
    items.push({
      n, id: it.id, name: it.name, newest,
      series: { read, expected, unit: it.unit ?? null },
      stale: newest != null && now - newest > maxAgeH * 3600e3,
      short: expected != null && read < expected,
      why,
      proof: it.proof ?? 'finished',
      proofAt: it.proofAt && fin(proofRead) && proofRead > 0 ? proofRead * 1000 : it.proofOn ?? null,
      proofNote: it.proofNote ?? null, cost: it.cost ?? null,
      ask: a && (a.url || a.text) ? { url: a.url ? fill(a.url, true) : null, text: a.text ? fill(a.text, false) : null, label: a.label || 'Restore…' } : null,
      link: it.link ?? null,
    });
  });
  // the read time: the oldest last answer among the fresh sources the list used (none fresh: null)
  return { note: rc?.note ?? RESTORE_NOTE, runbook: rc?.runbook ?? null, readAt: minOf([...used].filter(Boolean).map(lastOk)), items };
}
