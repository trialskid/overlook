// Prometheus · checks (every 30 s): homelab.json `checks` (each a PromQL query that returns one number; a Kuma check
// has no query and is read by derive from the kuma adapter) and `storage` (bytes used and in all per row). A query that
// fails costs only its own value (batch() keys failures by query); no series is null ('no data' on the page).
import { config } from '../config.ts';
import { many } from './prometheus.ts';
import { env, type Adapter } from './types.ts';

export const promChecks: Adapter = {
  name: 'prom-checks',
  label: 'Prometheus · checks',
  every: 30_000,
  needs: 'PROMETHEUS_URL in .env and checks or storage in homelab.json',
  configured: () => !!env('PROMETHEUS_URL') && ((config.checks?.length ?? 0) > 0 || (config.storage?.length ?? 0) > 0),
  async run() {
    const list = (config.checks ?? []).filter(c => c?.id && c.query);
    const vols = (config.storage ?? []).filter(s => s?.name && s.used && s.total);
    const v = await many({
      ...Object.fromEntries(list.map(c => [c.id, c.query!])),
      ...Object.fromEntries(vols.flatMap(s => [[`storage:used:${s.name}`, s.used], [`storage:total:${s.name}`, s.total]])),
    });
    return {
      checks: Object.fromEntries(list.map(c => [c.id, v[c.id] ?? null])),
      storage: Object.fromEntries(vols.map(s => [s.name, { used: v[`storage:used:${s.name}`] ?? null, total: v[`storage:total:${s.name}`] ?? null }])),
    };
  },
};
