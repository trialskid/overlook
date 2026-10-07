// Overlook backend: holds every key, polls the adapters, and pushes to the page over SSE.
//   GET /api/snapshot      current Snapshot (JSON)
//   GET /api/stream        SSE: `hello` {snapshot, history, build}, then `tick` every 1 s (with the server's snapshot time,
//                          so the page can tell a stuck rebuild from an unchanged one) and `snapshot` when it changed (at
//                          least every 60 s). A client that stops reading is skipped, then dropped (it reconnects).
//   GET /api/status        build, rebuild health and per-source freshness (no secrets)
//   GET /api/poster/:id    Plex artwork via Tautulli (only ids the backend handed out)
//   GET/POST /login   sign in once per device (when CC_LOGIN_BCRYPT is set; see server/auth.ts)
//   GET/PUT /api/links     the Links tab's list; PUT is the site's only write (server/links.ts, DATA_DIR/links.json)
// The server also keeps its own files in DATA_DIR: Kuma's strips, the ntfy feed, and Library health's daily samples (server/trend.ts).
//   GET /healthz           'ok', or 503 once the snapshot loop or every source has been failing for 2 min
// MOCK=1 serves sample data. Dev flag: ?simulateIncident=1 (or SIMULATE_INCIDENT=1).
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { gates } from './gates.ts';
import { linksRoutes, readLinks } from './links.ts';
import { LibraryTrend, libraryCounts } from './trend.ts';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { derive } from './derive.ts';
import { applyIncident } from './incident.ts';
import { Guard, Hub, healthReason } from './hub.ts';
import { mockLibraryHistory, mockRaw, MockSampler } from './adapters/mock.ts';
import { proxmox } from './adapters/proxmox.ts';
import { promInfra } from './adapters/prom-infra.ts';
import { promMedia } from './adapters/prom-media.ts';
import { promHome } from './adapters/prom-home.ts';
import { promJobs } from './adapters/prom-jobs.ts';
import { promOps } from './adapters/prom-ops.ts';
import { promChecks } from './adapters/prom-checks.ts';
import { kuma, saveKumaHistory } from './adapters/kuma.ts';
import { grafana } from './adapters/grafana.ts';
import { ntfy, saveNtfyActivity } from './adapters/ntfy.ts';
import { probes } from './adapters/probes.ts';
import { devices } from './adapters/devices.ts';
import { tautulli, bazarr, seerr, immich, prowlarr, chaptarr, plex, wud, weather, mac, fetchPoster } from './adapters/apps.ts';
import { LiveSampler, tidy } from './live.ts';
import { config, watchConfig } from './config.ts';
import { emptyRaw, type Sample } from './raw.ts';
import { SERIES_LEN, type History, type Snapshot, type Tick } from '../shared/types.ts';
import type { Adapter } from './adapters/types.ts';
import { adapterEnabled, moduleStates, unknownModules } from './modules.ts';

// A bad answer or a bug in one place must not take the dashboard down: log it and keep serving.
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e));

const PORT = Number(process.env.PORT || 8787);
const PROD = process.env.NODE_ENV === 'production';
const MOCK = process.env.MOCK === '1';
const ALLOW_SIM = !PROD || process.env.ALLOW_SIMULATE === '1';
const FORCE_INCIDENT = process.env.SIMULATE_INCIDENT === '1';
const INDEX = 'dist/web/index.html';
/** Changes with every deploy (the page's index.html names the hashed bundles); open tabs reload when it differs. */
const BUILD = PROD && fs.existsSync(INDEX) ? createHash('sha1').update(fs.readFileSync(INDEX)).digest('hex').slice(0, 12) : 'dev';

const ADAPTERS: Adapter[] = [proxmox, promInfra, promMedia, promHome, promJobs, promOps, promChecks, kuma, grafana, ntfy, probes, devices, tautulli, bazarr, seerr, immich, prowlarr, chaptarr, plex, wud, weather, mac];
/** Re-read on every use, so a config reload that changes `modules` takes effect within one round. */
const modules = () => moduleStates(config, ADAPTERS, MOCK ? () => true : a => a.configured());
const hub = new Hub(ADAPTERS, { mock: MOCK, dev: !PROD, enabled: a => adapterEnabled(a, modules()) });
const typos = unknownModules(config);
if (typos.length) console.warn(`[config] not modules, ignored: ${typos.join(', ')}`);
// a reload is dry-run through derive() on empty and on mock data first: a file that parses but would make every
// rebuild throw (an entry missing a field) keeps the old config
watchConfig(next => {
  for (const raw of [emptyRaw(), mockRaw(next)]) derive(raw, [], { mock: false, incident: false, build: 'check' }, next);
});

