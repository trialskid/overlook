// App APIs, each with its own read-only key from .env. GET only. A missing key = "not connected".
import { getBuffer, getJSON, getText, tcpUp } from '../http.ts';
import { config } from '../config.ts';
import { env, trimUrl, type Adapter } from './types.ts';
import type { Status } from '../../shared/types.ts';
import type { Raw } from '../raw.ts';

// ---- Tautulli: now playing, library counts, recently added (+ poster proxy)
const T = () => trimUrl(env('TAUTULLI_URL'));
const tcall = <X = any>(cmd: string, extra = '') => getJSON<{ response: { data: X } }>(`${T()}/api/v2?apikey=${env('TAUTULLI_KEY')}&cmd=${cmd}${extra}`).then(r => r.response.data);
/** Opaque poster ids handed to the page → the Plex image path behind them. Only these can be fetched.
 *  Capped (oldest dropped): a page only ever shows the current few, and the map must not grow forever. */
const posters = new Map<string, { img: string; key: string }>();
const POSTERS_MAX = 200;
const posterId = (img: string | undefined, key: string | undefined) => {
  if (!img || !key) return undefined;
  const id = `${key}-${Buffer.from(img).toString('base64url').slice(-10)}`;
  posters.delete(id); posters.set(id, { img, key }); // re-insert: Map order is age order
  while (posters.size > POSTERS_MAX) posters.delete(posters.keys().next().value!);
  return id;
};
/** The session to feature: one that's playing beats buffering, which beats paused. */
const STATE_RANK: Record<string, number> = { playing: 0, buffering: 1, paused: 2 };
export async function fetchPoster(id: string) {
  const p = posters.get(id);
  if (!p || !env('TAUTULLI_KEY')) return null;
  const r = await getBuffer(`${T()}/api/v2?apikey=${env('TAUTULLI_KEY')}&cmd=pms_image_proxy&img=${encodeURIComponent(p.img)}&rating_key=${p.key}&width=300&height=450&fallback=poster`, { timeout: 8000 });
  return r.status === 200 && r.type.startsWith('image/') ? r : null;
}

/** The line under a Recently added poster (review finding 16): 'S2E5' for an episode, 'Season 2' for a season, 'New
 *  show' for a whole show, the year for a movie (the title above already names the show); nothing otherwise. */
export function recentSub(r: { media_type?: unknown; media_index?: unknown; parent_media_index?: unknown; year?: unknown }): string | undefined {
  const n = (v: unknown) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  const season = n(r.parent_media_index), ep = n(r.media_index), year = n(r.year);
  switch (r.media_type) {
    case 'episode': return season != null && ep != null ? `S${season}E${ep}` : undefined;
    case 'season': return ep != null ? `Season ${ep}` : undefined;
    case 'show': return 'New show';
    case 'movie': return year != null ? String(year) : undefined;
    default: return undefined;
  }
}

export const tautulli: Adapter = {
  name: 'tautulli', label: 'Tautulli', every: 30_000, needs: 'the Tautulli URL and API key (TAUTULLI_URL, TAUTULLI_KEY)', configured: () => !!(env('TAUTULLI_URL') && env('TAUTULLI_KEY')),
  async run() {
    const [act, libs, rec] = await Promise.all([tcall<any>('get_activity'), tcall<any[]>('get_libraries'), tcall<any>('get_recently_added', '&count=7')]);
    const sessions: any[] = act.sessions ?? [];
    const s = [...sessions].sort((a, b) => (STATE_RANK[a.state] ?? 3) - (STATE_RANK[b.state] ?? 3))[0];
    const count = (type: string) => libs.filter(l => l.section_type === type).reduce((a, l) => a + Number(l.count || 0), 0);
    return {
      tautulli: {
        streams: Number(act.stream_count ?? sessions.length),
        nowPlaying: s ? {
          title: s.grandparent_title || s.title,
          sub: s.media_type === 'episode' ? `S${s.parent_media_index}·E${s.media_index} ${s.title} · ${s.stream_video_full_resolution ?? ''} ${s.transcode_decision ?? ''}`.trim() : `${s.year ?? ''} · ${s.stream_video_full_resolution ?? ''} ${s.transcode_decision ?? ''}`.trim(),
          user: s.friendly_name || s.user, progress: Number(s.progress_percent || 0),
          poster: posterId(s.grandparent_thumb || s.thumb, s.grandparent_rating_key || s.rating_key), state: String(s.state ?? ''),
        } : null,
        others: Math.max(0, sessions.length - 1),
        recent: (rec.recently_added ?? []).map((r: any) => ({
          title: r.media_type === 'episode' ? r.grandparent_title : r.media_type === 'season' ? r.parent_title : r.title,
          poster: posterId(r.media_type === 'episode' ? r.grandparent_thumb : r.media_type === 'season' ? (r.parent_thumb || r.thumb) : r.thumb, r.media_type === 'episode' ? r.grandparent_rating_key : r.rating_key),
          ...(recentSub(r) ? { sub: recentSub(r) } : {}),
          ...(r.rating_key != null && r.rating_key !== '' ? { key: String(r.rating_key) } : {}),
          addedAt: Number(r.added_at) > 0 ? Number(r.added_at) * 1000 : null,
        })),
      },
      plexLibrary: { movies: count('movie'), shows: count('show') },
    };
  },
};

