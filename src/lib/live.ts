// SSE client: one EventSource for the whole app. Keeps the latest Snapshot and 40-sample ring
// buffers of the fast series (per-host CPU, WAN in/out, qBittorrent down/up). A null sample stays
// in the buffer as a gap, so a source that stops answering reads '—' instead of its last value, and
// every second without a tick (the server or the link gone) adds a null too, so nothing freezes.
//
// The server sends a snapshot only when it changed (at least once a minute); every tick says when the
// snapshot this page holds was last confirmed current (snapAt), so STALE means "the server stopped
// rebuilding", never "nothing changed".
//
// Watchdog (every 1 s): no tick for 5 s = offline. The browser gives up for good on a non-200
// reconnect (e.g. Caddy's 502 during a redeploy), so a CLOSED stream or 20 s of silence gets a
// fresh EventSource with backoff 1 → 30 s, and coming back to the tab or the network reconnects
// at once. A new server build reloads the page (at most once a minute) so the bundle matches.
import { useEffect, useState } from 'react';
import { SERIES_LEN, type Hello, type History, type Snapshot, type SourceView, type Tick } from '../../shared/types.ts';

export interface Live {
  snapshot: Snapshot | null; history: History;
  /** a tick arrived in the last 5 s */
  connected: boolean;
  /** client time of the last tick */
  lastTick: number;
  /** when the snapshot on screen was last confirmed current by the server (tick.snapAt, else snapshot.at), on the
   *  client's clock (server skew removed); 0 before the first snapshot */
  lastSnapshotAt: number;
  /** Health → Sources heartbeat (review 3c): per source, when its polls were answered (its lastOk each time it moved
   *  on), server time, the last 3 minutes. Noted by the page as snapshots arrive; not part of the Snapshot. */
  beats: Beats;
}
export type Beats = Record<string, number[]>;

/** client clock minus server clock (ms), from the last tick; serverNow() is "now" as the server's ages count it */
let skew = 0;
export const serverNow = () => Date.now() - skew;
/** a client time (e.g. Live.lastTick) on the server's clock */
export const toServer = (clientMs: number) => clientMs - skew;
export type LinkState = 'live' | 'partial' | 'stale' | 'offline';

/** GAP_MS: a second with no tick after this is drawn as a gap (one null per missed second) */
const OFFLINE_MS = 5_000, SILENT_MS = 20_000, STALE_SNAP_MS = 25_000, RELOAD_GAP_MS = 60_000, GAP_MS = 2_500;
const emptyHistory = (): History => ({ cpu: {}, wanIn: [], wanOut: [], qbDl: [], qbUl: [], nzDl: [] });
const BEATS_KEEP = 180_000;
/** One beat per answered poll: a source's lastOk joins its list when it's newer than the last one noted; only while
 *  the source counts as answering, and older than BEATS_KEEP drops out. */
export function addBeats(prev: Beats, sources: SourceView[], now: number): Beats {
  const next: Beats = {};
  for (const s of sources) {
    const old = (prev[s.name] ?? []).filter(t => t > now - BEATS_KEEP), at = old[old.length - 1];
    const answered = (s.conn === 'ok' || s.conn === 'mock') && s.lastOk != null && s.lastOk > now - BEATS_KEEP && (at == null || s.lastOk > at);
    next[s.name] = answered ? [...old, s.lastOk!] : old;
  }
  return next;
}
const push = (a: (number | null)[] | undefined, v: number | null | undefined) => {
  const b = (a ?? []).slice(); b.push(v == null || !Number.isFinite(v) ? null : v);
  return b.length > SERIES_LEN ? b.slice(-SERIES_LEN) : b;
};

/** LIVE: ticks and a confirmed snapshot. PARTIAL: some sources stale. STALE: the server hasn't confirmed its snapshot
 *  for 25 s (its rebuild loop is failing). OFFLINE: no ticks for 5 s. STALE and OFFLINE freeze the page (frozen()). */
export function linkState(l: Live, now = Date.now()): LinkState {
  if (!l.connected) return 'offline';
  if (!l.snapshot || now - l.lastSnapshotAt > STALE_SNAP_MS) return 'stale';
  return l.snapshot.fresh.ok ? 'live' : 'partial';
}
export const LINK_LABEL: Record<LinkState, string> = { live: 'LIVE', partial: 'PARTIAL', stale: 'STALE', offline: 'OFFLINE' };
/** what's on screen is from the past: the page dims it and says since when */
export const frozen = (st: LinkState) => st === 'offline' || st === 'stale';
/** The header chip. MOCK DATA and SIMULATED take LIVE's place, so made-up data never reads as live. */
export function linkChip(st: LinkState, snap: Snapshot | null) {
  if (!frozen(st) && snap?.mock) return { label: 'MOCK DATA', color: 'var(--accent-2)', pulse: false };
  if (!frozen(st) && snap?.simulated) return { label: 'SIMULATED', color: 'var(--warn)', pulse: false };
  return { label: LINK_LABEL[st], color: LINK_COLOR[st], pulse: st === 'live' };
}
export const LINK_COLOR: Record<LinkState, string> = { live: 'var(--ok)', partial: 'var(--warn)', stale: 'var(--warn)', offline: 'var(--danger)' };

/** Reload once the server runs a different build; remembered across the reload so a stuck cache can't loop faster than once a minute. */
function reloadFor(build: string) {
  let lastAt = 0;
  try { lastAt = Number(sessionStorage.getItem('cc-reload-at')) || 0; } catch { /* storage blocked */ }
  if (Date.now() - lastAt < RELOAD_GAP_MS) return false;
  try { sessionStorage.setItem('cc-reload-at', String(Date.now())); } catch { /* storage blocked */ }
  console.info(`[cc] new build ${build}, reloading`);
  location.reload();
  return true;
}

