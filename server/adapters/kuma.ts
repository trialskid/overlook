// Uptime Kuma (.205:3001) `/metrics` with a read-only API key: every monitor, as Kuma reports it.
// Status, latency, uptime ratios (Kuma's own 1d/30d windows) and cert days come straight from Kuma;
// which web UI or app a monitor watches is decided in derive, so nothing is dropped here. Only the
// 24 h strip is ours: Kuma exports no history, so it's built from our 30 s samples, keyed by monitor
// id and kept in DATA_DIR/kuma-history-v2.json so a restart doesn't wipe it. (v3 keeps its own, differently shaped
// kuma-history.json in the same volume; v3.1 never touches it, so rolling back to v3 keeps working.)
import fs from 'node:fs';
import path from 'node:path';
import { getText } from '../http.ts';
import { env, trimUrl, type Adapter } from './types.ts';
import type { KumaMonitorRaw } from '../raw.ts';
import type { Status } from '../../shared/types.ts';

const SLOT = 30 * 60e3, SLOTS = 48, V = 2;
/** a down streak survives a gap in our own sampling (a restart) only if it's shorter than this */
const GAP = 5 * 60e3;
const RANK: Record<Status, number> = { unknown: 0, up: 1, degraded: 2, down: 3 };
const STATUS: Record<string, Status> = { 1: 'up', 0: 'down', 2: 'degraded', 3: 'unknown' }; // 2 pending, 3 maintenance
/** Kuma keeps a stale `url` on monitors that were switched to another type (Caddy's port monitor still says :80). */
const HTTPISH = /^(http|keyword|json-query|real-browser)$/;

/** Per monitor id: worst status per 30-min slot, when we first saw the current down streak, when we last saw it. */
interface Hist { v: number; slots: Record<string, Record<string, Status>>; down: Record<string, number>; seen: Record<string, number> }
const file = () => path.join(env('DATA_DIR') || 'data', 'kuma-history-v2.json');
const blank = (): Hist => ({ v: V, slots: {}, down: {}, seen: {} });
let hist = blank();
try { const h = JSON.parse(fs.readFileSync(file(), 'utf8')); if (h?.v === V) hist = { ...blank(), ...h }; } catch { /* first run */ }
let lastSave = 0;
export function saveKumaHistory() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file() + '.tmp', JSON.stringify(hist)); fs.renameSync(file() + '.tmp', file()); // never a half-written file
    lastSave = Date.now();
  } catch (e) { console.warn(`[kuma] history not saved: ${(e as Error).message}`); }
}

const nn = (v: string | undefined) => (!v || v === 'null' ? null : v);
const labels = (s: string) => Object.fromEntries([...s.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map(x => [x[1], x[2].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c))]));

export function parse(body: string): KumaMonitorRaw[] {
  const mons = new Map<number, KumaMonitorRaw>(), invalid = new Set<number>(), withStatus = new Set<number>();
  let lines = 0;
  for (const line of body.split('\n')) {
    const m = line.match(/^(monitor_\w+)\{(.*)\}\s+(\S+)$/);
    if (!m) continue;
    lines++;
    const L = labels(m[2]), id = Number(L.monitor_id), val = Number(m[3]);
    if (!Number.isInteger(id) || !L.monitor_id) continue;
    let mon = mons.get(id);
    if (!mon) {
      const type = L.monitor_type ?? '';
      mons.set(id, mon = {
        id, name: L.monitor_name || `#${id}`, type, url: HTTPISH.test(type) ? nn(L.monitor_url) ?? '' : '',
        hostname: nn(L.monitor_hostname), port: nn(L.monitor_port),
        status: 'unknown', ms: null, up1d: null, up30d: null, certDays: null, cells: [], downSince: null,
      });
    }
    if (!Number.isFinite(val)) continue;
    switch (m[1]) {
      case 'monitor_status': mon.status = STATUS[val] ?? 'unknown'; withStatus.add(id); break;
      case 'monitor_response_time': if (val >= 0) mon.ms = Math.round(val); break;
      case 'monitor_uptime_ratio': if (val >= 0 && val <= 1) { if (L.window === '1d') mon.up1d = val; else if (L.window === '30d') mon.up30d = val; } break;
      case 'monitor_cert_days_remaining': mon.certDays = Math.floor(val); break;
      case 'monitor_cert_is_valid': if (val === 0) invalid.add(id); break;
    }
  }
  if (lines && !mons.size) throw new Error('Kuma /metrics has no monitor_id label (needs Uptime Kuma 2)');
  // an invalid cert on a monitor that's still up means it skips TLS checks (Omada's self-signed one): its expiry isn't actionable
  for (const id of invalid) mons.get(id)!.certDays = null;
  return [...mons.values()].filter(m => withStatus.has(m.id)).map(m => (m.status === 'down' ? { ...m, ms: null } : m)).sort((a, b) => a.id - b.id);
}

/** Records this sample and fills in cells and downSince. */
function remember(list: KumaMonitorRaw[], now: number) {
  const slot = Math.floor(now / SLOT);
  for (const m of list) {
    const k = String(m.id), s = (hist.slots[k] ??= {});
    if (RANK[m.status] >= RANK[s[slot] ?? 'unknown']) s[slot] = m.status; // worst status in the slot
    if (m.status !== 'down') delete hist.down[k];
    else if (!hist.down[k] || now - (hist.seen[k] ?? 0) > GAP) hist.down[k] = now;
    hist.seen[k] = now;
    m.cells = Array.from({ length: SLOTS }, (_, i) => s[slot - SLOTS + 1 + i] ?? 'unknown');
    m.downSince = hist.down[k] ?? null;
  }
  for (const k of Object.keys(hist.slots)) {
    for (const t of Object.keys(hist.slots[k])) if (Number(t) <= slot - SLOTS) delete hist.slots[k][t];
    if (!Object.keys(hist.slots[k]).length) { delete hist.slots[k]; delete hist.down[k]; delete hist.seen[k]; } // monitor gone for 24 h
  }
}

export const kuma: Adapter = {
  name: 'kuma',
  label: 'Uptime Kuma',
  every: 30_000,
  needs: 'the Uptime Kuma URL and an API key (KUMA_URL, KUMA_API_KEY)',
  configured: () => !!(env('KUMA_URL') && env('KUMA_API_KEY')),
  async run() {
    const body = await getText(`${trimUrl(env('KUMA_URL'))}/metrics`, { headers: { Authorization: 'Basic ' + Buffer.from(':' + env('KUMA_API_KEY')).toString('base64') } });
    const list = parse(body), now = Date.now();
    remember(list, now);
    if (now - lastSave > 5 * 60e3) saveKumaHistory();
    return { kuma: list };
  },
};
