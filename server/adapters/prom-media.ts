// Prometheus · media exporters (every 30 s): exportarr (Sonarr, Radarr), the qBittorrent exporter and the
// NZBGet exporter. What the numbers mean (checked against the apps):
//   sonarr.wanted  = sonarr_episode_missing_total: Sonarr's Wanted → Missing (monitored, aired, no file).
//   sonarr.queued  = sum(sonarr_queue_total): items matched to a series. exportarr leaves out Sonarr's
//                    unknown-series items (stuck imports), so Sonarr's own queue can be larger (10-04: 2 vs 6).
//   radarr.missing = radarr_movie_missing_total: monitored, released ("available"), no file (10-04: 82).
//   radarr.wanted  = radarr_movie_wanted_total: monitored, no file, NOT released yet (10-04: 24).
//   radarr.queued  = sum(radarr_queue_total). exportarr only emits queue series while the queue has items, so
//                    with Radarr answering and no queue series the queue is empty (0), not unknown.
//   nzbget.todayGB = nzbget_quota_day_bytes: despite its help text ("Daily quota") it is NZBGet's DaySize, the
//                    bytes downloaded since local midnight (matches increase(downloaded_total) since 00:00).
//   qbit.todayGB   = increase(qbittorrent_dl_info_data_total) since local midnight: the counter is per qBittorrent
//                    session, and increase() carries over a restart. A minute at least, so 00:00 still has 2 samples.
// A missing series is null (never a guessed 0); Prometheus not answering throws.
import { many } from './prometheus.ts';
import { env, type Adapter } from './types.ts';
import type { Raw } from '../raw.ts';

const LEECH = 'downloading|metaDL|forcedMetaDL|stalledDL|checkingDL|forcedDL|queuedDL|allocating';
const SEED = 'uploading|stalledUP|forcedUP|queuedUP|checkingUP';

export const promMedia: Adapter = {
  name: 'prom-media',
  label: 'Prometheus · media exporters',
  every: 30_000,
  needs: 'PROMETHEUS_URL in .env',
  configured: () => !!env('PROMETHEUS_URL'),
  async run() {
    const sinceMidnight = Math.max(60, Math.floor((Date.now() - new Date().setHours(0, 0, 0, 0)) / 1000));
    const v = await many({
      series: 'max(sonarr_series_total)', sWanted: 'max(sonarr_episode_missing_total)',
      // an empty queue has no series: 0 while the same exporter scrape still reports the library
      sQueued: 'sum(sonarr_queue_total) or 0 * max(sonarr_series_total)',
      movies: 'max(radarr_movie_total)', rMissing: 'max(radarr_movie_missing_total)', rWanted: 'max(radarr_movie_wanted_total)',
      rQueued: 'sum(radarr_queue_total) or 0 * max(radarr_movie_total)',
      qbUp: 'max(qbittorrent_up)', qbConn: 'max(qbittorrent_connected)', qbFw: 'max(qbittorrent_firewalled)',
      leech: `sum(qbittorrent_torrents_count{status=~"${LEECH}"})`, seed: `sum(qbittorrent_torrents_count{status=~"${SEED}"})`,
      qbDay: `sum(increase(qbittorrent_dl_info_data_total[${sinceMidnight}s]))`,
      nzbDay: 'max(nzbget_quota_day_bytes)', nzbQueue: 'max(nzbget_queue_remaining_bytes)', nzbPaused: 'max(nzbget_download_paused)',
    });
    const { series, sWanted, sQueued, movies, rMissing, rWanted, qbConn, qbFw, leech, seed } = v;
    const out: Partial<Raw> = {
      sonarr: series !== undefined && sWanted !== undefined && sQueued !== undefined ? { series, queued: sQueued, wanted: sWanted } : null,
      radarr: movies !== undefined && rMissing !== undefined && rWanted !== undefined ? { movies, queued: v.rQueued ?? null, missing: rMissing, wanted: rWanted } : null,
      // qbittorrent_up 0: the exporter can't reach qBittorrent, so nothing it says about torrents is current
      qbit: v.qbUp === 1 && leech !== undefined && seed !== undefined ? {
        leeching: leech, seeding: seed,
        conn: qbConn === 1 ? 'connected' : qbFw === 1 ? 'firewalled' : qbConn === 0 && qbFw === 0 ? 'disconnected' : null,
        todayGB: v.qbDay !== undefined ? v.qbDay / 1e9 : null,
      } : null,
      nzbget: v.nzbDay !== undefined ? { todayGB: v.nzbDay / 1e9, queueGB: v.nzbQueue !== undefined ? v.nzbQueue / 1e9 : null, paused: v.nzbPaused !== undefined ? v.nzbPaused === 1 : null } : null,
    };
    return out;
  },
};
