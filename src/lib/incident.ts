// Review Phase 5 (1c): what the calm / incident Overview shows, worked out from the Snapshot alone (pure, so the tests
// run it under node). Red takes over the top of the page (the incident band); amber stays calm, with one line under
// the header; info notes never change the shape.
import type { Attention, GuestView, HostView, Monitor, Snapshot, Status, WebUi } from '../../shared/types.ts';
import { agoText, fmt, fmt1, last, pveUrl, worst } from './util.ts';
import { serviceOf, shortUrl } from './search.ts';
import { displayName } from './groups.ts';

const SEV_ORDER = { danger: 0, warn: 1, info: 2 } as const;
/** danger + warn items, worst first (info notes are separate). */
export const needsYou = (items: Attention[]) => items.filter(a => a.severity !== 'info').sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
export const notesOf = (items: Attention[]) => items.filter(a => a.severity === 'info');
/** The item the incident band is about: the worst red one. None while nothing is red (amber keeps the calm shape). */
export const incidentItem = (snap: Pick<Snapshot, 'attention'>) => { const a = needsYou(snap.attention)[0]; return a?.severity === 'danger' ? a : undefined; };

/** A web UI's name as people say it: Open's display name (src/lib/groups.ts), else config uiLabels or Kuma's monitor
 *  name (a trailing '.' dropped: '13ft.'), else the owning guest's matching service, else its key. */
export function uiLabel(snap: Snapshot, u: WebUi) {
  const m = snap.health.monitors.find(x => x.name === u.name)?.label?.replace(/\.+$/, '');
  return displayName(u.name) || m || serviceOf(snap, u) || u.name;
}

/** One step on the way from the internet to what broke (review 3d). chip: the phone's shorter name (no vmid). */
export interface Hop { name: string; meta: string; status: Status; chip?: string }
/** The band's richer hop lines (1c): CPU on the host, containers on the guest, the port on the web UI. */
export interface Rich { cpu: Record<string, (number | null)[]> }
/** The path Internet → gateway → switch (whichever the lab names) → host → guest → web UI to the subject of a Needs attention item (its id:
 *  down-<web UI>, guest-<id> or host-<id>), each hop with its own status; null when the item maps to none of them. */
export function failPath(snap: Snapshot, id: string, wanIn: number | null, rich?: Rich): Hop[] | null {
  const s = subjectOf(snap, id);
  if (!s) return null;
  const { ui, guest: g, host: h } = s;
  const n = snap.network, [ip, port] = h.ipS.split(' · '), cpu = rich ? last(rich.cpu[h.id] ?? []) : null;
  const hops: Hop[] = [
    { name: 'Internet', meta: wanIn == null ? '' : `↓ ${rich ? fmt1(wanIn) : fmt(wanIn)} Mb/s`, status: n.internet },
    ...(n.gateway ? [{ name: n.gateway.name, meta: n.gateway.ipShort, status: worst(n.gateway.status, n.gateway.wan) }] : []),
    ...(n.switch ? [{ name: n.switch.name, meta: [n.switch.ipShort, port].filter(Boolean).join(' · '), status: n.switch.status }] : []),
    { name: h.name, meta: cpu != null ? `${ip} · CPU ${Math.round(cpu)}%` : ip, status: h.status },
  ];
  if (g) hops.push({ name: `${g.vmid} ${g.name}`, chip: g.name, meta: rich && g.containers != null ? `${g.ip} · ${g.containers} container${g.containers === 1 ? '' : 's'}` : g.ip, status: g.status });
  if (ui) {
    const p = ui.target.split(':')[1];
    hops.push({ name: uiLabel(snap, ui), meta: rich && p ? `${shortUrl(ui.url)} · :${p}` : shortUrl(ui.url), status: ui.status });
  }
  return hops;
}