export function useLive(): Live {
  const [live, setLive] = useState<Live>({ snapshot: null, history: emptyHistory(), connected: false, lastTick: 0, lastSnapshotAt: 0, beats: {} });
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('simulateIncident') === '1' ? '?simulateIncident=1' : '';
    let es: EventSource | null = null, retryT: ReturnType<typeof setTimeout> | undefined, backoff = 1_000;
    let openedAt = 0, lastTick = 0, lastPush = 0, firstBuild: string | null = null, pendingBuild: string | null = null, dead = false;

    const checkBuild = (b: string | undefined) => {
      if (!b) return;
      if (firstBuild == null) { firstBuild = b; return; }
      if (b === firstBuild) { pendingBuild = null; return; }
      pendingBuild = b;
      if (document.visibilityState === 'visible') reloadFor(b);
    };
    const onSnapshot = (s: Snapshot) => { checkBuild(s.build); return { snapshot: s, lastSnapshotAt: s.at + skew }; };

    const connect = () => {
      clearTimeout(retryT); retryT = undefined;
      es?.close();
      const src = es = new EventSource(`/api/stream${q}`);
      openedAt = Date.now();
      src.addEventListener('hello', e => {
        const h: Hello = JSON.parse((e as MessageEvent).data);
        checkBuild(h.build);
        lastTick = lastPush = Date.now(); backoff = 1_000;
        const next = onSnapshot(h.snapshot);
        setLive(l => ({ ...next, history: h.history, connected: true, lastTick, beats: addBeats(l.beats, h.snapshot.sources, h.snapshot.at) }));
      });
      src.addEventListener('snapshot', e => { const s: Snapshot = JSON.parse((e as MessageEvent).data); setLive(l => ({ ...l, ...onSnapshot(s), beats: addBeats(l.beats, s.sources, s.at) })); });
      src.addEventListener('tick', e => {
        const t: Tick = JSON.parse((e as MessageEvent).data);
        lastTick = lastPush = Date.now(); skew = lastTick - t.t; backoff = 1_000;
        setLive(l => {
          const cpu: History['cpu'] = { ...l.history.cpu };
          for (const id of new Set([...Object.keys(cpu), ...Object.keys(t.cpu)])) cpu[id] = push(cpu[id], t.cpu[id]);
          return {
            ...l, connected: true, lastTick, lastSnapshotAt: l.snapshot ? Math.max(l.snapshot.at, t.snapAt ?? 0) + skew : 0,
            history: { cpu, wanIn: push(l.history.wanIn, t.wanIn), wanOut: push(l.history.wanOut, t.wanOut), qbDl: push(l.history.qbDl, t.qbDl), qbUl: push(l.history.qbUl, t.qbUl), nzDl: push(l.history.nzDl, t.nzDl) },
          };
        });
      });
      src.addEventListener('ping', () => { /* keeps proxies from idling the stream; ticks are the liveness signal */ });
      src.onerror = () => {
        // a signed-out device (expired or revoked session): go to the login page instead of showing OFFLINE
        void fetch('/api/status', { cache: 'no-store' }).then(r => { if (r.status === 401) location.href = '/login'; }, () => {});
        if (src.readyState === EventSource.CLOSED) retry();
      };
    };
    const retry = () => {
      if (dead || retryT) return;
      es?.close(); es = null;
      retryT = setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
    const quiet = () => Date.now() - lastTick > OFFLINE_MS;
    const kick = () => { if (quiet()) { backoff = 1_000; connect(); } };

    const watchdog = setInterval(() => {
      const now = Date.now(), off = quiet();
      // seconds with no tick are gaps, never the last value repeated
      const missed = lastPush && now - lastTick > GAP_MS ? Math.min(SERIES_LEN, Math.floor((now - lastPush) / 1000)) : 0;
      if (missed > 0) lastPush += missed * 1000;
      setLive(l => {
        if (l.connected === !off && !missed) return l;
        if (!missed) return { ...l, connected: !off };
        const gaps = (a: (number | null)[]) => { let b = a; for (let i = 0; i < missed; i++) b = push(b, null); return b; };
        const h = l.history;
        return { ...l, connected: !off, history: { cpu: Object.fromEntries(Object.entries(h.cpu).map(([k, a]) => [k, gaps(a)])), wanIn: gaps(h.wanIn), wanOut: gaps(h.wanOut), qbDl: gaps(h.qbDl), qbUl: gaps(h.qbUl), nzDl: gaps(h.nzDl) } };
      });
      if (es && (es.readyState === EventSource.CLOSED || now - Math.max(lastTick, openedAt) > SILENT_MS)) retry();
    }, 1_000);
    const onVisible = () => { if (document.visibilityState !== 'visible') return; if (pendingBuild && reloadFor(pendingBuild)) return; kick(); };
    document.addEventListener('visibilitychange', onVisible);
    addEventListener('online', kick);
    connect();
    return () => {
      dead = true; clearInterval(watchdog); clearTimeout(retryT); es?.close();
      document.removeEventListener('visibilitychange', onVisible); removeEventListener('online', kick);
    };
  }, []);
  return live;
}

/** Re-render every second (clock, ages). */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

export function useWidth() {
  const [w, setW] = useState(() => innerWidth);
  useEffect(() => { const f = () => setW(innerWidth); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  return w;
}