// ---- adapters: one part each, replaced on every good answer; compose() drops the ones past their max age
let firstRound: Promise<unknown> = Promise.resolve();
if (!MOCK) {
  for (const a of ADAPTERS) setInterval(() => void hub.tick(a), a.every);
  firstRound = Promise.allSettled(ADAPTERS.map(a => hub.tick(a)));
}

// ---- snapshots: guarded, so a throw keeps the last good one serving (its `at` ages, and /healthz notices)
const normal = new Guard<Snapshot>('rebuild');
const incident = new Guard<Snapshot>('rebuild:incident');
// Library health's 7-day change (review finding 17): one sample a day, kept in DATA_DIR/library-history.json; MOCK
// keeps a made-up week in memory instead and never touches the file
const trend = new LibraryTrend(MOCK ? null : path.join(process.env.DATA_DIR?.trim() || 'data', 'library-history.json'), MOCK ? mockLibraryHistory() : {});
function rebuild() {
  const now = Date.now();
  const build = (inc: boolean) => () => {
    const raw = MOCK ? mockRaw() : hub.compose(now), sources = hub.sourceViews(now);
    const counts = libraryCounts(raw);
    // sampled from the normal build only, and only what answered on its last poll (the incident build shares the samples)
    if (!inc) trend.record(libraryCounts(raw, n => sources.some(s => s.name === n && (s.conn === 'ok' || s.conn === 'mock'))), now);
    return derive(inc ? applyIncident(raw) : raw, sources, { mock: MOCK, incident: inc, build: BUILD, links: readLinks(config), delta7: trend.delta7(counts, now), modules: modules() });
  };
  normal.run(build(false), now);
  if (ALLOW_SIM || FORCE_INCIDENT) incident.run(build(true), now);
}
const current = (inc: boolean) => ((inc || FORCE_INCIDENT) && incident.last) || normal.last;

// ---- fast series: ring buffers of SERIES_LEN, 1 sample/s; null = no data that second (a gap, never the last value)
const sampler: { sample(): Sample | Promise<Sample> } = MOCK ? new MockSampler() : new LiveSampler();
const history: History = { cpu: Object.fromEntries(config.hosts.map(h => [h.id, []])), wanIn: [], wanOut: [], qbDl: [], qbUl: [], nzDl: [] };
const push = (a: (number | null)[], v: number | null | undefined) => { a.push(tidy(v)); if (a.length > SERIES_LEN) a.splice(0, a.length - SERIES_LEN); };
const EMPTY: Sample = { cpu: {}, wanIn: null, wanOut: null, qbDl: null, qbUl: null, nzDl: null };
async function sample(): Promise<Tick> {
  let s: Sample;
  try { s = await sampler.sample(); } catch (e) { console.warn(`[live] ${(e as Error).message}`); s = EMPTY; }
  const cpu: Record<string, number | null> = {};
  for (const h of config.hosts) { cpu[h.id] = tidy(s.cpu[h.id]); push((history.cpu[h.id] ??= []), cpu[h.id]); } // ??= : a host added by a config reload
  push(history.wanIn, s.wanIn); push(history.wanOut, s.wanOut); push(history.qbDl, s.qbDl); push(history.qbUl, s.qbUl); push(history.nzDl, s.nzDl);
  return { t: Date.now(), cpu, wanIn: tidy(s.wanIn), wanOut: tidy(s.wanOut), qbDl: tidy(s.qbDl), qbUl: tidy(s.qbUl), nzDl: tidy(s.nzDl) };
}
if (MOCK) for (let i = 0; i < SERIES_LEN; i++) await sample();
else {
  // the sparklines start full when Prometheus answers in time; startup never waits on it for more than 8 s
  const pre = await Promise.race([(sampler as LiveSampler).prefill(SERIES_LEN), new Promise<Awaited<ReturnType<LiveSampler['prefill']>>>(r => setTimeout(() => r({}), 8000))]);
  for (const [k, v] of Object.entries(pre)) if (v && k.startsWith('cpu:')) history.cpu[k.slice(4)] = v;
  for (const k of ['wanIn', 'wanOut', 'qbDl', 'qbUl', 'nzDl'] as const) if (pre[k]) history[k] = pre[k];
}