interface Subject { kind: 'ui' | 'guest' | 'host'; ui?: WebUi; guest?: GuestView; host: HostView }
function subjectOf(snap: Snapshot, id: string): Subject | null {
  const [kind, ...rest] = id.split('-'), key = rest.join('-');
  let ui: WebUi | undefined, g: GuestView | undefined, h: HostView | undefined;
  if (kind === 'down') {
    ui = snap.uis.find(u => u.name === key);
    const o = ui?.owner;
    if (!o) return null;
    if (o.kind === 'guest') g = snap.guests.find(x => x.id === o.id); else h = snap.hosts.find(x => x.id === o.id);
  } else if (kind === 'guest') g = snap.guests.find(x => x.id === key);
  else if (kind === 'host') h = snap.hosts.find(x => x.id === key);
  else return null;
  if (g) h = snap.hosts.find(x => x.id === g!.host);
  if (!h) return null;
  return { kind: ui ? 'ui' : g ? 'guest' : 'host', ui, guest: g, host: h };
}

export interface BandChip { name: string; label: string; status: Status; monitored: boolean; public: boolean }
export interface BandAction { label: string; href: string; primary: boolean }
/** The incident band (1c): the worst red item, where it breaks, the evidence and the next step. */
export interface Band {
  item: Attention;
  /** the path to its subject; null when the item maps to no host, guest or web UI (the band shows its detail instead) */
  hops: Hop[] | null;
  /** 'Everything above Gitea answers, so it's the app, not the network.' when every hop above the subject is up */
  sentence: string | null;
  /** the subject web UI's address (the phone's sub-line), null for anything else */
  url: string | null;
  /** the subject web UI's Uptime Kuma monitor (24 h strip, latency, 30-day) */
  monitor: Monitor | null;
  /** the subject's other web UIs ('Also on web'), or a guest's own ('On web'); up/watched count the monitored ones */
  alsoOn: { title: string; up: number; watched: number; chips: BandChip[] } | null;
  actions: BandAction[];
  /** the other red and amber items, red first */
  more: Attention[];
  notes: Attention[];
  /** what the network band keeps lit; everything else dims (kind: a host's own item keeps its guests lit) */
  path: { hostId: string; guestId: string | null; kind: 'ui' | 'guest' | 'host' } | null;
}
const NOUN = { ui: 'the app', guest: 'the guest', host: 'the host' } as const;

export function bandModel(snap: Snapshot, wanIn: number | null, rich?: Rich): Band | null {
  const item = incidentItem(snap);
  if (!item) return null;
  const s = subjectOf(snap, item.id), hops = s ? failPath(snap, item.id, wanIn, rich) : null;
  const all = needsYou(snap.attention);
  const base = { item, more: all.filter(a => a !== item), notes: notesOf(snap.attention) };
  const action: BandAction[] = item.action ? [{ ...item.action, primary: true }] : [];
  // a down web UI with no owner in the inventory has no path, but its monitor and address are still known
  const ui = s?.ui ?? (item.id.startsWith('down-') ? snap.uis.find(u => u.name === item.id.slice(5)) : undefined);
  const monitor = ui ? snap.health.monitors.find(m => m.name === ui.name && m.kumaId != null) ?? null : null;
  const dedupe = (xs: BandAction[]) => xs.filter((a, i) => xs.findIndex(b => b.href === a.href) === i);
  if (!s || !hops) {
    const actions = dedupe([...action, ...(ui ? [{ label: shortUrl(ui.url), href: ui.url, primary: false }] : [])]);
    return { ...base, hops: null, sentence: null, url: ui?.url ?? null, monitor, alsoOn: null, actions, path: null };
  }
  const end = hops.length - 1;
  const sentence = hops[end].status !== 'up' && hops.slice(0, end).every(h => h.status === 'up')
    ? `Everything above ${hops[end].name} answers, so it's ${NOUN[s.kind]}, not the network.` : null;
  // the owner's web UIs: a guest's or a host's (a host-owned UI, e.g. Unraid's)
  const owner = s.guest ? { kind: 'guest', id: s.guest.id, name: s.guest.name } : s.ui ? { kind: 'host', id: s.host.id, name: s.host.name } : null;
  const theirs = owner ? snap.uis.filter(u => u.owner?.kind === owner.kind && u.owner.id === owner.id && u.name !== s.ui?.name) : [];
  const chips = theirs.map(u => ({ name: u.name, label: uiLabel(snap, u), status: u.status, monitored: u.monitored, public: u.public }));
  const watched = chips.filter(c => c.monitored);
  const alsoOn = owner && chips.length ? { title: `${s.ui ? 'Also on' : 'On'} ${owner.name}`, up: watched.filter(c => c.status === 'up').length, watched: watched.length, chips } : null;
  const pve = s.guest ? pveUrl(s.host.url, s.guest) : null;
  const actions = dedupe([
    ...action,
    ...(s.guest && pve ? [{ label: `${s.guest.name} in Proxmox`, href: pve, primary: false }] : s.kind === 'host' && s.host.url ? [{ label: `${s.host.name}`, href: s.host.url, primary: false }] : []),
    ...(s.ui ? [{ label: shortUrl(s.ui.url), href: s.ui.url, primary: false }] : []),
  ]);
  return { ...base, hops, sentence, url: s.ui?.url ?? null, monitor, alsoOn, actions, path: { hostId: s.host.id, guestId: s.guest?.id ?? null, kind: s.kind } };
}

