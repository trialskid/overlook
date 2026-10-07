// Prometheus (PROMETHEUS_URL): the read-only helpers the prom-* adapters share
// (prom-infra, prom-media, prom-home, prom-jobs). Every call is a GET to /api/v1/query or /query_range. Non-finite samples (NaN, ±Inf) are dropped,
// so they read as missing.
// Errors are short ('Prometheus not answering …', 'Prometheus HTTP 400: …'): the URL holds the whole
// PromQL batch, and the message ends up on the page (Health → Sources).
import { getBuffer, redact } from '../http.ts';
import { env, trimUrl } from './types.ts';

const BASE = () => trimUrl(env('PROMETHEUS_URL') || 'http://localhost:9090');
export type Row = { m: Record<string, string>; v: number };
export type Series = { m: Record<string, string>; v: [number, number][] };
type PromError = Error & { badQuery?: boolean };

async function api(path: string, params: Record<string, string>, timeout: number): Promise<any> {
  const url = `${BASE()}/api/v1/${path}?${new URLSearchParams(params)}`;
  let r: Awaited<ReturnType<typeof getBuffer>>;
  try { r = await getBuffer(url, { timeout }); }
  catch (e) { throw new Error(`Prometheus not answering: ${String((e as Error).message).split(redact(url)).join('…').slice(0, 200)}`); }
  let j: any = null;
  try { j = JSON.parse(r.body.toString('utf8')); } catch { /* not JSON: a proxy page */ }
  if (r.status === 200 && j?.status === 'success') return j.data;
  const err: PromError = new Error(`Prometheus HTTP ${r.status}: ${j?.error ? String(j.error).slice(0, 200) : 'not a Prometheus API answer'}`);
  err.badQuery = r.status === 400 || r.status === 422; // the PromQL is wrong, not Prometheus
  throw err;
}

export async function query(q: string, timeout = 6000): Promise<Row[]> {
  const d = await api('query', { query: q }, timeout);
  return d.result.map((r: any) => ({ m: r.metric, v: Number(r.value[1]) })).filter((r: Row) => Number.isFinite(r.v));
}
/** `seconds` back from `end` (epoch s, default now) at `step`; points sit at exactly end - seconds + i·step. */
export async function range(q: string, seconds: number, step: number, end = Math.floor(Date.now() / 1000), timeout = 8000): Promise<Series[]> {
  const d = await api('query_range', { query: q, start: String(end - seconds), end: String(end), step: String(step) }, timeout);
  return d.result.map((r: any) => ({ m: r.metric, v: r.values.map(([t, v]: [number, string]) => [t, Number(v)]).filter(([, v]: [number, number]) => Number.isFinite(v)) }));
}

const bad = new Map<string, { until: number; why: string }>(); // expression Prometheus rejected → when to try again, and why
/** Several queries in one round trip, each result tagged with label k = its key. If Prometheus rejects the batch
 *  (a broken expression), each query is asked alone; the broken ones go missing and sit out the batch for 10 min,
 *  so one typo in homelab.json costs only its own key. Keys that failed (or are sitting out) are listed in
 *  `failed` with the reason, so a caller can tell "no series" from "the query broke". Prometheus not answering throws. */
async function batch<T extends { m: Record<string, string> }>(qs: Record<string, string>, run: (q: string) => Promise<T[]>): Promise<{ out: Record<string, T[]>; failed: Record<string, string> }> {
  const now = Date.now(), out: Record<string, T[]> = {}, failed: Record<string, string> = {};
  const keys = Object.keys(qs).filter(k => { const b = bad.get(qs[k]); if (b && b.until > now) { failed[k] = b.why; return false; } return true; });
  if (!keys.length) return { out, failed };
  const tag = (k: string) => `label_replace(${qs[k]}, "k", "${k}", "", "")`;
  const put = (rows: T[]) => { for (const r of rows) { const { k, ...m } = r.m; (out[k] ??= []).push({ ...r, m }); } };
  try { put(await run(keys.map(tag).join(' or '))); return { out, failed }; }
  catch (e) { if (!(e as PromError).badQuery) throw e; }
  const res = await Promise.allSettled(keys.map(k => run(tag(k))));
  res.forEach((r, i) => {
    if (r.status === 'fulfilled') return put(r.value);
    const why = String((r.reason as Error).message).replace(/^Prometheus HTTP \d+: /, '').slice(0, 120);
    if ((r.reason as PromError).badQuery) bad.set(qs[keys[i]], { until: now + 10 * 60e3, why });
    failed[keys[i]] = why;
    console.warn(`[prometheus] ${keys[i]}: ${(r.reason as Error).message}`);
  });
  if (res.every(r => r.status === 'rejected')) throw (res[0] as PromiseRejectedResult).reason;
  return { out, failed };
}

/** Labelled rows for several instant queries, by key (a key with no series is absent), plus the keys whose query failed. */
export const rowsAndErrors = (qs: Record<string, string>) => batch(qs, q => query(q));
/** Labelled rows for several instant queries, by key (a key with no series is absent). */
export const rows = async (qs: Record<string, string>) => (await rowsAndErrors(qs)).out;
/** Range series for several queries, by key; see range() for where the points sit. */
export const ranges = async (qs: Record<string, string>, seconds: number, step: number, end = Math.floor(Date.now() / 1000)) =>
  (await batch(qs, q => range(q, seconds, step, end))).out;

/** Every active scrape target with its health, plus the configured scrape pools that have no target at all
 *  (/api/v1/scrape_pools needs Prometheus 2.42+; without it only the active targets are known). */
export async function targets(timeout = 6000): Promise<{ job: string; instance: string; up: boolean; error: string | null }[]> {
  const [t, pools] = await Promise.all([api('targets', { state: 'active' }, timeout), api('scrape_pools', {}, timeout).catch(() => null)]);
  const list = (t.activeTargets ?? []).map((x: any) => ({
    job: String(x.labels?.job ?? x.scrapePool ?? ''), instance: String(x.labels?.instance ?? ''), up: x.health === 'up',
    error: x.health === 'up' ? null : redact(String(x.lastError || x.health || 'down')).slice(0, 160),
  }));
  const seen = new Set(list.map((x: { job: string }) => x.job));
  for (const p of pools?.scrapePools ?? []) if (!seen.has(p)) list.push({ job: String(p), instance: '', up: false, error: 'no target (none discovered)' });
  return list;
}
/** Scalars: the first row's value per key, undefined when the series is missing. Aggregate (max/sum/min) to be sure. */
export async function many(qs: Record<string, string>): Promise<Record<string, number | undefined>> {
  const r = await rows(qs), out: Record<string, number | undefined> = {};
  for (const k of Object.keys(qs)) out[k] = r[k]?.[0]?.v;
  return out;
}

// small converters shared by the adapters: a missing series stays null, never a default
export const orNull = (v: number | undefined) => (v === undefined ? null : v);
export const isOne = (v: number | undefined) => (v === undefined ? null : v === 1);
export const toMs = (sec: number | undefined) => (sec === undefined || sec <= 0 ? null : Math.round(sec * 1000));
