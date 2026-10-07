// Fast series at 1 sample/s: Proxmox node CPU (API, live), and from Prometheus (one batched query every ~4 s; those
// move once per 15 s scrape) the CPU of every other host with a node_exporter job, WAN in/out, qBittorrent down/up
// and NZBGet down. A host with neither has no CPU series.
// Nothing old is repeated: a failed source reads null at once, and any value older than 20 s reads null,
// so the page draws a gap and '—' instead of a frozen number. Each rate() is gated on its target's `up`,
// because Prometheus keeps answering a rate from the samples left in the window for a minute or more after
// the exporter stops.
// With nobody watching (no SSE client), the sources are asked every 15 s instead of every second.
// Prometheus is queried here directly (not through an adapter) so the 1 s loop has its own short timeouts.
import { config } from './config.ts';
import { getJSON } from './http.ts';
import { pveGet, pveHosts } from './adapters/proxmox.ts';
import { env, trimUrl } from './adapters/types.ts';
import { jobOf } from './derive/util.ts';
import type { Sample } from './raw.ts';

/** `e` only while its exporter's last scrape (and, for qBittorrent, the exporter's own view of qBittorrent) is up */
const gated = (e: string, ...ups: string[]) => `(${e})${ups.map(u => ` and on() (max(${u}) == 1)`).join('')}`;
/** Hosts whose CPU comes from node_exporter: every host with a nodeJob that isn't a Proxmox node (those use the API). */
const nodeHosts = () => config.hosts.filter(h => h.type !== 'proxmox' && h.nodeJob);
const FAST_OF = (): Record<string, string> => {
  const gw = config.network?.gateway, wan = gw?.snmpJob && gw.wanIf ? { job: gw.snmpJob, ifName: gw.wanIf } : null;
  return {
    ...Object.fromEntries(nodeHosts().map(h => [`cpu:${h.id}`, gated(`100 * (1 - avg(rate(node_cpu_seconds_total{job="${h.nodeJob}",mode="idle"}[1m])))`, `up{job="${h.nodeJob}"}`)])),
    // the WAN rate from the gateway's SNMP interface counters (network.gateway.snmpJob + wanIf)
    ...(wan ? {
      wanIn: gated(`rate(ifHCInOctets{job="${wan.job}",ifName="${wan.ifName}"}[3m]) * 8 / 1e6`, `up{job="${wan.job}"}`),
      wanOut: gated(`rate(ifHCOutOctets{job="${wan.job}",ifName="${wan.ifName}"}[3m]) * 8 / 1e6`, `up{job="${wan.job}"}`),
    } : {}),
    // the downloaders' rates, each gated on its exporter's scrape job (homelab.json prometheus.jobs)
    qbDl: gated('sum(rate(qbittorrent_dl_info_data_total[3m])) / 1e6', `up{job="${jobOf(config, 'qbittorrent', 'qbittorrent-exporter')}"}`, 'qbittorrent_up'),
    qbUl: gated('sum(rate(qbittorrent_up_info_data_total[3m])) / 1e6', `up{job="${jobOf(config, 'qbittorrent', 'qbittorrent-exporter')}"}`, 'qbittorrent_up'),
    nzDl: gated('sum(rate(nzbget_downloaded_total_bytes[3m])) / 1e6', `up{job="${jobOf(config, 'nzbget', 'nzbget-exporter')}"}`),
  };
};
/** the fast series' keys: `cpu:<host id>` per node_exporter host, then wanIn … nzDl */
export type FastKey = string;
/** IDLE: how often to ask with nobody watching. JOB_MAX: a job that hasn't settled by then is dropped (its key frees). */
const MAX_AGE = 20_000, PROM_EVERY = 4000, IDLE_EVERY = 15_000, WAIT = 900, JOB_MAX = 5000;
const PROM = () => trimUrl(env('PROMETHEUS_URL'));
/** One decimal, or null for anything that isn't a finite number (a gap). */
export const tidy = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);

/** Several scalar queries in one round trip, each tagged with label k. A missing series is simply absent. */
async function many(qs: Record<string, string>, timeout: number): Promise<Record<string, number>> {
  const q = Object.entries(qs).map(([k, e]) => `label_replace(${e}, "k", "${k}", "", "")`).join(' or ');
  const j = await getJSON(`${PROM()}/api/v1/query?query=${encodeURIComponent(q)}`, { timeout });
  const out: Record<string, number> = {};
  for (const r of j.data.result) if (!(r.metric.k in out)) out[r.metric.k] = Number(r.value[1]);
  return out;
}

