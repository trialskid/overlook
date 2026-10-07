// Modules: what a lab has. Each integration is optional, and the page shows only the modules that are on.
//
//   homelab.json `modules` listed  → that list is authoritative:
//       listed, its source has what it needs  → 'on'
//       listed, a key or URL is missing       → 'not-connected' (the page says what it needs)
//       not listed                            → 'off' (never polled, hidden on the page)
//   no `modules` key                → inferred: a module is on when its source is configured (.env) and the config
//                                     describes something for it (a web UI, a host type, a section); otherwise off.
//                                     Nothing reads 'not-connected' in this mode: a missing key just means off.
import type { HomelabConfig, ModuleId, ModuleState } from '../shared/types.ts';
import type { Adapter } from './adapters/types.ts';
import type { Raw } from './raw.ts';

export const MODULE_IDS = [
  'proxmox', 'prometheus', 'network', 'kuma', 'grafana', 'ntfy', 'probes', 'devices', 'weather', 'hostprobe',
  'plex', 'sonarr', 'radarr', 'bazarr', 'prowlarr', 'chaptarr', 'seerr', 'qbittorrent', 'nzbget', 'immich', 'wud',
  'homeassistant', 'spotlight', 'ups', 'unraid', 'apt', 'edge', 'checks',
] as const satisfies readonly ModuleId[];

/** Which modules each adapter serves (by adapter name). An adapter runs while any of its modules is on. Adapters not
 *  listed here (test doubles) always run. */
export const ADAPTER_MODULES: Record<string, ModuleId[]> = {
  proxmox: ['proxmox'],
  'prom-infra': ['prometheus', 'network', 'spotlight'],
  'prom-jobs': ['prometheus'],
  'prom-media': ['sonarr', 'radarr', 'qbittorrent', 'nzbget'],
  'prom-home': ['homeassistant'],
  'prom-ops': ['ups', 'unraid', 'apt', 'edge'],
  'prom-checks': ['checks'],
  kuma: ['kuma'], grafana: ['grafana'], ntfy: ['ntfy'], probes: ['probes'], devices: ['devices'], weather: ['weather'], mac: ['hostprobe'],
  tautulli: ['plex'], plex: ['plex'], bazarr: ['bazarr'], seerr: ['seerr'], immich: ['immich'], prowlarr: ['prowlarr'], chaptarr: ['chaptarr'], wud: ['wud'],
};

/** Inferred mode only: does the config describe something for this module? (Its source being configured is checked
 *  separately.) Opt-in modules (ups, apt, edge) are never inferred. */
const DESCRIBED: Partial<Record<ModuleId, (cfg: HomelabConfig) => boolean>> = {
  proxmox: cfg => cfg.hosts.some(h => h.type === 'proxmox'),
  network: cfg => !!cfg.network?.gateway,
  weather: cfg => !!cfg.location,
  probes: cfg => cfg.publicEndpoints.length > 0,
  hostprobe: cfg => cfg.hosts.some(h => h.type === 'mac'),
  sonarr: cfg => 'sonarr' in cfg.webUis, radarr: cfg => 'radarr' in cfg.webUis,
  qbittorrent: cfg => 'qbittorrent' in cfg.webUis, nzbget: cfg => 'nzbget' in cfg.webUis,
  homeassistant: cfg => !!cfg.homeAssistant,
  spotlight: cfg => !!cfg.spotlight?.app,
  unraid: cfg => cfg.hosts.some(h => h.type === 'unraid'),
  ups: () => false, apt: () => false, edge: () => false,
  checks: cfg => (cfg.checks?.length ?? 0) > 0,
};

const adaptersOf = (adapters: Adapter[], id: ModuleId) => adapters.filter(a => ADAPTER_MODULES[a.name]?.includes(id));

/** Every module's state. `configured` says whether an adapter has what it needs (mock: always). */
export function moduleStates(cfg: HomelabConfig, adapters: Adapter[], configured: (a: Adapter) => boolean): Record<ModuleId, ModuleState> {
  const listed = cfg.modules ? new Set<string>(cfg.modules) : null;
  const out = {} as Record<ModuleId, ModuleState>;
  for (const id of MODULE_IDS) {
    const own = adaptersOf(adapters, id);
    const ready = own.some(configured); // e.g. plex: Tautulli or the Plex token is enough to show something
    if (listed) out[id] = !listed.has(id) ? 'off' : ready ? 'on' : 'not-connected';
    else out[id] = ready && (DESCRIBED[id]?.(cfg) ?? true) ? 'on' : 'off';
  }
  return out;
}

/** Does this adapter run? Yes while any module it serves is on or not-connected (the latter shows what it needs). */
export function adapterEnabled(a: Adapter, states: Record<ModuleId, ModuleState>): boolean {
  const mods = ADAPTER_MODULES[a.name];
  return !mods || mods.some(m => states[m] !== 'off');
}

/** Names in `modules` that aren't modules (a typo would silently turn one off). */
export const unknownModules = (cfg: HomelabConfig) => (cfg.modules ?? []).filter(m => !(MODULE_IDS as readonly string[]).includes(m));

/** Every module on: derive()'s default when the caller doesn't pass states (tests, the config dry run). */
export const allOn = () => Object.fromEntries(MODULE_IDS.map(m => [m, 'on'])) as Record<ModuleId, ModuleState>;

/** The Raw keys each module owns beyond its own adapters (an adapter can serve several modules, e.g. prom-ops).
 *  derive() drops a module's keys while it's off, so its sections, attention items and counts go with it. */
export const MODULE_RAW: Partial<Record<ModuleId, (keyof Raw)[]>> = {
  network: ['network', 'lanDevices'],
  spotlight: ['spotlight'],
  ups: ['ups'],
  unraid: ['unraid', 'unraidDisks', 'unraidHealth'],
  apt: ['apt'],
  edge: ['edge'],
  sonarr: ['sonarr'], radarr: ['radarr'], qbittorrent: ['qbit'], nzbget: ['nzbget'],
  homeassistant: ['ha'],
  kuma: ['kuma'], grafana: ['grafana'], checks: ['checks'],
};
/** `raw` without the slices of modules that are off (a shallow copy; `raw` itself is untouched). */
export function gateRaw(raw: Raw, states: Record<ModuleId, ModuleState> | undefined): Raw {
  if (!states) return raw;
  const out = { ...raw } as Record<string, unknown>;
  for (const [id, keys] of Object.entries(MODULE_RAW) as [ModuleId, (keyof Raw)[]][]) if (states[id] === 'off') for (const k of keys) out[k] = null;
  return out as unknown as Raw;
}
