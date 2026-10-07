// Prometheus · checks (every 30 s): homelab.json `checks`, each a PromQL query that returns one number. A query that
// fails costs only its own check (batch() keys failures by query); no series is null ('no data' on the page).
import { config } from '../config.ts';
import { many } from './prometheus.ts';
import { env, type Adapter } from './types.ts';

export const promChecks: Adapter = {
  name: 'prom-checks',
  label: 'Prometheus · checks',
  every: 30_000,
  needs: 'PROMETHEUS_URL in .env and checks in homelab.json',
  configured: () => !!env('PROMETHEUS_URL') && (config.checks?.length ?? 0) > 0,
  async run() {
    const list = (config.checks ?? []).filter(c => c?.id && c.query);
    const v = await many(Object.fromEntries(list.map(c => [c.id, c.query])));
    return { checks: Object.fromEntries(list.map(c => [c.id, v[c.id] ?? null])) };
  },
};
