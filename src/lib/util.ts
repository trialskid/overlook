import type { JobView, Severity, Snapshot, Status, Tone } from '../../shared/types.ts';
import { serverNow } from './live.ts';
import { ui } from './uiconfig.ts';

/** Monogram tile colours: oklch(0.3 0.05 H) on oklch(0.86 0.11 H). */
export const tint = (h: number) => ({ background: `oklch(0.3 0.05 ${h})`, color: `oklch(0.86 0.11 ${h})` });
/** Per-app hue: sum(charCodes) * 37 % 360 (links use 41). */
export const hueOf = (s: string, k = 37) => ([...s].reduce((a, c) => a + c.charCodeAt(0), 0) * k) % 360;
/** A tile's two-character monogram (launcher, phone Launch, Links): the first two letters, upper-case, unless a
 *  monogram from Snapshot.ui (product defaults plus homelab.json ui.monograms) keeps it unique in the set. */
export const monoOf = (s: string) => { const k = s.replace(/[^A-Za-z0-9]/g, ''); return ui().monograms[k.toLowerCase()] ?? k.slice(0, 2).toUpperCase(); };
/** Monograms used by more than one name, e.g. ['PR: printer, prowlarr']; empty when every tile is unique. */
export function monoClashes(names: string[]) {
  const by = new Map<string, string[]>();
  for (const n of names) by.set(monoOf(n), [...(by.get(monoOf(n)) ?? []), n]);
  return [...by].filter(([, ns]) => ns.length > 1).map(([m, ns]) => `${m}: ${ns.join(', ')}`);
}
/** Monograms unique within one set (Bookmarks; polish, Oct 6), in list order. Candidates, the first one not taken
 *  (compared upper-case, so 'Sp' never sits beside 'SP'): the first two words' initials ('Cloudflare Zero Trust' → CZ,
 *  'Home Lab' → HL); the first two letters ('Shodan' → SH); the first letter and an inner capital ('SpeedTest' → ST,
 *  'GitHub' → GH); then the first letter and each later letter in turn, upper-lower like monoOf's overrides ('Claude' →
 *  'Ca' when CL is Cloudflare's). A name met twice keeps its first monogram. */
export function monoSet(names: string[]) {
  const out = new Map<string, string>(), taken = new Set<string>();
  for (const name of names) {
    if (out.has(name)) continue;
    const words = name.split(/\s+/).map(w => w.replace(/[^A-Za-z0-9]/g, '')).filter(Boolean), first = words[0] ?? '?', flat = words.join('');
    const caps = [...first.slice(1)].filter(c => /[A-Z]/.test(c)).map(c => first[0] + c);
    const later = [...flat.slice(1)].map(c => first[0].toUpperCase() + c.toLowerCase());
    const cands = [...(words.length > 1 ? [words[0][0] + words[1][0]] : []), flat.slice(0, 2), ...caps].map(c => c.toUpperCase()).concat(later);
    const m = cands.find(c => c.length === 2 && !taken.has(c.toUpperCase())) ?? flat.slice(0, 2).toUpperCase();
    taken.add(m.toUpperCase()); out.set(name, m);
  }
  return out;
}
export const GUEST_HUE = { vm: 270, lxc: 165 } as const;
/** Guest IPs travel as the last octet ('.42'); hosts and Proxmox-only guests may carry a full address. */
export const fullIp = (ip: string) => (ip.startsWith('.') && ui().lanPrefix ? `${ui().lanPrefix}${ip}` : ip);