export class LiveSampler {
  private vals: Record<string, { v: number | null; at: number }> = {};
  private inFlight = new Set<string>();
  private due: Record<string, number> = {};
  private fails: Record<string, number> = {};
  private viewers = 0;

  /** SSE clients connected. With none, sources are asked every 15 s; the first viewer brings back 1 s at once. */
  setViewers(n: number) {
    if (n > 0 && this.viewers === 0) this.due = {};
    this.viewers = n;
  }
  private every(base: number) { return this.viewers > 0 ? base : Math.max(base, IDLE_EVERY); }

  /** Starts a job unless it is still running (busy until it settles) or backing off after failures (1, 2, 4 … 30 s).
   *  A job gets JOB_MAX at most: one that never settles counts as failed, so its key can't stay busy forever. */
  private start(key: string, every: number, job: () => Promise<void>, onFail: () => void): Promise<void> | null {
    if (this.inFlight.has(key) || Date.now() < (this.due[key] ?? 0)) return null;
    this.inFlight.add(key);
    let t: ReturnType<typeof setTimeout> | undefined;
    const capped = Promise.race([job(), new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error('no answer')), JOB_MAX); })]);
    return capped.then(
      () => { this.fails[key] = 0; this.due[key] = Date.now() + this.every(every); },
      () => { onFail(); const n = (this.fails[key] = (this.fails[key] ?? 0) + 1); this.due[key] = Date.now() + Math.max(this.every(0), Math.min(30_000, 1000 * 2 ** (n - 1))); },
    ).finally(() => { clearTimeout(t); this.inFlight.delete(key); });
  }
  private put(k: string, v: number | null) { this.vals[k] = { v: tidy(v), at: Date.now() }; }
  private get(k: string) { const x = this.vals[k]; return x && Date.now() - x.at <= MAX_AGE ? x.v : null; }

  async sample(): Promise<Sample> {
    const jobs = pveHosts().map(h => this.start(`pve:${h.id}`, 0,
      () => pveGet<{ cpu: number }>(h, '/status', 2500).then(s => this.put(`cpu:${h.id}`, Number(s.cpu) * 100)),
      () => this.put(`cpu:${h.id}`, null)));
    if (PROM()) jobs.push(this.start('prom', PROM_EVERY,
      () => { const qs = FAST_OF(); return many(qs, 3000).then(v => { for (const k of Object.keys(qs)) this.put(k, v[k] ?? null); }); },
      () => { for (const k of Object.keys(FAST_OF())) this.put(k, null); }));
    const started = jobs.filter(j => j != null);
    // answers that land within WAIT make this second's sample; slower ones fill the next
    if (started.length) {
      let t: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(started), new Promise(r => { t = setTimeout(r, WAIT); })]);
      clearTimeout(t);
    }
    const cpu: Record<string, number | null> = {};
    for (const h of config.hosts) cpu[h.id] = this.get(`cpu:${h.id}`); // Proxmox: the API job; node_exporter hosts: Prometheus
    return { cpu, wanIn: this.get('wanIn'), wanOut: this.get('wanOut'), qbDl: this.get('qbDl'), qbUl: this.get('qbUl'), nzDl: this.get('nzDl') };
  }

  /** The last `len` seconds from Prometheus so the sparklines start full; a step with no value stays a gap (null).
   *  A query that fails is left out (that series starts empty). Proxmox nodes fill in as samples arrive. */
  async prefill(len: number): Promise<Partial<Record<FastKey, (number | null)[]>>> {
    if (!PROM()) return {};
    const end = Math.floor(Date.now() / 1000), start = end - (len - 1);
    const out: Partial<Record<FastKey, (number | null)[]>> = {};
    await Promise.all((Object.entries(FAST_OF()) as [FastKey, string][]).map(async ([k, q]) => {
      try {
        const j = await getJSON(`${PROM()}/api/v1/query_range?query=${encodeURIComponent(q)}&start=${start}&end=${end}&step=1`, { timeout: 5000 });
        const byT = new Map<number, number>((j.data.result[0]?.values ?? []).map(([t, v]: [number, string]) => [Math.round(t), Number(v)]));
        out[k] = Array.from({ length: len }, (_, i) => tidy(byT.get(start + i)));
      } catch { /* left out */ }
    }));
    return out;
  }
}
