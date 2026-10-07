// simulateIncident: Uptime Kuma reports one web UI ('git' by default) down for the last two 30-min
// slots, down since 4 min ago. Applied to the raw data, mock or live, so derive() runs the real failure path.
import { config } from './config.ts';
import { hostPort } from './derive/util.ts';
import { uiAddr } from './derive/kuma.ts';
import type { Raw } from './raw.ts';

export function applyIncident(raw: Raw, name = process.env.SIMULATE_INCIDENT_UI || 'git'): Raw {
  if (!raw.kuma) return raw;
  // the UI's monitor: by its <name>.<domain> host, or by its LAN address (homelab.json webUis)
  const host = `${name}.${config.domain}`.toLowerCase(), since = Date.now() - 4 * 60_000;
  const t = config.webUis?.[name], lan = typeof t === 'string' ? uiAddr(config, t) : null;
  const isUi = (url: string) => { const hp = hostPort(url); return !!hp && (hp.host === host || (!!lan && hp.host === lan.ip && String(hp.port ?? '') === lan.port)); };
  return {
    ...raw,
    kuma: raw.kuma.map(m => !isUi(m.url) ? m : {
      ...m, status: 'down', ms: null, downSince: since,
      cells: (m.cells?.length ? m.cells : Array(48).fill('unknown')).map((c, i, a) => (i >= a.length - 2 ? 'down' : c)),
    }),
  };
}
