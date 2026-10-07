// Public reachability, checked from inside the LAN every 5 min: one GET per public hostname, redirects
// not followed (Cloudflare Access answers 302/401, and that is the expected code), plus the retired
// hosts, which should stop resolving. DNS is looked up first so a missing record reads 'NXDOMAIN'
// rather than a timeout. Port forwards (probe: false) have no safe GET and aren't probed.
import { lookup } from 'node:dns/promises';
import { getBuffer } from '../http.ts';
import { config } from '../config.ts';
import { env, type Adapter } from './types.ts';
import type { Raw } from '../raw.ts';

type Probe = NonNullable<Raw['probes']>[string];
const TIMEOUT = 8000;
/** curl's exit codes (curl mode) and node's error codes, as one short phrase */
const CURL: Record<string, string> = { 6: 'NXDOMAIN', 7: 'connection refused', 28: 'timeout', 35: 'TLS error', 52: 'empty reply', 56: 'connection reset', 60: 'TLS error' };
function short(e: any, ms: number): string {
  const code = String(e?.code ?? ''), msg = String(e?.message ?? e), c = msg.match(/curl: \((\d+)\)/)?.[1];
  if (c && CURL[c]) return CURL[c];
  if (ms >= TIMEOUT - 500 || /timeout|timed out/i.test(msg)) return 'timeout';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ECONNRESET') return 'connection reset';
  if (/CERT|SSL|TLS/i.test(code + msg)) return 'TLS error';
  return code || 'no answer';
}

async function probe(host: string, p = '/'): Promise<Probe> {
  const at = Date.now();
  try { await lookup(host); } catch (e: any) { return { code: null, ms: null, error: e?.code === 'ENOTFOUND' ? 'NXDOMAIN' : 'DNS failed', at }; }
  const t0 = performance.now();
  try {
    const r = await getBuffer(`https://${host}${p.startsWith('/') ? p : '/' + p}`, { timeout: TIMEOUT, headers: { 'User-Agent': 'command-center reachability probe' } });
    return { code: r.status || null, ms: Math.round(performance.now() - t0), error: r.status ? null : 'no status line', at };
  } catch (e) { return { code: null, ms: null, error: short(e, performance.now() - t0), at }; }
}

export const probes: Adapter = {
  name: 'probes',
  label: 'Public reachability',
  every: 300_000,
  maxAge: 900_000,
  configured: () => env('PROBES') !== 'off',
  async run() {
    const targets = new Map<string, string>(); // host → path, first entry wins
    for (const e of config.publicEndpoints) if (e.probe !== false && e.via !== 'port-forward' && !targets.has(e.host)) targets.set(e.host, e.path || '/');
    for (const h of config.retiredHosts) if (!targets.has(h)) targets.set(h, '/');
    const entries = await Promise.all([...targets].map(async ([host, p]) => [host, await probe(host, p)] as const));
    // every lookup failing means our own DNS is broken, not that every public name vanished
    if (entries.length && entries.every(([, r]) => r.error === 'NXDOMAIN' || r.error === 'DNS failed')) throw new Error('DNS lookups failing for every public host');
    return { probes: Object.fromEntries(entries) };
  },
};