export const fmt = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));
export const fmt1 = (n: number | null | undefined) => (n == null ? '—' : n.toFixed(1));
/** The latest sample, null when that second had no data (a gap), never an older value. */
export const last = (a: (number | null)[]) => (a.length ? a[a.length - 1] : null);
/** Bytes → '12.4 GiB' / '1.8 TiB'. */
export function fmtBytes(n: number | null | undefined) {
  if (n == null) return '—';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']; let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
/** Seconds → '12 s' / '4 min' / '3 h' / '2 d', floored like the server's dur(), so Overview and Health agree. */
export function agoText(sec: number | null | undefined) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const s = Math.max(0, sec);
  return s < 60 ? `${Math.floor(s)} s` : s < 3600 ? `${Math.floor(s / 60)} min` : s < 48 * 3600 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`;
}
/** agoText for a narrow column, on one line: '8s', '57m', '3h', '2d' */
export const agoShort = (sec: number | null | undefined) => agoText(sec).replace(/ (s|min|h|d)$/, (_, u: string) => (u === 'min' ? 'm' : u));
/** Epoch ms (server time) → '3 h ago', counted on the server's clock. */
export const ago = (at: number | null | undefined, now = serverNow()) => (at == null ? '—' : `${agoText((now - at) / 1000)} ago`);
/** Seconds since a server epoch-ms time. */
export const secSince = (at: number) => (serverNow() - at) / 1000;
/** An age the server counted at snap.at, as of now: it keeps counting while the snapshot is unchanged or the link is down. */
export const aged = (sec: number | null | undefined, snap: Snapshot) => (sec == null ? null : sec + Math.max(0, secSince(snap.at)));
/** A job's last run as of now (from lastAt), or the server's word for a state-only signal ('current', 'failing'). */
export const jobAgo = (j: JobView) => (j.lastAt != null ? ago(j.lastAt) : j.lastAgo);
/** Epoch ms → '14:03' today, 'Oct 2' before. */
export function whenText(at: number, now = new Date()) {
  const d = new Date(at);
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
export const dayText = (at: number) => new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** A job row's colour: the tier its Needs attention item has (a critical job red, any other failure amber), never
 *  plain red for a non-critical backup; no data is grey. */
export const jobColor = (j: Pick<JobView, 'status' | 'critical'>) => (j.status === 'up' ? 'var(--ok)' : j.status === 'unknown' ? 'var(--mut-5)' : j.critical ? 'var(--danger)' : 'var(--warn)');
/** text next to a job: muted when fine, its tier's colour when not (grey text for no data stays readable) */
export const jobText = (j: Pick<JobView, 'status' | 'critical'>) => (j.status === 'up' ? 'var(--mut-3)' : j.status === 'unknown' ? 'var(--mut-3)' : j.critical ? 'var(--danger)' : 'var(--warn)');
/** The first 30-min slot any monitor has data for, while the strips don't cover the full 24 h yet (after a deploy). */
export function stripSince(cells: Status[][], at: number) {
  const SLOT = 30 * 60e3, n = Math.max(0, ...cells.map(c => c.length));
  const firsts = cells.map(c => c.findIndex(x => x !== 'unknown')).filter(i => i >= 0);
  const first = firsts.length ? Math.min(...firsts) : -1;
  return first > 0 ? (Math.floor(at / SLOT) - (n - 1 - first)) * SLOT : null;
}
/** The worse of two statuses (down > degraded > unknown > up). */
export const worst = (a: Status, b: Status): Status => { const o: Status[] = ['down', 'degraded', 'unknown', 'up']; return o[Math.min(o.indexOf(a), o.indexOf(b))]; };
/** A guest's page in its host's Proxmox UI, null when the host has no URL. */
export const pveUrl = (hostUrl: string | null | undefined, g: { kind: 'vm' | 'lxc'; vmid: number }) =>
  hostUrl ? `${hostUrl.replace(/\/$/, '')}/#v1:0:=${g.kind === 'vm' ? 'qemu' : 'lxc'}%2F${g.vmid}` : null;
export const statusColor = (s: Status) => (s === 'up' ? 'var(--ok)' : s === 'down' ? 'var(--danger)' : s === 'degraded' ? 'var(--warn)' : 'var(--mut-5)');
/** A status word's colour: statusColor, but 'Unknown' stays readable (--mut-5 is for dots and rings only). */
export const statusText = (s: Status) => (s === 'unknown' ? 'var(--mut-3)' : statusColor(s));
export const cellColor = (s: Status) => (s === 'up' ? 'var(--uptime-up)' : s === 'down' ? 'var(--danger)' : s === 'degraded' ? 'var(--warn)' : 'var(--rule-3)');
export const toneColor = (t: Tone | undefined) => (t === 'danger' ? 'var(--danger)' : t === 'warn' ? 'var(--warn)' : t === 'ok' ? 'var(--ok)' : 'var(--text)');
/** Row colours per severity: dot, sub-text, top rule. */
export const sevColors = (s: Severity | 'none') => s === 'danger'
  ? { c: 'var(--danger)', sub: 'var(--danger-sub)', rule: 'var(--danger-rule)' }
  : s === 'warn' ? { c: 'var(--warn)', sub: 'var(--warn-sub)', rule: 'var(--warn-rule)' }
    : s === 'info' ? { c: 'var(--info)', sub: 'var(--info-sub)', rule: 'var(--info-rule)' }
      : { c: 'var(--mut-3)', sub: 'var(--mut-3)', rule: 'var(--rule)' };
export const STATUS_WORD: Record<Status, string> = { up: 'Up', degraded: 'Degraded', down: 'Down', unknown: 'Unknown' };

/** Chart ceiling: the design's scale, raised when the data goes above it (e.g. a busy Unraid). Gaps are ignored. */
export const scaleMax = (a: (number | null)[], base: number) => Math.max(base, ...a.map(v => (v ?? 0) * 1.15));

/** Sparkline paths in a w×h box, values scaled to max (the prototype's paths()). A null splits the line: no data is drawn as a gap. */
export function paths(a: (number | null)[], w: number, h: number, max: number) {
  if (a.length < 2) return { line: '', area: '' };
  const st = w / (a.length - 1), y = (v: number) => (h - 2 - (Math.min(v, max) / max) * (h - 4)).toFixed(1);
  const segs: [number, number][][] = [[]];
  a.forEach((v, i) => { if (v == null) { if (segs[segs.length - 1].length) segs.push([]); } else segs[segs.length - 1].push([i, v]); });
  let line = '', area = '';
  for (const s of segs) {
    if (s.length < 2) continue; // a lone sample between gaps has no width to draw
    const l = 'M' + s.map(([i, v]) => `${(i * st).toFixed(1)},${y(v)}`).join(' L');
    line += l;
    area += `${l} L${(s[s.length - 1][0] * st).toFixed(1)},${h} L${(s[0][0] * st).toFixed(1)},${h} Z`;
  }
  return { line, area };
}

/** The web UI URL for an app name (e.g. 'sonarr'), null when there is no Caddy name for it. WebUi.url already
 *  carries homelab.json uiPaths (Plex: /web/index.html); a `path` replaces it (e.g. '/requests'). */
export const uiUrl = (snap: Snapshot, name: string, path = '') => {
  const u = snap.uis.find(x => x.name === name);
  if (!u) return null;
  try { return path ? new URL(u.url).origin + path : u.url; } catch { return u.url; }
};
/** Why a source has no data: 'not connected · needs …' or 'not answering · last ok 4 min ago'. */
export function whyMissing(snap: Snapshot, src: string, what: string) {
  const s = snap.sources.find(x => x.name === src);
  if (!s || s.conn === 'not-connected') return `${what} not connected${s?.needs ? ` · needs ${s.needs}` : ''}`;
  if (s.conn === 'stale' || s.conn === 'error') return `${what} not answering${s.lastOk != null ? ` · last ok ${ago(s.lastOk)}` : ''}`;
  return `${what}: no data`;
}

/** Scrolls an anchor to the top of the window (its scrollMarginTop clears a sticky bar), after `delay` ms so a tab
 *  switch has rendered it; smooth unless the reader asked for reduced motion. */
export const scrollToId = (id: string, delay = 0) => setTimeout(() => {
  const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById(id)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
}, delay);
export function greeting(d = new Date()) { const h = d.getHours(); return h < 12 ? 'Good morning.' : h < 18 ? 'Good afternoon.' : 'Good evening.'; }
export const clockText = (d = new Date()) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const clockSec = (d = new Date()) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export const dateText = (d = new Date()) => `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`.toUpperCase();
