// Grafana: the alerts firing now, from its Alertmanager API with silenced and inhibited
// alerts left out, so a silence set in Grafana also quiets the dashboard. Viewer token, GET only.
// Grafana stays the source of truth for what is firing; ntfy's 'grafana' topic is only history.
import { getJSON } from '../http.ts';
import { env, trimUrl, type Adapter } from './types.ts';
import type { Raw } from '../raw.ts';

const BASE = () => trimUrl(env('GRAFANA_URL'));
/** Labels that are safe and useful on the page; the rest (rule uids, values, hosts) stays server-side. */
const KEEP = ['alertname', 'severity', 'alert_class', 'grafana_folder', 'instance', 'job', 'mountpoint', 'ct', 'source'];
const SEV: Record<string, number> = { critical: 0, warning: 1, info: 2 };
/** generatorURL → the rule's own page path (Grafana's root_url may be an internal address; the page adds its own host) */
const rulePath = (u: unknown) => {
  try { const p = new URL(String(u)); return /^\/alerting\/grafana\/[\w-]+\/view$/.test(p.pathname) ? { path: p.pathname } : {}; } catch { return {}; }
};

export const grafana: Adapter = {
  name: 'grafana',
  label: 'Grafana alerts',
  every: 30_000,
  needs: 'the Grafana URL and a Viewer service-account token (GRAFANA_URL, GRAFANA_TOKEN)',
  configured: () => !!(env('GRAFANA_URL') && env('GRAFANA_TOKEN')),
  async run() {
    const [alerts, health] = await Promise.all([
      getJSON<any[]>(`${BASE()}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false`, { headers: { Authorization: `Bearer ${env('GRAFANA_TOKEN')}` } }),
      getJSON(`${BASE()}/api/health`).catch(() => null), // no auth; a missing version isn't an outage
    ]);
    if (!Array.isArray(alerts)) throw new Error('unexpected answer from Grafana alertmanager');
    const list: NonNullable<Raw['grafana']> = alerts
      .filter(a => a?.labels?.alertname && (a.status?.state ?? 'active') === 'active')
      .map(a => {
        const L = a.labels as Record<string, string>, A = (a.annotations ?? {}) as Record<string, string>;
        const since = Date.parse(a.startsAt);
        return {
          name: String(L.alertname), severity: String(L.severity ?? 'warning'),
          summary: String(A.summary ?? A.description ?? '').slice(0, 300),
          since: Number.isFinite(since) && since > 0 ? since : null,
          labels: Object.fromEntries(KEEP.filter(k => L[k] != null).map(k => [k, String(L[k])])),
          ...rulePath(a.generatorURL),
        };
      })
      .sort((a, b) => (SEV[a.severity] ?? 1) - (SEV[b.severity] ?? 1) || (b.since ?? 0) - (a.since ?? 0));
    return { grafana: list, ...(health?.version ? { versions: { Grafana: String(health.version) } } : {}) };
  },
};
