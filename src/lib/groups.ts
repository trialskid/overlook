// Open groups the launcher by what each app is for. The groups, columns, display names and phone pins come from
// Snapshot.ui (homelab.json `ui` over the product defaults in shared/ui.ts). Keys are web UI names (config webUis) and
// app names (config apps), lower-case.
import { ui } from './uiconfig.ts';

/** Names left out of Open (still found by ⌘K), e.g. the dashboard itself. */
export const hiddenInOpen = (key: string) => ui().hidden.includes(key);
/** A web UI's or app's display name, undefined when the map doesn't have it. */
export const displayName = (name: string): string | undefined => ui().names[name.toLowerCase()];

/** Anything the mapping doesn't list; its column only appears when it has members. */
export const OTHER = 'Other';

/** A launch item's key ('ui-git', 'app-Nextcloud') → its group key ('git', 'nextcloud'). */
export const groupKey = (key: string) => key.replace(/^(ui|app)-/, '').toLowerCase();

/** Items in their groups, in the groups' order and in each group's own order; then Other (only when it has members). */
export function groupItems<T extends { key: string }>(items: T[]): { title: string; items: T[] }[] {
  const at = new Map<string, [number, number]>(), GROUPS = ui().groups;
  GROUPS.forEach(([, keys], gi) => keys.forEach((k, i) => at.set(k, [gi, i])));
  const out = GROUPS.map(([title]) => ({ title, items: [] as T[] })), other: T[] = [];
  const pos = (x: T) => at.get(groupKey(x.key))!;
  for (const x of items) (at.has(groupKey(x.key)) ? out[pos(x)[0]].items : other).push(x);
  for (const g of out) g.items.sort((a, b) => pos(a)[1] - pos(b)[1]);
  return other.length ? [...out, { title: OTHER, items: other }] : out;
}

/** Groups laid out in the columns (empty groups dropped, a column with none left dropped too), then Other on its own. */
export function columnsOf<G extends { title: string; items: unknown[] }>(groups: G[]): G[][] {
  const by = new Map(groups.filter(g => g.items.length).map(g => [g.title, g]));
  const cols = ui().columns.map(c => c.flatMap(t => by.get(t) ?? [])).filter(c => c.length);
  const other = by.get(OTHER);
  return other ? [...cols, [other]] : cols;
}

/** host[:port] of a URL ('https://photos.example.com/' → 'photos.example.com', 'http://10.20.0.30:8443' → '10.20.0.30:8443') */
export const urlHost = (url: string) => { try { return new URL(url).host.toLowerCase(); } catch { return url.toLowerCase(); } };
/** Bookmarks without the ones Open already shows: a link on the same host as a service is hidden; a different host
 *  stays, e.g. 'Seerr (public)' (requests.example.com, while Open's Seerr is seerr.lab.example.com). */
export function withoutServices<L extends { url: string }, G extends { items: L[] }>(groups: G[], serviceUrls: string[]) {
  const taken = new Set(serviceUrls.map(urlHost));
  const kept = groups.map(g => ({ ...g, items: g.items.filter(l => !taken.has(urlHost(l.url))) }));
  return { groups: kept.filter(g => g.items.length), hidden: groups.reduce((n, g) => n + g.items.length, 0) - kept.reduce((n, g) => n + g.items.length, 0) };
}

/** The phone incident hero's Open grid: up to eight everyday services, in order. */
export const phonePins = () => ui().phonePins;
