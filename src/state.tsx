import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Live } from './lib/live.ts';
import { setUi as setUiView } from './lib/uiconfig.ts';
import type { GuestView, HostView, Snapshot } from '../shared/types.ts';

/** Review Phase 5: Links became Overview's Bookmarks, Devices a Health section. The House tab is the Home component
 *  (renamed for the page, Oct 6; its anchors stay home-*). */
export const TABS = ['Overview', 'Health', 'Media', 'House'] as const;
export type Tab = (typeof TABS)[number];
/** The phone's own tabs (review finding 9): Open = Launch + Links under one search. Devices is a screen under Health. */
export const M_TABS = ['Overview', 'Health', 'Open', 'Media', 'House'] as const;
export type MTab = (typeof M_TABS)[number] | 'Devices';
/** ?overview=classic: today's Overview before review Phase 5, kept as an option. A function (not read at
 *  import) so node tests can load the modules that use it. */
export const classicOverview = () => typeof location !== 'undefined' && new URLSearchParams(location.search).get('overview') === 'classic';
export type Selection = { kind: 'host' | 'guest'; id: string } | null;

export interface UiState {
  dTab: Tab; mTab: MTab; mScreen: 'home' | 'guest'; selection: Selection; openHosts: Set<string>; mobileGuestId: string | null;
  /** Open's one search (services and bookmarks), desktop and phone */
  launcherQuery: string; cmdOpen: boolean;
  /** Overview's network band: the full map open in place (review Phase 5) */
  mapOpen: boolean;
  /** Health › Devices: the filter, the segment lists unfolded (their group ids), every Other LAN row shown (not only the offline ones) */
  deviceQuery: string; segOpen: string[]; lanOpen: boolean;
}

interface Ctx {
  live: Live; snap: Snapshot; ui: UiState;
  set: (p: Partial<UiState> | ((s: UiState) => Partial<UiState>)) => void;
  select: (s: Selection) => void;
  toggleSelect: (s: NonNullable<Selection>) => void;
  hostById: (id: string) => HostView | undefined;
  guestById: (id: string) => GuestView | undefined;
}
const C = createContext<Ctx | null>(null);
export const useApp = () => { const c = useContext(C); if (!c) throw new Error('no app context'); return c; };

export function AppProvider({ live, snap, children }: { live: Live; snap: Snapshot; children: ReactNode }) {
  setUiView(snap.ui); // before any child renders: monoOf, displayName, shortUrl … read it
  const [ui, setUi] = useState<UiState>({
    dTab: 'Overview', mTab: 'Overview', mScreen: 'home', selection: null, openHosts: new Set(snap.ui?.openHosts ?? []), mobileGuestId: null,
    launcherQuery: '', cmdOpen: false, mapOpen: false, deviceQuery: '', segOpen: [], lanOpen: false,
  });
  useEffect(() => { document.title = snap.ui.title; }, [snap.ui.title]);
  const value = useMemo<Ctx>(() => {
    const set: Ctx['set'] = p => setUi(s => ({ ...s, ...(typeof p === 'function' ? p(s) : p) }));
    return {
      live, snap, ui, set,
      select: selection => set({ selection }),
      toggleSelect: s => set(u => ({ selection: u.selection && u.selection.kind === s.kind && u.selection.id === s.id ? null : s })),
      hostById: id => snap.hosts.find(h => h.id === id),
      guestById: id => snap.guests.find(g => g.id === id),
    };
  }, [live, snap, ui]);
  return <C.Provider value={value}>{children}</C.Provider>;
}
