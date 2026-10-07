// Uptime Kuma monitors → the CC's keys. Pure, so the incident path and the tests run the same code.
//
// Key order (first match wins):
//   1. config.kumaAliases[id]                       (port monitors, infra checks: 'infra:caddy', …)
//   2. URL host <sub>.<domain> with webUis[sub]      → web UI
//   3. URL host is a publicEndpoints host            → 'public:<host>'
//   4. URL (or hostname:port) is a web UI's LAN ip:port → web UI (exact match, never a substring)
//   5. an app whose kuma[] lists the id              → 'app:<name>'
//   otherwise unmapped: listed in Health, never dropped.
import type { HomelabConfig, Monitor, Status } from '../../shared/types.ts';
import type { KumaMonitorRaw } from '../raw.ts';
import { arr, hostPort, maxOf, minOf, worst } from './util.ts';

export const CELLS = 48;

/** '10.20.0.0/24' → '10.20.0' (web UI targets are written as '.42:3000') */
export const lanBase = (cfg: HomelabConfig) => (cfg.network?.subnet ?? '').split('/')[0].split('.').slice(0, 3).join('.');
export const uiAddr = (cfg: HomelabConfig, target: string) => {
  const [ip, port] = target.split(':');
  return { ip: ip.startsWith('.') ? lanBase(cfg) + ip : ip, port: port ?? '' };
};

export function kumaKey(m: KumaMonitorRaw, cfg: HomelabConfig): string | null {
  const alias = cfg.kumaAliases?.[String(m.id)];
  if (alias) return alias;
  const hp = hostPort(m.url);
  const host = hp?.host ?? m.hostname?.toLowerCase() ?? '';
  const sfx = `.${cfg.domain}`;
  if (host.endsWith(sfx)) { const sub = host.slice(0, -sfx.length); if (cfg.webUis?.[sub]) return sub; }
  if (host && (cfg.publicEndpoints ?? []).some(e => String(e?.host ?? '').toLowerCase() === host)) return `public:${host}`;
  const addrs = [hp && `${hp.host}:${hp.port}`, m.hostname && m.port && `${m.hostname}:${m.port}`].filter(Boolean);
  for (const [name, target] of Object.entries(cfg.webUis ?? {})) {
    if (typeof target !== 'string') continue;
    const a = uiAddr(cfg, target);
    if (addrs.includes(`${a.ip}:${a.port}`)) return name;
  }
  const app = (cfg.apps ?? []).find(a => a?.name && Array.isArray(a.kuma) && a.kuma.includes(m.id));
  return app ? `app:${app.name}` : null;
}

export interface KumaMap {
  /** key → its monitors (several monitors on one key fold into one row, worst wins) */
  byKey: Map<string, KumaMonitorRaw[]>;
  unmapped: KumaMonitorRaw[];
  all: KumaMonitorRaw[];
}
export function mapKuma(list: KumaMonitorRaw[] | null, cfg: HomelabConfig): KumaMap {
  const byKey = new Map<string, KumaMonitorRaw[]>(), unmapped: KumaMonitorRaw[] = [], all = arr(list).filter(m => m && typeof m === 'object');
  for (const m of all) {
    const k = kumaKey(m, cfg);
    if (!k) unmapped.push(m);
    else byKey.set(k, [...(byKey.get(k) ?? []), m]);
  }
  return { byKey, unmapped, all };
}

/** Kuma monitors whose URL points at a public host (also counted toward that endpoint and its app) */
export const monitorsForHost = (km: KumaMap, host: string) => km.all.filter(m => hostPort(m.url)?.host === host.toLowerCase());

/** worst cell per 30-min slot, right-aligned (newest last) */
function mergeCells(ms: KumaMonitorRaw[]): Status[] {
  return Array.from({ length: CELLS }, (_, i) => worst(ms.map(m => { const c = arr(m.cells); return c[c.length - CELLS + i]; })));
}
const ratio = (v: number | null) => (v == null ? null : Math.round(v * 10000) / 100);

export function monitorRow(name: string, label: string, ms: KumaMonitorRaw[], mapped: boolean, now: number): Monitor {
  const status = ms.length ? worst(ms.map(m => m.status)) : 'unknown';
  const rep = ms.find(m => m.status === status) ?? ms[0];
  const downSince = minOf(ms.filter(m => m.status === 'down').map(m => m.downSince));
  return {
    name, label, kumaId: rep?.id ?? null, status, cells: mergeCells(ms),
    ms: maxOf(ms.map(m => m.ms)),
    uptime30: ratio(minOf(ms.map(m => m.up30d))), uptime1: ratio(minOf(ms.map(m => m.up1d))),
    certDays: minOf(ms.map(m => m.certDays)),
    ...(status === 'down' && downSince != null ? { downMin: Math.max(0, Math.round((now - downSince) / 60_000)) } : {}),
    mapped,
  };
}
