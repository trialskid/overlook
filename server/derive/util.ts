// Small pure helpers for derive(): status math, number/age formatting. Every one of them takes
// null/NaN without throwing, because derive() must never crash on partial data.
import type { HomelabConfig, Status } from '../../shared/types.ts';

export const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
/** an array slice, or [] when it's missing or malformed (derive must stay total) */
export const arr = <T>(x: T[] | null | undefined): T[] => (Array.isArray(x) ? x : []);

const RANK: Record<Status, number> = { up: 0, unknown: 1, degraded: 2, down: 3 };
/** Worst known status. 'unknown' means "no signal", so it never outranks a real answer; only all-unknown is unknown. */
export function worst(xs: (Status | null | undefined)[]): Status {
  let w: Status | null = null;
  for (const s of xs) if (s && s !== 'unknown' && (w == null || RANK[s] > RANK[w])) w = s;
  return w ?? 'unknown';
}
export const bool = (b: boolean | null | undefined): Status => (b == null ? 'unknown' : b ? 'up' : 'down');

/** whole percent for the text, floored so it never reads past a threshold it hasn't crossed (84.6 % → '84%');
 *  thresholds compare the unrounded ratio (shared/rules.ts) */
export const pctOf = (used: number | null | undefined, total: number | null | undefined) =>
  fin(used) && fin(total) && total > 0 ? Math.floor((used / total) * 100) : null;

/** 43.66 → '43.7', 50.99 → '51', 120.4 → '120' */
export const num1 = (v: number) => (Math.abs(v) >= 100 ? String(Math.round(v)) : String(Number(v.toFixed(1))));
export const fmt = (n: number) => n.toLocaleString('en-US');
/** decimal units throughout (the ARRAY KPI, the storage bars and the host cards agree) */
export const bytes = (b: number | null | undefined) =>
  !fin(b) ? '—' : b >= 0.9995e12 ? `${num1(b / 1e12)} TB` : b >= 0.9995e9 ? `${num1(b / 1e9)} GB` : `${num1(b / 1e6)} MB`; // 999.8 GB reads 1 TB, not 1000 GB
export const gb = (v: number) => bytes(v * 1e9);
export const tb = (v: number) => bytes(v * 1e12);

/** '45 s', '4 min', '3 h' (up to 47 h), '2 d' */
export function dur(sec: number) {
  const s = Math.max(0, sec);
  return s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 48 * 3600 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`;
}
/** 'just now', '12 min ago', '3 h ago', '2 d ago'; 'no data' when there is no time */
export const ago = (at: number | null | undefined, now: number) => (!fin(at) ? 'no data' : now - at < 60_000 ? 'just now' : `${dur((now - at) / 1000)} ago`);

export const median = (a: number[]) => {
  const s = a.filter(fin).sort((x, y) => x - y), m = s.length >> 1;
  return !s.length ? null : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const mean = (a: number[]) => { const s = a.filter(fin); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : null; };
export const minOf = (a: (number | null | undefined)[]) => { const s = a.filter(fin); return s.length ? Math.min(...s) : null; };
export const maxOf = (a: (number | null | undefined)[]) => { const s = a.filter(fin); return s.length ? Math.max(...s) : null; };
export const sum = (a: (number | null | undefined)[]) => a.filter(fin).reduce((x, y) => x + y, 0);

export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/** 'Kopia → B2' → 'kopia-b2' (React keys, leaf keys) */
export const slug = (s: string) => s.toLowerCase().replace(/\s*\(.*\)$/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** for loose name matching (Grafana alertnames ↔ CC items): lowercase letters and digits only */
export const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** URL → host and port (default port by scheme); null when it doesn't parse */
export function hostPort(url: string | null | undefined): { host: string; port: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase(), port: u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '') };
  } catch { return null; }
}
/** A monitor URL as it may appear on the page: host[:port] and path only. The query (tokens) and any
 *  user:password are dropped, so nothing secret from a Kuma monitor's URL reaches the Snapshot. */
export function safeUrl(url: string | null | undefined): string {
  if (!url) return '';
  try { const u = new URL(url); return (u.host + u.pathname).replace(/\/$/, ''); } catch { return ''; }
}
export const isLanHost = (host: string) => /^(10|127|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host);

/** '2:14 PM' today, 'Oct 2, 2:14 PM' otherwise (local time of the homelab) */
export function clock(ms: number, now: number) {
  const tz = process.env.TZ || undefined, d = new Date(ms); // TZ comes from homelab.json `timezone` (config.ts), else the system's
  const t = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });
  return now - ms < 20 * 3600e3 ? t : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz })}, ${t}`;
}
/** 'Oct 2' (local date of the homelab) */
export const day = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: process.env.TZ || undefined });

/** A homelab.json detail template filled from named values (JobConfig.detail): '{n}' a number, '{t:clock}', '{t:day}' and
 *  '{t:ago}' an epoch in seconds, '{n|none}' the word instead of a 0. Parts are split on ' · '; a part whose value is
 *  missing (no series) is left out, and so is a part naming a value the template has none for. */
export function fillDetail(tpl: string | undefined, values: Record<string, number | null> | undefined, now: number): string {
  if (!tpl) return '';
  return tpl.split(' · ').map(part => {
    let gone = false;
    const out = part.replace(/\{(\w+)(?::(clock|day|ago))?(?:\|([^}]*))?\}/g, (_, k: string, f?: string, zero?: string) => {
      const v = values?.[k];
      if (!fin(v)) { gone = true; return ''; }
      if (f === 'clock') return clock(v * 1000, now);
      if (f === 'day') return day(v * 1000);
      if (f === 'ago') return ago(v * 1000, now);
      return v === 0 && zero != null ? zero : fmt(Math.round(v * 10) / 10);
    });
    return gone ? '' : out;
  }).filter(Boolean).join(' · ');
}

/** Where a program runs, from homelab.json: the guest whose services name it, else the host of an app by that name;
 *  '' when nothing says. Used for the 'where' part of Health rows ('web · reverse proxy'). */
export function whereOf(cfg: Pick<HomelabConfig, 'guests' | 'apps' | 'hosts'>, re: RegExp): string {
  const g = arr(cfg.guests).find(x => arr(x?.services).some(s => re.test(String(s))));
  if (g) return g.name;
  const a = arr(cfg.apps).find(x => re.test(String(x?.name)));
  return a ? arr(cfg.hosts).find(h => h.id === a.host)?.name ?? a.host : '';
}
/** A Prometheus scrape job's name: homelab.json prometheus.jobs, else the default. */
export const jobOf = (cfg: Pick<HomelabConfig, 'prometheus'>, k: keyof NonNullable<NonNullable<HomelabConfig['prometheus']>['jobs']>, def: string) => cfg.prometheus?.jobs?.[k]?.trim() || def;
