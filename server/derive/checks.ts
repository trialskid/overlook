// homelab.json `checks` (adapter prom-checks; a `kuma` check reads the kuma adapter) → rows under Health › Alerting and
// Needs attention items. A check past danger is red, past warn amber ('below' flips the comparison); no series reads
// 'no data' and raises nothing (the source's own staleness is reported once, by the hub).
import type { CheckConfig, HomelabConfig, Snapshot, Status, Tone } from '../../shared/types.ts';
import type { Raw } from '../raw.ts';
import type { Item } from './attention.ts';
import { ago, arr, dur, fin, slug } from './util.ts';

type Row = Snapshot['health']['alerting'][number];

const past = (c: CheckConfig, v: number, t: number | undefined) => fin(t) && (c.below ? v < t : v > t);
/** 12.345 → '12.3', 1234 → '1,234' */
const show = (v: number, unit = '') => `${Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : Math.round(v * 10) / 10}${unit}`;
/** a Kuma check's value: 1 while every monitor is up, 0 once one is down, 0.5 pending or in maintenance */
const KUMA_VALUE: Record<Status, number | null> = { up: 1, degraded: 0.5, down: 0, unknown: null };

/** the item's detail when the check names none: the threshold it crossed, or where it looks for a yes/no check */
function defaultDetail(c: CheckConfig, tone: Tone, kuma: boolean, isAge: boolean) {
  if (kuma || c.words) return c.where ?? '';
  const t = (tone === 'danger' ? c.danger : c.warn)!;
  return isAge ? `older than ${dur(t)}` : `${c.below ? 'below' : 'above'} ${show(t, c.unit)}`;
}

/** `fresh`: is each source answering (prom-checks, kuma). `now` turns a format 'ago' epoch into an age. */
export function deriveChecks(cfg: Pick<HomelabConfig, 'checks'>, raw: Raw, fresh: boolean | { prom: boolean; kuma: boolean }, now = Date.now()): { rows: Row[]; items: Item[] } {
  const ok = typeof fresh === 'boolean' ? { prom: fresh, kuma: fresh } : fresh;
  const rows: Row[] = [], items: Item[] = [];
  for (const c of arr(cfg.checks)) {
    if (!c?.id || !c.name) continue;
    const kuma = arr(c.kuma).filter(fin);
    const live = kuma.length ? ok.kuma : ok.prom;
    let v: number | null = null;
    if (live && kuma.length) {
      const seen = kuma.map(id => arr(raw.kuma).find(m => m.id === id)?.status).filter((s): s is Status => !!s && s !== 'unknown');
      v = seen.length === kuma.length ? Math.min(...seen.map(s => KUMA_VALUE[s]!)) : null;
    } else if (live) v = raw.checks?.[c.id] ?? null;
    const job = c.job ? { job: c.job } : {};
    const where = c.where ?? (kuma.length ? 'Uptime Kuma' : 'check');
    if (!fin(v)) { rows.push({ name: c.name, where, state: !live ? 'not answering' : kuma.length ? 'no Kuma monitor' : 'no data', tone: 'warn', ...job }); continue; }
    // format 'ago': the value is an epoch (s); thresholds compare its age in seconds
    const age = c.format === 'ago' ? Math.max(0, now / 1000 - v) : null, x = age ?? v;
    const tone: Tone = past(c, x, c.danger) ? 'danger' : past(c, x, c.warn) ? 'warn' : 'ok';
    const word = c.words?.[String(v)];
    const value = word ?? (age != null ? ago(v * 1000, now) : show(v, c.unit));
    const state = c.text ? c.text.replace(/\{value\}/g, value) : value;
    rows.push({ name: c.name, where, state, tone, ...job });
    if (tone !== 'ok') items.push({
      id: `check-${slug(c.id)}`, severity: tone, rank: tone === 'danger' ? 30 : 55, source: kuma.length ? 'Uptime Kuma · check' : 'Prometheus · check',
      title: `${c.name}: ${state}`, detail: (c.detail ?? defaultDetail(c, tone, kuma.length > 0, age != null)).replace(/\{value\}/g, value),
      ...(c.link ? { action: { label: 'Open', href: c.link } } : {}),
    });
  }
  return { rows, items };
}
