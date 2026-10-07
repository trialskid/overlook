// What the page shows depends on the lab's modules (Snapshot.modules, server/modules.ts): a module that's off hides
// its tab, section or block entirely; one that's on but missing a key still shows, saying what it needs.
import { M_TABS, TABS, type MTab, type Tab } from '../state.tsx';
import type { ModuleId, Snapshot } from '../../shared/types.ts';

type Mods = Pick<Snapshot, 'modules'>;
/** Is any of these modules on (or listed but not connected)? A snapshot without `modules` counts everything on. */
export const on = (snap: Mods, ...ids: ModuleId[]) => ids.some(id => (snap.modules?.[id] ?? 'on') !== 'off');

export const MEDIA_MODULES: ModuleId[] = ['plex', 'sonarr', 'radarr', 'bazarr', 'prowlarr', 'chaptarr', 'seerr', 'qbittorrent', 'nzbget', 'immich'];
const tabOn = (snap: Mods, t: Tab | MTab) => (t === 'Media' ? on(snap, ...MEDIA_MODULES) : t === 'House' ? on(snap, 'homeassistant') : true);
/** Desktop tabs the lab has (Overview and Health always). */
export const visibleTabs = (snap: Mods): Tab[] => TABS.filter(t => tabOn(snap, t));
/** Phone tabs the lab has (Overview, Health and Open always). */
export const visibleMTabs = (snap: Mods): MTab[] => M_TABS.filter(t => tabOn(snap, t));