export const bazarr: Adapter = {
  name: 'bazarr', label: 'Bazarr', every: 300_000, needs: 'the Bazarr URL and API key (BAZARR_URL, BAZARR_KEY)', configured: () => !!(env('BAZARR_URL') && env('BAZARR_KEY')),
  async run() {
    const b = await getJSON(`${trimUrl(env('BAZARR_URL'))}/api/badges`, { headers: { 'X-API-KEY': env('BAZARR_KEY') } });
    return { bazarr: { episodes: Number(b.episodes ?? 0), movies: Number(b.movies ?? 0) } };
  },
};

export const seerr: Adapter = {
  name: 'seerr', label: 'Seerr', every: 120_000, needs: 'the Seerr URL and API key (SEERR_URL, SEERR_KEY)', configured: () => !!(env('SEERR_URL') && env('SEERR_KEY')),
  async run() {
    const c = await getJSON(`${trimUrl(env('SEERR_URL'))}/api/v1/request/count`, { headers: { 'X-Api-Key': env('SEERR_KEY') } });
    return { seerr: { pending: Number(c.pending ?? 0), approved: Number(c.approved ?? 0), completed: Number(c.completed ?? c.available ?? 0) } };
  },
};

export const immich: Adapter = {
  name: 'immich', label: 'Immich', every: 600_000, needs: 'the Immich URL and API key (IMMICH_URL, IMMICH_KEY)', configured: () => !!(env('IMMICH_URL') && env('IMMICH_KEY')),
  async run() {
    const base = trimUrl(env('IMMICH_URL')), headers = { 'x-api-key': env('IMMICH_KEY') };
    const [s, v] = await Promise.all([getJSON(`${base}/api/server/statistics`, { headers }), getJSON(`${base}/api/server/version`, { headers }).catch(() => null)]);
    const version = v ? `${v.major}.${v.minor}.${v.patch}` : '';
    return {
      immich: { photos: Number(s.photos ?? 0), videos: Number(s.videos ?? 0), sizeGiB: Number(s.usage ?? 0) / 2 ** 30, users: (s.usageByUser ?? []).length || 1, version },
      ...(version ? { versions: { Immich: version } } : {}),
    };
  },
};

export const prowlarr: Adapter = {
  name: 'prowlarr', label: 'Prowlarr', every: 3600_000, needs: 'the Prowlarr URL and API key (PROWLARR_URL, PROWLARR_KEY)', configured: () => !!(env('PROWLARR_URL') && env('PROWLARR_KEY')),
  async run() {
    const list = await getJSON<any[]>(`${trimUrl(env('PROWLARR_URL'))}/api/v1/indexer`, { headers: { 'X-Api-Key': env('PROWLARR_KEY') } });
    return { prowlarr: { indexers: list.filter(i => i.enable).map(i => i.name) } };
  },
};

/** Chaptarr (a Readarr-style API v1): author statistics, Wanted → Missing and the queue; every 15 min. */
export const chaptarr: Adapter = {
  name: 'chaptarr', label: 'Chaptarr', every: 900_000, needs: 'the Chaptarr URL and API key (CHAPTARR_URL, CHAPTARR_KEY)', configured: () => !!(env('CHAPTARR_URL') && env('CHAPTARR_KEY')),
  async run() {
    const base = `${trimUrl(env('CHAPTARR_URL'))}/api/v1`, o = { headers: { 'X-Api-Key': env('CHAPTARR_KEY') } };
    const [authors, missing, queue] = await Promise.all([getJSON<any[]>(`${base}/author`, o), getJSON<any>(`${base}/wanted/missing?pageSize=1`, o), getJSON<any>(`${base}/queue?pageSize=1`, o)]);
    return { chaptarr: chaptarrStats(authors, missing, queue) };
  },
};
export function chaptarrStats(authors: any[], missing: any, queue: any): NonNullable<Raw['chaptarr']> {
  if (!Array.isArray(authors) || !Number.isFinite(missing?.totalRecords) || !Number.isFinite(queue?.totalRecords)) throw new Error('unexpected Chaptarr answer');
  const sum = (k: string) => authors.reduce((n, a) => n + (Number(a?.statistics?.[k]) || 0), 0);
  return { authors: authors.length, books: sum('availableBookCount'), booksTotal: sum('totalBookCount'), missing: missing.totalRecords, queued: queue.totalRecords };
}

