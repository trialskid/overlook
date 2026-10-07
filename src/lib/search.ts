// Search helpers shared by the launcher filter and the ⌘K palette: names, labels, the owning
// guest's matching service, the domain, and a few aliases for words people actually type.
import type { Snapshot, WebUi } from '../../shared/types.ts';
import { ui } from './uiconfig.ts';

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Extra words per web UI / app / link name: product ones plus homelab.json ui.aliases (lower-case keys). */
export const aliasOf = (name: string) => ui().aliases[name.toLowerCase()] ?? '';

/** The owning guest's service that this UI is (git → Gitea, uptime → Uptime Kuma), '' when none matches. */
export function serviceOf(snap: Snapshot, u: WebUi) {
  if (u.owner?.kind !== 'guest') return '';
  const g = snap.guests.find(x => x.id === u.owner!.id), n = norm(u.name);
  return g?.services.find(s => { const k = norm(s); return k.startsWith(n) || (k.length >= 4 && n.startsWith(k)); }) ?? '';
}

/** Every word of the query must appear somewhere in the haystack. */
export const matches = (hay: string, q: string) => q.split(/\s+/).filter(Boolean).every(w => hay.includes(w));

/** 'https://photos.example.com/' → 'photos.example.com', 'http://10.20.0.30:8443' → '.30:8443' (on the lab's LAN prefix). */
export function shortUrl(url: string) {
  try { const u = new URL(url); const lan = lanOctet(u.hostname); return (lan ? `.${lan}` : u.hostname) + (u.port ? `:${u.port}` : '') + (u.pathname.length > 1 ? u.pathname : ''); } catch { return url; }
}

/** '10.20.0.42' → '42' when it's on the lab's LAN prefix, else null. */
export function lanOctet(host: string): string | null {
  const p = ui().lanPrefix;
  if (!p || !host.startsWith(p + '.')) return null;
  const rest = host.slice(p.length + 1);
  return /^\d+$/.test(rest) ? rest : null;
}
