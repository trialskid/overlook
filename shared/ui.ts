// What the page calls things and how Open groups them: product defaults here, a lab's own in homelab.json `ui`.
// resolveUi() merges the two into the Snapshot's `ui` (so a config reload reaches every open page); the page reads it
// through src/lib/uiconfig.ts. Keys are web UI names (homelab.json webUis) and app names (apps), lower-case.
import type { HomelabConfig, UiView } from './types.ts';

/** Open's groups, in order. Host ids are added to Infrastructure (resolveUi). */
export const DEFAULT_GROUPS: [string, string[]][] = [
  ['Media', ['plex', 'jellyfin', 'emby', 'seerr', 'overseerr', 'jellyseerr', 'tautulli', 'bazarr', 'chaptarr', 'audiobookshelf', 'navidrome', 'recommendarr']],
  ['Downloads', ['sonarr', 'radarr', 'lidarr', 'readarr', 'prowlarr', 'qbittorrent', 'nzbget', 'sabnzbd', 'transmission', 'deluge', 'profilarr']],
  ['Infrastructure', ['proxmox', 'unraid', 'truenas', 'nas', 'portainer', 'omada', 'unifi', 'opnsense', 'pfsense', 'kopia', 'adguard', 'pihole', 'qdirstat']],
  ['Monitoring', ['grafana', 'prometheus', 'uptime', 'ntfy', 'wud', 'ntopng', 'netdata']],
  ['Apps', ['immich', 'paperless', 'nextcloud', 'syncthing', 'git', 'gitea', 'forgejo', 'n8n', 'vaultwarden', 'booklore', '13ft']],
  ['Home', ['homeassistant', 'scrypted', 'frigate', 'printer']],
];
/** Open's columns: one group each by default; a column can stack several. */
export const DEFAULT_COLUMNS: string[][] = [['Media'], ['Downloads'], ['Infrastructure'], ['Monitoring'], ['Apps'], ['Home']];
/** The phone incident hero's Open grid: the first eight of these the lab has. */
export const DEFAULT_PINS = ['plex', 'jellyfin', 'seerr', 'sonarr', 'radarr', 'homeassistant', 'grafana', 'immich', 'git', 'uptime'];

/** Product names with their own capitalisation (Kuma's monitor names are only the fallback). */
export const PRODUCT_NAMES: Record<string, string> = {
  plex: 'Plex', jellyfin: 'Jellyfin', emby: 'Emby', seerr: 'Seerr', overseerr: 'Overseerr', jellyseerr: 'Jellyseerr', tautulli: 'Tautulli', bazarr: 'Bazarr',
  chaptarr: 'Chaptarr', audiobookshelf: 'Audiobookshelf', navidrome: 'Navidrome', recommendarr: 'Recommendarr',
  sonarr: 'Sonarr', radarr: 'Radarr', lidarr: 'Lidarr', readarr: 'Readarr', prowlarr: 'Prowlarr', qbittorrent: 'qBittorrent', nzbget: 'NZBGet', sabnzbd: 'SABnzbd',
  transmission: 'Transmission', deluge: 'Deluge', profilarr: 'Profilarr',
  proxmox: 'Proxmox', unraid: 'Unraid', truenas: 'TrueNAS', portainer: 'Portainer', omada: 'Omada', unifi: 'UniFi', opnsense: 'OPNsense', pfsense: 'pfSense',
  kopia: 'Kopia', adguard: 'AdGuard Home', pihole: 'Pi-hole', qdirstat: 'QDirStat',
  grafana: 'Grafana', prometheus: 'Prometheus', uptime: 'Uptime Kuma', ntfy: 'ntfy', wud: 'WUD', ntopng: 'ntopng', netdata: 'Netdata',
  immich: 'Immich', paperless: 'Paperless', nextcloud: 'Nextcloud', syncthing: 'Syncthing', git: 'Git', gitea: 'Gitea', forgejo: 'Forgejo', n8n: 'n8n',
  vaultwarden: 'Vaultwarden', booklore: 'BookLore', '13ft': '13ft', homeassistant: 'Home Assistant', scrypted: 'Scrypted', frigate: 'Frigate', printer: 'Printer',
  nightscout: 'Nightscout', overlook: 'Overlook',
};
/** Extra words people type for a product (search, ⌘K). A lab's own go in homelab.json ui.aliases. */
export const PRODUCT_ALIASES: Record<string, string> = {
  git: 'git repos code', gitea: 'git repos code', forgejo: 'git repos code', uptime: 'uptime kuma monitors', proxmox: 'proxmox pve',
  homeassistant: 'ha hass home assistant locks thermostat', kopia: 'kopia backup snapshots', qbittorrent: 'torrent qbit', nzbget: 'usenet nzb', sabnzbd: 'usenet nzb',
  unraid: 'nas array', truenas: 'nas zfs pool', grafana: 'dashboards alerts metrics', prometheus: 'metrics prom', ntfy: 'notifications push alerts',
  wud: 'whats up docker updates', portainer: 'docker containers', ntopng: 'traffic flows lan devices', '13ft': 'paywall', printer: 'printer toner ipp',
  scrypted: 'cameras nvr', frigate: 'cameras nvr', omada: 'wifi access points', unifi: 'wifi access points', chaptarr: 'books audiobooks', booklore: 'books ebooks',
  audiobookshelf: 'audiobooks podcasts', tautulli: 'plex stats history', seerr: 'overseerr jellyseerr requests', overseerr: 'requests', jellyseerr: 'requests',
  plex: 'movies shows media', jellyfin: 'movies shows media', emby: 'movies shows media', immich: 'photos pictures', paperless: 'documents scans',
  n8n: 'workflows automation', qdirstat: 'disk usage', nextcloud: 'files cloud', syncthing: 'sync files', vaultwarden: 'passwords bitwarden',
  adguard: 'dns ad blocking', pihole: 'dns ad blocking', nightscout: 'nightscout ns cgm glucose', overlook: 'dashboard status',
};
/** Two-character monograms where the first two letters would collide or read badly (first upper, second lower). */
export const PRODUCT_MONOGRAMS: Record<string, string> = {
  homeassistant: 'HA', ntfy: 'Nf', ntopng: 'Ng', printer: 'Pr', profilarr: 'Pf', prometheus: 'Pm', prowlarr: 'Pw', scrypted: 'Sy', pfsense: 'Pf', pihole: 'Ph',
};

