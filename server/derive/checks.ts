// homelab.json `checks` (adapter prom-checks) → rows under Health › Alerting and Needs attention items. A check past
// danger is red, past warn amber ('below' flips the comparison); no series reads 'no data' and raises nothing (the
// source's own staleness is reported once, by the hub).
import type { CheckConfig, HomelabConfig, Snapshot, Tone } from '../../shared/types.ts';
import type { Raw } from '../raw.ts';
import type { Item } from './attention.ts';
import { arr, fin, slug } from './util.ts';

type Row = Snapshot['health']['alerting'][number];

const past = (c: CheckConfig, v: number, t: number | undefined) => fin(t) && (c.below ? v < t : v > t);
/** 12.345 → '12.3', 1234 → '1,234' */
const show = (v: number, unit = '') => `${Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : Math.round(v * 10) / 10}${unit}`;

export function deriveChecks(cfg: Pick<HomelabConfig, 'checks'>, raw: Raw, fresh: boolean): { rows: Row[]; items: Item[] } {
  const rows: Row[] = [], items: Item[] = [];
  for (const c of arr(cfg.checks)) {
    if (!c?.id || !c.name) continue;
    const v = fresh ? raw.checks?.[c.id] ?? null : null;
    const job = c.job ? { job: c.job } : {};
    if (!fin(v)) { rows.push({ name: c.name, where: c.where ?? 'check', state: fresh ? 'no data' : 'not answering', tone: 'warn', ...job }); continue; }
    const tone: Tone = past(c, v, c.danger) ? 'danger' : past(c, v, c.warn) ? 'warn' : 'ok';
    const value = show(v, c.unit);
    rows.push({ name: c.name, where: c.where ?? 'check', state: value, tone, ...job });
    if (tone !== 'ok') items.push({
      id: `check-${slug(c.id)}`, severity: tone, rank: tone === 'danger' ? 30 : 55, source: 'Prometheus · check',
      title: `${c.name}: ${value}`, detail: (c.detail ?? `${c.below ? 'below' : 'above'} ${show((tone === 'danger' ? c.danger : c.warn)!, c.unit)}`).replace(/\{value\}/g, value),
      ...(c.link ? { action: { label: 'Open', href: c.link } } : {}),
    });
  }
  return { rows, items };
}