// ---- the header's second line (the counts sub-line instead of a KPI row)
/** One count from the server's own KPI value ('35/36'), so the header says what Health and classic say. */
/** danger: the KPI's own tone, red only when the server calls it so (a host down, an expected guest stopped, a monitored
 *  UI down), never for a count that's merely short (a degraded host, a stopped guest nobody expects to run) */
export interface Count { id: 'uis' | 'hosts' | 'guests'; up: number; total: number; noun: string; danger: boolean }
const NOUNS = { uis: ['web UI', 'web UIs'], hosts: ['host', 'hosts'], guests: ['guest', 'guests'] } as const;
export function counts(snap: Pick<Snapshot, 'kpis'>): Count[] {
  return (['uis', 'hosts', 'guests'] as const).flatMap(id => {
    const k = snap.kpis.find(x => x.id === id), m = /^(\d+)\/(\d+)$/.exec(k?.value ?? '');
    if (!m) return []; // '—': its source isn't answering (Health says so)
    const up = Number(m[1]), total = Number(m[2]);
    return [{ id, up, total, noun: NOUNS[id][total === 1 ? 0 : 1], danger: k?.tone === 'danger' }];
  });
}
/** The counts the line names: all of them when calm ('36 web UIs, 4 hosts and 8 guests'); during an incident only
 *  those short of their total ('35 of 36 web UIs'), all of them when none is. */
export const shownCounts = (cs: Count[], incident: boolean) => (incident && cs.some(c => c.up < c.total) ? cs.filter(c => c.up < c.total) : cs);
export const countText = (c: Count) => (c.up < c.total ? `${c.up} of ${c.total} ${c.noun}` : `${c.total} ${c.noun}`);
/** 'a', 'a and b', 'a, b and c' */
export const joinAnd = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** after the counts during an incident: what else is open */
export const restText = (snap: Pick<Snapshot, 'attention'>) => { const n = needsYou(snap.attention).length - 1; return n > 0 ? `${n} more to look at` : 'everything else nominal'; };
/** The whole line as text (the header draws the same parts, with links and rolling digits). */
export function headerLine(snap: Pick<Snapshot, 'kpis' | 'attention' | 'weather'>, greet: string) {
  const inc = !!incidentItem(snap), cs = shownCounts(counts(snap), inc);
  const what = cs.length ? `${joinAnd(cs.map(countText))} answering` : '';
  if (inc) return [what, restText(snap)].filter(Boolean).join(' · ');
  const w = snap.weather;
  return [greet.replace(/\.$/, ''), what, w ? `${w.tempC.toFixed(1)}°C, ${w.text}` : 'weather not answering'].filter(Boolean).join(' · ');
}

/** The amber line under the header: '3 to look at · Docker configs failed · 6 d · +2'. Null while
 *  something is red (the band lists them) or nothing is amber. */
export function amberSummary(snap: Pick<Snapshot, 'attention'>, ageOf: (since: number) => number) {
  const items = needsYou(snap.attention);
  if (!items.length || items[0].severity !== 'warn') return null;
  const worst1 = items[0];
  return { n: items.length, items, worst: worst1, age: worst1.since != null ? agoText(ageOf(worst1.since)) : null };
}