/** '10.20.0.0/24' → '10.20.0' (LAN addresses are written '.42:3000' in homelab.json and shown that way on the page) */
export const lanPrefixOf = (subnet: string | undefined) => (subnet ?? '').split('/')[0].split('.').slice(0, 3).join('.');

type UiInput = Partial<Pick<HomelabConfig, 'ui' | 'hosts' | 'domain' | 'uiLabels' | 'network'>>;
/** homelab.json → the page's ui. `ui.launcher.groups` replaces the default groups; with the defaults, host ids are added
 *  to Infrastructure (a host's web UI is usually named after it). Names, aliases and monograms add to the product ones. */
export function resolveUi(cfg: UiInput = {}): UiView {
  const u = cfg.ui ?? {}, l = u.launcher ?? {};
  const groups: [string, string[]][] = (l.groups ?? DEFAULT_GROUPS).map(([t, keys]) => [t, keys.map(k => k.toLowerCase())]);
  const listed = new Set(groups.flatMap(([, keys]) => keys));
  const hostIds = l.groups ? [] : (cfg.hosts ?? []).map(h => h.id.toLowerCase()).filter(id => !listed.has(id));
  const infra = groups.find(([t]) => t === 'Infrastructure');
  if (infra && hostIds.length) infra[1] = [...hostIds, ...infra[1]];
  const lower = (r: Record<string, string> | undefined) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    title: u.title || 'Overlook',
    brand: u.brand ?? cfg.domain ?? '',
    groups,
    columns: l.columns ?? (l.groups ? groups.map(([t]) => [t]) : DEFAULT_COLUMNS),
    hidden: (l.hidden ?? []).map(k => k.toLowerCase()),
    phonePins: (l.phonePins ?? DEFAULT_PINS).map(k => k.toLowerCase()),
    names: { ...PRODUCT_NAMES, ...lower(cfg.uiLabels), ...lower(u.names) },
    aliases: { ...PRODUCT_ALIASES, ...lower(u.aliases) },
    monograms: { ...PRODUCT_MONOGRAMS, ...lower(u.monograms) },
    openHosts: u.openHosts ?? (cfg.hosts?.[0] ? [cfg.hosts[0].id] : []),
    gatewayMonogram: (cfg.network?.gateway?.id && lower(u.monograms)[cfg.network.gateway.id.toLowerCase()]) || 'GW',
    qbittorrentVia: u.qbittorrentVia ?? '',
    lanPrefix: lanPrefixOf(cfg.network?.subnet),
  };
}