/** Plex: its own remote-access check, read with the server's token (PLEX_TOKEN); every 5 min. */
export const plex: Adapter = {
  name: 'plex', label: 'Plex', every: 300_000, needs: 'the Plex URL and token (PLEX_URL, PLEX_TOKEN)', configured: () => !!(env('PLEX_URL') && env('PLEX_TOKEN')),
  async run() {
    const xml = await getText(`${trimUrl(env('PLEX_URL'))}/myplex/account`, { headers: { 'X-Plex-Token': env('PLEX_TOKEN'), Accept: 'application/xml' } });
    return { plex: parsePlexAccount(xml) };
  },
};
/** <MyPlex mappingState="mapped" mappingError="" publicPort="32400" …/> → the remote-access fields; throws without them */
export function parsePlexAccount(xml: string): NonNullable<Raw['plex']> {
  const attr = (k: string) => xml.match(new RegExp(`\\b${k}="([^"]*)"`))?.[1];
  const state = attr('mappingState');
  if (state == null) throw new Error('no mappingState in myplex/account');
  const port = Number(attr('publicPort'));
  return { mapped: state === 'mapped', state, error: attr('mappingError') ?? '', publicPort: Number.isFinite(port) && port > 0 ? port : null };
}

/** WUD: containers with an update available. Needs a WUD login (basic auth). */
export const wud: Adapter = {
  name: 'wud', label: 'WUD', every: 600_000, needs: 'the WUD URL and a login (WUD_URL, WUD_USER, WUD_PASSWORD)', configured: () => !!(env('WUD_URL') && env('WUD_USER') && env('WUD_PASSWORD')),
  async run() {
    const list = await getJSON<any[]>(`${trimUrl(env('WUD_URL'))}/api/containers`, { headers: { Authorization: 'Basic ' + Buffer.from(`${env('WUD_USER')}:${env('WUD_PASSWORD')}`).toString('base64') } });
    return { wud: { updates: list.filter(c => c.updateAvailable).length } };
  },
};

export const weather: Adapter = {
  name: 'weather', label: 'Open-Meteo', every: 900_000, configured: () => env('WEATHER') !== 'off' && !!config.location,
  async run() {
    const { lat, lon } = config.location!;
    const j = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`);
    const t = j?.current?.temperature_2m;
    // the page calls toFixed() on it: anything but a number is "not answering", never a crash
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new Error('Open-Meteo answered without a temperature');
    return { weather: { tempC: t, text: WMO[j.current.weather_code] ?? '' } };
  },
};
const WMO: Record<number, string> = { 0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'cloudy', 45: 'fog', 48: 'fog', 51: 'drizzle', 53: 'drizzle', 55: 'drizzle', 61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain', 71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow', 80: 'showers', 81: 'showers', 82: 'heavy showers', 85: 'snow showers', 86: 'snow showers', 95: 'thunderstorm', 96: 'thunderstorm', 99: 'thunderstorm' };

/** Mac mini has no exporter: a plain TCP connect to its SSH port says whether it's on the LAN. One missed
 *  connect is 'unknown' (a busy Mac, a dropped SYN); three in a row is 'down'. */
const macFails = new Map<string, number>();
export const mac: Adapter = {
  name: 'mac', label: 'Mac mini probe', every: 30_000, configured: () => config.hosts.some(h => h.type === 'mac'),
  async run() {
    const out: Record<string, Status> = {};
    for (const h of config.hosts.filter(x => x.type === 'mac')) {
      const n = (await tcpUp(h.ip, Number(env('MAC_PROBE_PORT') || 22))) ? 0 : (macFails.get(h.id) ?? 0) + 1;
      macFails.set(h.id, n);
      out[h.id] = n === 0 ? 'up' : n >= 3 ? 'down' : 'unknown';
    }
    return { hostStatus: out };
  },
};