// ---- SSE clients. Every payload is serialised once per round, not once per client. A write the socket hasn't
// taken yet stays counted (pending): ticks and pings skip such a client, and one still stuck on its last write two
// snapshot rounds later (20 s) is dropped, so a phone that stops reading can't grow the heap.
/** hash/sentAt: the last snapshot sent; snapAt: the `at` of the newest snapshot this client is known to hold the content of */
type Client = { incident: boolean; stream: SSEStreamingApi; pending: number; stuck: number; hash: string | null; sentAt: number; snapAt: number | null };
const clients = new Set<Client>();
const SNAP_EVERY = 60_000, STUCK_ROUNDS = 2;
const viewers = () => { if (sampler instanceof LiveSampler) sampler.setViewers(clients.size); };
function write(c: Client, event: string, data: string) {
  c.pending++;
  void c.stream.writeSSE({ event, data }).catch(() => {}).finally(() => { c.pending--; });
}
function drop(c: Client) { clients.delete(c); viewers(); c.stream.abort(); }
/** per variant (normal / incident): the JSON and a hash of it without `at`, so an unchanged rebuild isn't resent */
function encoder<T>(make: (inc: boolean) => T | null) {
  const cache = new Map<boolean, T | null>();
  return (inc: boolean) => { if (!cache.has(inc)) cache.set(inc, make(inc)); return cache.get(inc)!; };
}
/** The hash leaves out `at` and the ages derive counts from it (the page adds the time since `at` itself), so an
 *  unchanged rebuild isn't resent; anything else that moved (a value, a poll time, a status) is. */
const stable = (s: Snapshot) => JSON.stringify({
  ...s, at: 0, sources: s.sources.map(x => ({ ...x, ageSec: 0 })), spotlight: s.spotlight && { ...s.spotlight, probeAgeSec: 0 },
  health: { ...s.health, monitors: s.health.monitors.map(m => ({ ...m, downMin: 0 })), unmapped: s.health.unmapped.map(m => ({ ...m, downMin: 0 })) },
});
const snapPayload = (inc: boolean) => {
  const s = current(inc);
  return s ? { at: s.at, json: JSON.stringify(s), hash: createHash('sha1').update(stable(s)).digest('hex') } : null;
};
function broadcast() {
  const now = Date.now(), enc = encoder(snapPayload);
  for (const c of clients) {
    const p = enc(c.incident);
    if (!p) continue;
    if (p.hash === c.hash && now - c.sentAt < SNAP_EVERY) { c.snapAt = p.at; continue; } // unchanged: still current
    if (c.pending > 0) { if (++c.stuck >= STUCK_ROUNDS) drop(c); continue; }
    c.stuck = 0; c.hash = p.hash; c.sentAt = now; c.snapAt = p.at;
    write(c, 'snapshot', p.json);
  }
}
setInterval(async () => {
  const t = await sample();
  // snapAt: when the snapshot this client holds was last confirmed current (sent, or rebuilt unchanged)
  const json = JSON.stringify(t).slice(0, -1);
  for (const c of clients) if (c.pending === 0) write(c, 'tick', `${json},"snapAt":${c.snapAt ?? 'null'}}`);
}, 1000);
setInterval(() => { rebuild(); broadcast(); }, 10_000);
// First snapshot once the first round has answered (3 s at most), so a restart doesn't flash every source
// as failing; until then /api/snapshot is 503 'starting' and new streams wait. Slower sources join when they answer.
const startup = new Promise(r => setTimeout(r, 3000));
void Promise.race([firstRound, startup]).then(() => { rebuild(); broadcast(); });
void firstRound.then(() => { rebuild(); broadcast(); });

