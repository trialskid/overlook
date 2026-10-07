// Needs attention: ordering, Grafana de-duplication and the status line built from it.
import type { Attention, Severity, Snapshot } from '../../shared/types.ts';
import type { Raw } from '../raw.ts';
import { plural, squash } from './util.ts';

/** An attention item plus what derive needs to rank and de-duplicate it (stripped before it ships). */
export interface Item extends Attention {
  /** lower = more important: orders the list within a tier and picks the item the headline names */
  rank: number;
  /** 'source': a stale/failing adapter ('Partial data' when they're the only warns). 'ui': one web UI down. */
  kind?: 'source' | 'ui';
  /** A firing Grafana alert says the same thing when its alertname matches `name` and, if given, one of its
   *  label values contains `label` (or one of them: disk3, a host's LAN and storage-link IPs). The CC item is
   *  kept, the alert is folded into it. */
  dupe?: { name: RegExp; label?: string | string[] };
}

const SEV: Record<Severity, number> = { danger: 0, warn: 1, info: 2 };
const sevOf = (s: string | undefined) => (s ?? '').toLowerCase();

/** Grafana labels → tier: critical → danger, warning → warn; info and alert_class=maintenance → info. */
export function grafanaSeverity(severity: string | undefined, labels: Record<string, string>): Severity {
  if (sevOf(labels?.alert_class) === 'maintenance') return 'info';
  const s = sevOf(severity || labels?.severity);
  return s === 'critical' ? 'danger' : s === 'warning' || s === 'warn' ? 'warn' : 'info';
}

/**
 * One item per firing Grafana alert, minus the ones a CC rule already reports. Matching is by alertname
 * keywords (Item.dupe): 'Appdata Backup Failed' ↔ the appdata job, 'Unraid Data Disk Capacity
 * Warning' {mountpoint=/mnt/disk3} ↔ the disk3 item, an app's down alert ↔ that app's item.
 * The kept CC item takes the alert's severity if that's worse and its start time if that's earlier.
 */
export function foldGrafana(items: Item[], alerts: NonNullable<Raw['grafana']>, url: string): Item[] {
  const out: Item[] = [], seen = new Set<string>();
  for (const a of alerts) {
    const name = String(a?.name ?? 'Grafana alert'), labels = a?.labels ?? {}, sev = grafanaSeverity(a?.severity, labels);
    const vals = Object.values(labels).map(v => String(v).toLowerCase());
    const hit = (l: string | string[]) => [l].flat().filter(Boolean).some(x => vals.some(v => v.includes(x.toLowerCase())));
    const twin = items.find(i => i.dupe && i.dupe.name.test(name) && (!i.dupe.label || hit(i.dupe.label)));
    if (twin) {
      if (SEV[sev] < SEV[twin.severity]) twin.severity = sev;
      if (a.since != null && (twin.since == null || a.since < twin.since)) twin.since = a.since;
      if (!twin.detail.includes('Grafana')) twin.detail += ` · Grafana: ${name}`;
      continue;
    }
    let id = `grafana-${squash(name)}`;
    const extra = String(labels.mountpoint ?? labels.instance ?? labels.source ?? labels.ct ?? '');
    if (seen.has(id)) id += `-${squash(extra) || out.length}`;
    seen.add(id);
    out.push({
      id, severity: sev, rank: sev === 'danger' ? 40 : 90, source: 'Grafana', since: a.since,
      title: name, detail: [a.summary, extra].filter(Boolean).join(' · ') || 'firing in Grafana',
      action: a.path ? { label: 'Open rule in Grafana', href: new URL(a.path, url).toString() } : { label: 'Open Grafana alerts', href: url },
    });
  }
  return out;
}

/** danger → warn → info; within a tier the most important rule first (rank), then the newest. An item with no
 *  start time (a source blind since start) counts as new, so missing data never sinks below a flapping alert. */
export function sortItems(items: Item[], now = Date.now()): Item[] {
  return [...items].sort((a, b) => SEV[a.severity] - SEV[b.severity] || a.rank - b.rank || (b.since ?? now) - (a.since ?? now));
}

/** Drops the internal fields; ids stay unique even if two rules collide. */
export function shipItems(items: Item[]): Attention[] {
  const ids = new Set<string>();
  return items.map(({ rank: _r, kind: _k, dupe: _d, ...a }) => {
    let id = a.id;
    for (let n = 2; ids.has(id); n++) id = `${a.id}-${n}`;
    ids.add(id);
    return { ...a, id };
  });
}

/** red when anything is down, amber when something needs a look, green only when nothing does; info never counts */
export function statusLine(items: Item[], nominal: string): Snapshot['status'] {
  const danger = items.filter(i => i.severity === 'danger'), warn = items.filter(i => i.severity === 'warn');
  if (danger.length) {
    const top = [...danger].sort((a, b) => a.rank - b.rank)[0], n = danger.length;
    const oneUi = n === 1 && top.kind === 'ui';
    return {
      tone: 'danger', ok: false,
      label: oneUi ? '1 SERVICE DOWN' : `${n} ${n === 1 ? 'PROBLEM' : 'PROBLEMS'}`,
      short: oneUi ? '1 service down' : plural(n, 'problem'),
      headline: n === 1 ? top.title : `${top.title} · ${n - 1} more`,
    };
  }
  if (warn.length) {
    const n = warn.length;
    return {
      tone: 'warn', ok: false, label: 'NEEDS ATTENTION',
      short: warn.every(i => i.kind === 'source') ? 'Partial data' : `${n} ${n === 1 ? 'needs' : 'need'} a look`,
      headline: [...warn].sort((a, b) => a.rank - b.rank)[0].title,
    };
  }
  return { tone: 'ok', ok: true, label: 'ALL SYSTEMS NOMINAL', short: 'All systems nominal', headline: nominal };
}
