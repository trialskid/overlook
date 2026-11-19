// Prometheus · restore (every 60 s): homelab.json restore.items. Each item's `newest` query keeps every series it
// returns (the Restore tab shows the oldest of them), its `proofAt` the latest. A query that fails costs only its own
// item (batch() keys failures by query) and reads as null; derive says "can't read now", never a guessed age.
import { config } from '../config.ts';
import { rowsAndErrors } from './prometheus.ts';
import { env, type Adapter } from './types.ts';

export const promRestore: Adapter = {
  name: 'prom-restore',
  label: 'Prometheus · restore',
  every: 60_000,
  needs: 'PROMETHEUS_URL in .env and restore.items in homelab.json',
  configured: () => !!env('PROMETHEUS_URL') && (config.restore?.items?.length ?? 0) > 0,
  async run() {
    const items = (config.restore?.items ?? []).filter(i => i?.id && (i.newest || i.proofAt));
    const { out, failed } = await rowsAndErrors(Object.fromEntries(items.flatMap(i => [
      ...(i.newest ? [[`newest:${i.id}`, i.newest]] : []), ...(i.proofAt ? [[`proof:${i.id}`, i.proofAt]] : []),
    ])));
    const vals = (k: string) => (k in failed ? null : (out[k] ?? []).map(r => r.v));
    return {
      restore: Object.fromEntries(items.map(i => {
        const proof = i.proofAt ? vals(`proof:${i.id}`) : null;
        return [i.id, { newest: i.newest ? vals(`newest:${i.id}`) : null, proofAt: proof?.length ? Math.max(...proof) : null }];
      })),
    };
  },
};