// ---- app
const app = new Hono();
gates(app); // method gate (read-only but for login/logout and PUT /api/links), security headers, login (server/gates.ts)
linksRoutes(app, { cfg: () => config, onSave: () => { rebuild(); broadcast(); } }); // the Links tab's editor: every open page sees a save at once
const wantsIncident = (q: string | undefined) => ALLOW_SIM && q === '1';
app.get('/healthz', c => { const why = healthReason(Date.now(), hub, normal.lastOk); return why ? c.text(why, 503) : c.text('ok'); });
app.get('/api/status', c => {
  c.header('Cache-Control', 'no-store');
  return c.json({ build: BUILD, mock: MOCK, lastRebuildOk: normal.lastOk, lastRebuildError: normal.lastError, clients: clients.size, sources: hub.sourceViews() });
});
app.get('/api/snapshot', c => {
  c.header('Cache-Control', 'no-store');
  const s = current(wantsIncident(c.req.query('simulateIncident')));
  return s ? c.json(s) : c.json({ error: 'starting' }, 503);
});
app.get('/api/poster/:id', async c => {
  const r = await fetchPoster(c.req.param('id')).catch(() => null);
  if (!r) return c.body(null, 404);
  c.header('Content-Type', r.type); c.header('Cache-Control', 'private, max-age=86400');
  return c.body(new Uint8Array(r.body));
});
app.get('/api/stream', c => streamSSE(c, async stream => {
  const client: Client = { incident: wantsIncident(c.req.query('simulateIncident')), stream, pending: 0, stuck: 0, hash: null, sentAt: 0, snapAt: null };
  let open = true;
  stream.onAbort(() => { open = false; clients.delete(client); viewers(); });
  while (open && !current(client.incident)) await stream.sleep(1000); // only before the first snapshot exists
  if (!open) return;
  const p = snapPayload(client.incident)!;
  client.hash = p.hash; client.sentAt = Date.now(); client.snapAt = p.at;
  write(client, 'hello', `{"snapshot":${p.json},"history":${JSON.stringify(history)},"build":${JSON.stringify(BUILD)}}`);
  clients.add(client); viewers();
  while (open && clients.has(client)) { await stream.sleep(15_000); if (open && client.pending === 0) write(client, 'ping', ''); }
}));
app.get('/api/*', c => c.json({ error: 'not found' }, 404));

if (PROD && fs.existsSync('dist/web')) {
  // hashed bundles: immutable, but only a real file; a missing one is a 404, never index.html cached for a year
  app.use('/assets/*', async (c, next) => { await next(); if (c.res.status === 200) c.header('Cache-Control', 'public, max-age=31536000, immutable'); });
  app.use('/assets/*', serveStatic({ root: './dist/web' }));
  app.get('/assets/*', c => c.body(null, 404));
  // index.html: always revalidate, so a deploy is picked up on the next load
  app.use('*', async (c, next) => { await next(); if (c.res.headers.get('Content-Type')?.startsWith('text/html')) c.header('Cache-Control', 'no-cache'); });
  app.use('*', serveStatic({ root: './dist/web' }));
  app.get('*', serveStatic({ path: `./${INDEX}` }));
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: process.env.HOST || '0.0.0.0' }, i => console.log(`overlook ${BUILD} on :${i.port} (${MOCK ? 'mock adapters' : `live: ${ADAPTERS.filter(a => hub.enabled(a) && a.configured()).map(a => a.name).join(', ') || 'nothing configured'}`}; modules on: ${Object.entries(modules()).filter(([, v]) => v !== 'off').map(([k, v]) => v === 'on' ? k : `${k} (not connected)`).join(', ') || 'none'})`));
server.on('error', e => { console.error(`[server] ${e.message}`); process.exit(1); }); // e.g. port in use: nothing to serve, so exit
// keep Kuma's strips and the ntfy feed across restarts (sync or async saves; give them 3 s at most)
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, async () => {
  if (!MOCK) await Promise.race([
    Promise.allSettled([saveKumaHistory, saveNtfyActivity].map(async save => save()))
      .then(r => r.forEach(x => x.status === 'rejected' && console.error(`[shutdown] ${(x.reason as Error)?.message ?? x.reason}`))),
    new Promise(r => setTimeout(r, 3000)),
  ]);
  server.close(); process.exit(0);
});
