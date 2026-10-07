import { useApp } from '../state.tsx';
import { ago, fmt, fmt1, last, paths, scaleMax, tint, uiUrl, whyMissing } from '../lib/util.ts';
import { Dot, MaybeLink, NotConnected, ellipsis, eyebrow, flexCol, mono, row, ruled } from '../lib/ui.tsx';
import { serverNow } from '../lib/live.ts';
import { Glint, Roll } from '../lib/motion.tsx';
import { SERIES_LEN, type LibraryKey, type ModuleId, type Snapshot } from '../../shared/types.ts';
import { on } from '../lib/modules.ts';
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

export const POSTER = 'linear-gradient(160deg,var(--poster-1),var(--poster-2))';
/** Poster background: the Tautulli artwork (proxied by the backend) over the warm skeleton. */
export const poster = (key?: string) => (key ? `url(/api/poster/${encodeURIComponent(key)}) center/cover no-repeat, ${POSTER}` : POSTER);
export const connText = (c?: string | null) => (c === 'connected' ? 'Connected' : c === 'firewalled' ? 'Firewalled' : c === 'disconnected' ? 'Offline' : '—');
export const connColor = (c?: string | null) => (c === 'connected' ? 'var(--ok)' : c === 'firewalled' ? 'var(--warn)' : c === 'disconnected' ? 'var(--danger)' : 'var(--mut-3)');
const AppTile = ({ m, h }: { m: string; h: number }) => <span style={{ width: 26, height: 26, borderRadius: 7, ...tint(h), display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, flex: 'none' }}>{m}</span>;
/** A number and its label; the number rolls when it changes (review 3e), and n, when given, glints each time it grows. */
const Stat = ({ v, k, warm, size = 20, n }: { v: ReactNode; k: string; warm?: boolean; size?: number; n?: number | null }) => (
  <div style={flexCol()}><span style={mono(size, undefined, { position: 'relative', alignSelf: 'flex-start' })}><Roll v={v} />{n !== undefined && <Glint n={n} />}</span><span style={{ fontSize: 11, color: warm ? 'var(--warn-sub)' : 'var(--mut-3)' }}>{k}</span></div>
);
/** A pipeline stage's state (review finding 15): what its hand-off to the next stage does (flow while it has work,
 *  idle, off while its source isn't connected, warn/danger while failing), and the line of text under its node. */
type Seg = 'flow' | 'idle' | 'off' | 'warn' | 'danger';
interface StageState { seg: Seg; text: string; title?: string }
const SEG_TEXT: Record<Seg, string> = { flow: 'var(--accent-hi)', idle: 'var(--mut-3)', off: 'var(--mut-3)', warn: 'var(--warn)', danger: 'var(--danger)' };
/** 'Not connected · needs PROWLARR_KEY' / 'Not answering · last ok 4 min ago': short enough for a stage (the tooltip has the rest) */
function offState(snap: Snapshot, src: string, what: string): StageState {
  const s = snap.sources.find(x => x.name === src), env = s?.needs?.match(/\(([A-Z0-9_, ]+)\)/)?.[1];
  const text = s?.conn === 'stale' || s?.conn === 'error' ? `Not answering${s.lastOk != null ? ` · last ok ${ago(s.lastOk)}` : ''}`
    : s?.conn === 'ok' || s?.conn === 'mock' ? 'No data' : `Not connected${env ? ` · needs ${env}` : ''}`;
  return { seg: 'off', text, title: whyMissing(snap, src, what) };
}
/** The five stages' states. dl: the summed qBittorrent + NZBGet rate this second (null: no sample). */
export function stageStates(snap: Snapshot, dl: number | null): StageState[] {
  const m = snap.media, p = snap.plex;
  const queued = m.sonarr || m.radarr || m.chaptarr ? (m.sonarr?.queued ?? 0) + (m.radarr?.queued ?? 0) + (m.chaptarr?.queued ?? 0) : null;
  // Download→Watch takes the better of the downloaders the lab has: flowing while either moves, failing only while
  // every one is blocked or offline. qBittorrent is blocked when firewalled or disconnected, NZBGet by a pause.
  const vpn = m.qbit?.conn, moving = dl != null && dl > 0;
  const hasQb = on(snap, 'qbittorrent'), hasNz = on(snap, 'nzbget');
  const qbWhy = !hasQb ? null : !m.qbit ? 'qBittorrent not answering' : vpn === 'firewalled' ? 'qBittorrent firewalled' : vpn === 'disconnected' ? 'qBittorrent offline' : null;
  const nzWhy = !hasNz ? null : !m.nzbget ? 'NZBGet not answering' : m.nzbget.paused ? 'NZBGet paused' : null;
  const blocked = [qbWhy, nzWhy].filter(Boolean);
  return [
    !m.seerr ? offState(snap, 'seerr', 'Seerr') : m.seerr.pending > 0 ? { seg: 'flow', text: `${fmt(m.seerr.pending)} pending` } : { seg: 'idle', text: 'Idle · 0 pending' },
    queued == null ? offState(snap, 'prom-media', 'exportarr') : queued > 0 ? { seg: 'flow', text: `Searching · ${fmt(queued)} queued` } : { seg: 'idle', text: 'Idle · nothing queued' },
    !m.prowlarr ? offState(snap, 'prowlarr', 'Prowlarr')
      : { seg: queued ? 'flow' : 'idle', text: `${queued ? 'Searching' : 'Idle'} · ${m.prowlarr.indexers.length} indexers` },
    !m.qbit && !m.nzbget ? offState(snap, 'prom-media', 'qBittorrent and NZBGet')
      : moving ? { seg: 'flow', text: `Downloading · ↓ ${fmt1(dl)} MB/s` }
        : blocked.length && blocked.length === [hasQb, hasNz].filter(Boolean).length ? { seg: vpn === 'disconnected' ? 'danger' : 'warn', text: blocked.join(' · ') }
          : { seg: 'idle', text: dl == null ? 'No rate right now' : 'Idle · nothing moving' },
    p.streams == null ? offState(snap, 'tautulli', 'Tautulli') : { seg: 'idle', text: p.streams ? `${p.streams} streaming` : 'Nothing playing' },
  ];
}
/** Download→Watch's packets (review 3a): how fast and how many for this rate (MB/s); null while nothing moves. */
export function packetBand(dl: number | null): { dur: number; n: number } | null {
  if (dl == null || !(dl > 0)) return null;
  return dl >= 20 ? { dur: 0.9, n: 6 } : dl >= 5 ? { dur: 1.4, n: 4 } : { dur: 2.6, n: 2 };
}
/** One hand-off: from the right of its stage's node to the next stage's node, 2px. Flow: accent dashes over the line
 *  (with a band: packets on the plain line instead, keyed by the band so a new rate in the same band doesn't restart
 *  them; reduced motion keeps the still dashes); idle: the line; off: dotted; failing: the tier's colour with a gap
 *  over its middle 16 %. */
const Segment = ({ seg, band }: { seg: Seg; band?: { dur: number; n: number } | null }) => {
  const c = seg === 'warn' ? 'var(--warn)' : seg === 'danger' ? 'var(--danger)' : null;
  const packets = seg === 'flow' && band ? band : null;
  return (
    <div aria-hidden="true" data-seg={seg} style={{ position: 'absolute', left: 24, right: -36, top: 11, height: 2 }}>
      <svg width="100%" height="2" style={{ display: 'block', overflow: 'visible' }}>
        {c ? <><line x1="0" x2="42%" y1="1" y2="1" stroke={c} strokeWidth="2" /><line x1="58%" x2="100%" y1="1" y2="1" stroke={c} strokeWidth="2" /></>
          : <line x1="0" x2="100%" y1="1" y2="1" stroke={seg === 'off' ? 'var(--mut-5)' : 'var(--line)'} strokeWidth="2" strokeDasharray={seg === 'off' ? '2 5' : undefined} />}
        {seg === 'flow' && <line x1="0" x2="100%" y1="1" y2="1" className={packets ? 'flow rm-only' : 'flow'} stroke="var(--accent)" strokeWidth="2" strokeDasharray="3 9" style={{ animationDuration: '1.1s' }} />}
      </svg>
      {packets && Array.from({ length: packets.n }, (_, k) => (
        <span key={`${packets.dur}-${k}`} className="packet" data-motion="" style={{ position: 'absolute', inset: 0, animation: `cc-run ${packets.dur}s linear infinite`, animationDelay: `${(-(packets.dur / packets.n) * k).toFixed(3)}s` }}>
          <span style={{ position: 'absolute', left: -3.5, top: -2.5, width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', boxShadow: 'var(--packet-glow)' }} />
        </span>
      ))}
    </div>
  );
};
/** A stage: its node (accent; the tier when failing; dashed when not connected; WATCH stays warm), its state line
 *  in the same colour, then its apps. The last stage has no hand-off. */
const Stage = ({ n, name, st, warm, last, band, children }: { n: number; name: string; st: StageState; warm?: boolean; last?: boolean; band?: { dur: number; n: number } | null; children: ReactNode }) => {
  const off = st.seg === 'off', fail = st.seg === 'warn' || st.seg === 'danger';
  const ring = warm ? 'var(--warn)' : fail ? SEG_TEXT[st.seg] : off ? 'var(--mut-5)' : 'var(--accent)';
  return (
    <div style={flexCol(12, { position: 'relative', minWidth: 0 })}>
      {!last && <Segment seg={st.seg} band={band} />}
      <div style={row(0, { position: 'relative' })}>
        <span style={{ width: 24, height: 24, boxSizing: 'border-box', borderRadius: '50%', background: 'var(--bg)', border: `2px ${off && !warm ? 'dashed' : 'solid'} ${ring}`, display: 'grid', placeItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: off && !warm ? 'var(--mut-3)' : ring }}>{n}</span>
        <span style={mono(11, fail ? ring : off ? 'var(--mut-3)' : 'var(--mut-1)', { padding: '0 10px', background: 'var(--bg)', letterSpacing: '.14em' })}>{name}</span>
      </div>
      <span title={st.title ?? st.text} style={{ fontSize: 12, color: warm ? 'var(--warn-sub)' : SEG_TEXT[st.seg], fontWeight: fail ? 600 : undefined, ...ellipsis }}>{st.text}</span>
      <div style={flexCol(16, { paddingTop: 4 })}>{children}</div>
    </div>
  );
};

/** Library health's 7-day change (review finding 17): shrinking reads green, growing by more than 5 % amber, a smaller
 *  change grey; '—' before there are 7 days of samples, or while the count itself can't be shown. */
export function changeLook(d: number | null | undefined, count: number | null | undefined): { text: string; color: string; title: string } {
  if (count == null) return { text: '—', color: 'var(--mut-3)', title: 'no count right now' };
  if (d == null) return { text: '—', color: 'var(--mut-3)', title: 'trend starts after 7 days of data' };
  const was = count - d;
  return {
    text: d === 0 ? 'no change' : `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))} this week`,
    color: d < 0 ? 'var(--ok)' : d > 0 && (was <= 0 || d / was > 0.05) ? 'var(--warn)' : 'var(--mut-3)',
    title: `${fmt(was)} seven days ago`,
  };
}

/** Library health's rows: the count, the app that has it, its page and the 7-day key; a row shows while its module is on. */
type LibRow = { l: string; src: string; v: (m: Snapshot['media']) => number | null | undefined; ui: string; path: string; k: LibraryKey; mod: ModuleId };
const LIBRARY_ROWS: LibRow[] = [
  { l: 'Missing subtitles', src: 'Bazarr', v: m => m.bazarr?.episodes, ui: 'bazarr', path: '/wanted/series', k: 'bazarr', mod: 'bazarr' },
  { l: 'Wanted episodes', src: 'Sonarr', v: m => m.sonarr?.wanted, ui: 'sonarr', path: '/wanted/missing', k: 'sonarrWanted', mod: 'sonarr' },
  { l: 'Missing movies', src: 'Radarr', v: m => m.radarr?.missing, ui: 'radarr', path: '/wanted/missing', k: 'radarrMissing', mod: 'radarr' },
  { l: 'Wanted movies', src: 'Radarr', v: m => m.radarr?.wanted, ui: 'radarr', path: '/wanted/missing', k: 'radarrWanted', mod: 'radarr' },
  { l: 'Missing books', src: 'Chaptarr', v: m => m.chaptarr?.missing, ui: 'chaptarr', path: '/wanted/missing', k: 'chaptarrMissing', mod: 'chaptarr' },
];
/** An app name that links to its web UI, e.g. the pipeline rows. */
const AppName = ({ name, ui, path, size = 14 }: { name: string; ui: string; path?: string; size?: number }) => {
  const { snap } = useApp();
  const href = uiUrl(snap, ui, path);
  return <MaybeLink href={href} label={`Open ${name}`} style={{ fontSize: size, fontWeight: 700 }}>{name}</MaybeLink>;
};
/** Which downloader the activity chart shows; remembered per browser (a view choice, not a control of anything) */
type Dl = 'qbit' | 'nzbget';
const DL_KEY = 'cc.downloadChart';
const readDl = (): Dl => { try { return localStorage.getItem(DL_KEY) === 'nzbget' ? 'nzbget' : 'qbit'; } catch { return 'qbit'; } };
/** fixed widths, so switching the source never moves the toggle or the readouts beside it */
const DlToggle = ({ v, set }: { v: Dl; set: (d: Dl) => void }) => (
  <div role="radiogroup" aria-label="Download chart source" style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 8, border: '1px solid var(--pill-bd)', flex: 'none' }}>
    {([['qbit', 'qBittorrent'], ['nzbget', 'NZBGet']] as const).map(([k, l]) => (
      <button key={k} type="button" role="radio" aria-checked={v === k} onClick={() => set(k)}
        style={{ font: 'inherit', fontSize: 12, fontWeight: 600, width: 84, padding: '4px 0', textAlign: 'center', borderRadius: 6, border: 0, cursor: 'pointer', background: v === k ? 'var(--accent-a14)' : 'transparent', color: v === k ? 'var(--accent)' : 'var(--mut-3)' }}>{l}</button>
    ))}
  </div>
);
/** a DOWN / UP readout, 150px and right-aligned whatever it shows; v undefined: this source has no such rate ('—', no unit) */
const Readout = ({ k, v, c, title }: { k: string; v: number | null | undefined; c: string; title?: string }) => (
  <div title={title} style={{ width: 150, flex: 'none', display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
    <span style={{ fontSize: 11, letterSpacing: '.14em', color: 'var(--mut-3)', fontWeight: 700 }}>{k}</span>
    <span style={mono(28, v == null ? 'var(--mut-3)' : c, { lineHeight: 1, whiteSpace: 'nowrap' })}>{fmt1(v)}{v !== undefined && <span style={{ fontSize: 13, color: 'var(--mut-3)' }}> MB/s</span>}</span>
  </div>
);
const Ext = ({ href }: { href: string | null }) => (href ? <span aria-hidden="true" style={{ color: 'var(--accent)', fontSize: 12, letterSpacing: 0 }}> ↗</span> : null);

/** qBittorrent + NZBGet this second; null when neither has a sample */
const dlBoth = (h: { qbDl: (number | null)[]; nzDl: (number | null)[] }) => { const q = last(h.qbDl), n = last(h.nzDl); return q == null && n == null ? null : (q ?? 0) + (n ?? 0); };

type Recent = Snapshot['plex']['recent'][number];
/** A Recently added item's identity: Tautulli's rating key (an older server sends none: its title, line and poster). */
export const recentKey = (r: Recent) => r.key ?? `${r.title}|${r.sub ?? ''}|${r.poster ?? ''}`;
/** How many items at the front of `now` are new since `before` (review 3f). 0 when plex.recent[0] isn't new, on the
 *  first snapshot after load (before null), around a gap (either list empty), and when the lists share nothing or
 *  more than three are new at once (a list reloaded, not arrivals). */
export function arrivals(before: Recent[] | null, now: Recent[]): number {
  if (!before?.length || !now.length) return 0;
  const known = new Set(before.map(recentKey));
  const n = now.findIndex(r => known.has(recentKey(r)));
  return n >= 1 && n <= 3 ? n : 0;
}
const ENTER_GAP = 400, ENTER_DONE = 2_800, HOUR = 3_600_000;
/** Recently added as drawn. New items enter one at a time, ENTER_GAP apart: `items` is the row as of the latest entry,
 *  `run` counts entries (the row's key, so its slide plays once per entry) and `fresh` is the entering item. ENTER_DONE
 *  after the last one starts (its pop and two flashes) the row settles on the snapshot's list. The list a snapshot
 *  replaced is noted at render time (`seen`), so React's double-run effects in development see the same one. */
function useRecent(recent: Recent[]) {
  const sig = recent.map(recentKey).join('\n');
  const seen = useRef<{ sig: string; items: Recent[]; before: Recent[] | null } | null>(null), run = useRef(0);
  if (seen.current?.sig !== sig) seen.current = { sig, items: recent, before: seen.current?.items ?? null };
  const [stage, setStage] = useState<{ items: Recent[]; run: number; fresh: string } | null>(null);
  // before paint, so the finished list never shows for a frame ahead of its slide
  useLayoutEffect(() => {
    const { items, before } = seen.current!, n = arrivals(before, items);
    setStage(null);
    if (!n || !before) return;
    const enter = (j: number) => setStage({ items: [...items.slice(n - 1 - j, n), ...before].slice(0, 7), run: ++run.current, fresh: recentKey(items[n - 1 - j]) });
    enter(0);
    const ts = Array.from({ length: n - 1 }, (_, j) => setTimeout(() => enter(j + 1), (j + 1) * ENTER_GAP));
    ts.push(setTimeout(() => setStage(null), (n - 1) * ENTER_GAP + ENTER_DONE));
    return () => ts.forEach(clearTimeout);
  }, [sig]);
  return stage ?? { items: recent, run: run.current, fresh: null };
}
/** Recently added: 7 posters (2:3), each titled with its sub-line (both layouts since Oct 6). A new arrival slides in at the front
 *  with a warm ring (review 3f); NEW marks what Tautulli added in the last hour. */
function RecentPosters({ gap, radius, titled }: { gap: number; radius: number; titled?: boolean }) {
  const { snap } = useApp();
  const { items, run, fresh } = useRecent(snap.plex.recent), now = serverNow();
  const slide = fresh ? { '--shift': `calc((100% + ${gap}px) / -7)`, animation: 'cc-shift .6s cubic-bezier(.2,.8,.2,1) both' } as CSSProperties : {};
  return (
    // clipped, so the entering poster waits off the left edge; padded, so its ring has room
    <div style={{ overflow: 'hidden', margin: '-8px -8px 0', padding: '8px 8px 0' }}>
      <div key={run} data-motion="" style={{ display: 'grid', gridTemplateColumns: 'repeat(7,minmax(0,1fr))', gap, ...slide }}>
        {Array.from({ length: 7 }, (_, i) => {
          const r = items[i], isNew = !!r && recentKey(r) === fresh, added = r?.addedAt != null && now - r.addedAt < HOUR;
          const art = (
            <div role={r ? 'img' : undefined} aria-label={r?.title ? `${r.title}${added ? ' (new)' : ''}` : undefined} title={titled ? undefined : r?.title || undefined} data-motion={isNew ? '' : undefined}
              style={{ position: 'relative', aspectRatio: '2/3', borderRadius: radius, background: poster(r?.poster), ...(isNew ? { animation: 'cc-pop .6s ease-out both, cc-flash 1.2s ease-out .3s 2' } : {}) }}>
              {added && <span style={{ position: 'absolute', left: 4, top: 4, padding: '0 5px', borderRadius: 4, background: 'var(--warn)', color: 'var(--on-accent)', fontSize: 11, fontWeight: 800, lineHeight: '16px' }}>NEW</span>}
            </div>
          );
          return !titled ? <div key={i}>{art}</div> : (
            <div key={i} style={flexCol(5, { minWidth: 0 })}>
              {art}
              {/* up to two lines, so a long title ('Escape to the Chateau') isn't cut after a word */}
              {r?.title && <span title={r.title} style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.3, color: 'var(--text-2)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', overflowWrap: 'anywhere' }}>{r.title}</span>}
              {r?.sub && <span title={r.sub} style={{ fontSize: 11, color: 'var(--mut-3)', ...ellipsis }}>{r.sub}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Row 1 while Tautulli says nothing plays (review finding 16): Plex shrinks to its eyebrow and Recently added takes the room, titles
 *  under the posters; Immich and Seerr are one line each, and Seerr's big number returns (amber) once a request waits. */
function IdleRow({ seerrPublic }: { seerrPublic: string | null }) {
  const { snap } = useApp();
  const plexOn = on(snap, 'plex'), imOn = on(snap, 'immich'), seOn = on(snap, 'seerr');
  if (!plexOn && !imOn && !seOn) return null;
  const m = snap.media, url = (ui: string, path = '') => uiUrl(snap, ui, path);
  const muted = { fontSize: 12, color: 'var(--mut-2)' } as const;
  const name = (n: string, href: string | null, label: string) => <MaybeLink href={href} label={label} style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', flex: 'none' }}>{n}<Ext href={href} /></MaybeLink>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: plexOn && (imOn || seOn) ? 'minmax(0,1fr) minmax(0,1fr)' : 'minmax(0,1fr)', gap: 48 }}>
      {plexOn && <div style={ruled('22px 0 22px', 'var(--warn-rule)', flexCol(14))}>
        <div style={row(10)}>
          <MaybeLink href={url('plex')} label="Open Plex" style={eyebrow('var(--warn)')}>Plex · nothing playing<Ext href={url('plex')} /></MaybeLink>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: 'var(--warn-sub)' }}>Recently added</span>
        </div>
        <RecentPosters gap={10} radius={5} titled />
      </div>}
      {(imOn || seOn) && <div style={ruled('22px 0 22px', 'var(--rule)', flexCol(12))}>
        {imOn && <div style={row(6, { ...muted, minWidth: 0 })}>
          {name('Immich', url('immich'), 'Open Immich')}
          <span style={{ minWidth: 0, ...ellipsis }}>{m.immich ? <>· <span style={mono(12)}>{fmt(m.immich.photos)}</span> photos · <span style={mono(12)}>{fmt(m.immich.videos)}</span> videos · <span style={mono(12)}>{fmt1(m.immich.sizeGiB)}</span> GiB</> : `· ${whyMissing(snap, 'immich', 'Immich')}`}</span>
        </div>}
        {seOn && <><div style={row(6, { ...muted, minWidth: 0 })}>
          {name('Seerr', url('seerr', '/requests'), 'Open Seerr requests')}
          <span style={{ minWidth: 0, flex: '0 1 auto', ...ellipsis }}>{m.seerr ? <>· {m.seerr.pending ? <><span style={mono(12)}>{fmt(m.seerr.pending)}</span> pending</> : 'nothing pending'} · <span style={mono(12)}>{fmt(m.seerr.approved)}</span> approved · <span style={mono(12)}>{fmt(m.seerr.completed)}</span> completed</> : `· ${whyMissing(snap, 'seerr', 'Seerr')}`}</span>
          <MaybeLink href={seerrPublic} label="Open Seerr's public address" style={{ padding: '1px 6px', borderRadius: 5, border: '1px solid var(--pub-bd)', color: 'var(--pub-fg)', fontSize: 11, fontWeight: 700, flex: 'none' }}>PUBLIC</MaybeLink>
        </div>
        {!!m.seerr?.pending && (
          <MaybeLink href={url('seerr', '/requests')} label="Open Seerr requests" style={flexCol(4, { paddingTop: 6, alignSelf: 'flex-start' })}>
            <span style={mono(40, 'var(--warn)', { fontWeight: 500, lineHeight: 1 })}>{fmt(m.seerr.pending)}</span>
            <span style={{ fontSize: 13, color: 'var(--mut-2)' }}>pending approval</span>
          </MaybeLink>
        )}</>}
      </div>}
    </div>
  );
}

export function Media() {
  const { snap, live } = useApp();
  const m = snap.media, p = snap.plex, np = p.nowPlaying;
  const [dlSrc, setDlSrcState] = useState<Dl>(readDl);
  const setDlSrc = (d: Dl) => { setDlSrcState(d); try { localStorage.setItem(DL_KEY, d); } catch { /* private window: not remembered */ } };
  const nzb = m.nzbget;

  const url = (ui: string, path = '') => uiUrl(snap, ui, path);
  const seerrPublic = snap.health.exposure.find(x => /seerr|overseer/i.test(`${x.name} ${x.host}`))?.url ?? null;
  const media = whyMissing(snap, 'prom-media', 'exportarr');
  // qBittorrent's own rate for its row (dlNow follows the chart's choice, which may be NZBGet)
  const rate = dlBoth(live.history), st = stageStates(snap, rate), vpn = m.qbit?.conn, qbNow = last(live.history.qbDl);
  // what this lab has: the pipeline needs two stages, Download activity a downloader, Library health a counted app
  const has = { qb: on(snap, 'qbittorrent'), nz: on(snap, 'nzbget'), plex: on(snap, 'plex'), immich: on(snap, 'immich'), seerr: on(snap, 'seerr') };
  const stagesOn = [on(snap, 'seerr'), on(snap, 'sonarr', 'radarr', 'chaptarr'), on(snap, 'prowlarr'), has.qb || has.nz, has.plex].filter(Boolean).length;
  const libRows = LIBRARY_ROWS.filter(r => on(snap, r.mod));
  const dlView = has.qb && has.nz ? dlSrc : has.nz ? 'nzbget' : 'qbit', nz = dlView === 'nzbget';
  const dl = nz ? live.history.nzDl : live.history.qbDl, ul = nz ? [] : live.history.qbUl, dlNow = last(dl), ulNow = nz ? null : last(ul);
  const qmax = scaleMax([...dl, ...ul], 10), d2 = paths(dl, 600, 120, qmax), u2 = paths(ul, 600, 120, qmax);
  return (
    <div style={flexCol(16)}>
      {/* the full row while something plays, and while Tautulli isn't answering (then nobody can say nothing plays) */}
      {has.plex && (np || p.streams == null) ? <div style={{ display: 'grid', gridTemplateColumns: ['1.4fr', has.immich && '1fr', has.seerr && '1fr'].filter(Boolean).join(' '), gap: 48 }}>
        <div style={ruled('22px 0 22px', 'var(--warn-rule)', flexCol(18))}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <MaybeLink href={url('plex')} label="Open Plex" style={eyebrow('var(--warn)')}>Plex · now playing<Ext href={url('plex')} /></MaybeLink>
            <MaybeLink href={url('tautulli')} label="Open Tautulli" style={{ fontSize: 12, color: 'var(--warn-sub)' }}>{p.streams == null ? whyMissing(snap, 'tautulli', 'Tautulli') : `${p.streams} active stream${p.streams === 1 ? '' : 's'} · via Tautulli`}</MaybeLink>
          </div>
          <div style={row(18)}>
            <div style={{ width: 92, height: 136, borderRadius: 8, background: poster(np?.poster), flex: 'none' }} />
            {np ? (
              <div style={flexCol(6, { minWidth: 0, flex: 1 })}>
                {np.state !== 'playing' && <span style={eyebrow('var(--warn)', 11)}>{np.state}</span>}
                <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.01em' }}>{np.title}</span>
                <span style={{ fontSize: 13, color: 'var(--warn-sub)' }}>{np.sub} · {np.user}</span>
                <div style={{ height: 4, borderRadius: 2, background: 'var(--rule-3)', overflow: 'hidden', marginTop: 6 }}><div style={{ width: `${np.progress}%`, height: '100%', background: np.state === 'playing' ? 'var(--warn)' : 'var(--warn-sub)' }} /></div>
                {p.others > 0 && <MaybeLink href={url('tautulli')} label="Open Tautulli activity" style={{ fontSize: 12, fontWeight: 600, color: 'var(--warn)' }}>+{p.others} more stream{p.others === 1 ? '' : 's'}</MaybeLink>}
              </div>
            ) : (
              // only reached while Tautulli isn't answering (a known idle Plex gets IdleRow): say so, don't guess
              <div style={flexCol(6)}>
                <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.01em', color: 'var(--mut-3)' }}>Can't see what's playing</span>
              </div>
            )}
          </div>
          <div style={flexCol(8)}>
            <span style={eyebrow('var(--warn-sub)')}>Recently added</span>
            <RecentPosters gap={8} radius={6} titled />
          </div>
        </div>

        {has.immich && <div style={ruled('22px 0 22px', 'var(--rule)', flexCol(16))}>
          <div style={row(10)}><div style={{ width: 30, height: 30, borderRadius: 8, ...tint(330), display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800 }}>IM</div><MaybeLink href={url('immich')} label="Open Immich" style={{ flex: 1, ...eyebrow() }}>Immich · photos<Ext href={url('immich')} /></MaybeLink><Dot size={7} color={m.immich ? 'var(--ok)' : 'var(--mut-5)'} /></div>
          {m.immich ? <>
            <div style={flexCol()}><span style={mono(40, undefined, { fontWeight: 500, lineHeight: 1 })}>{fmt(m.immich.photos)}</span><span style={{ fontSize: 13, color: 'var(--mut-2)', paddingTop: 4 }}>photos</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              <Stat v={fmt(m.immich.videos)} k="Videos" size={17} /><Stat v={fmt1(m.immich.sizeGiB)} k="GiB" size={17} /><Stat v={m.immich.users} k={m.immich.users === 1 ? 'User' : 'Users'} size={17} />
            </div>
          </> : <NotConnected what="Immich" src="immich" />}
        </div>}

        {has.seerr && <div style={ruled('22px 0 22px', 'var(--rule)', flexCol(16))}>
          <div style={row(10)}><div style={{ width: 30, height: 30, borderRadius: 8, ...tint(290), display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800 }}>SE</div><MaybeLink href={url('seerr', '/requests')} label="Open Seerr requests" style={{ flex: 1, ...eyebrow() }}>Seerr · requests<Ext href={url('seerr')} /></MaybeLink><MaybeLink href={seerrPublic} label="Open Seerr's public address" style={{ padding: '2px 7px', borderRadius: 5, border: '1px solid var(--pub-bd)', color: 'var(--pub-fg)', fontSize: 11, fontWeight: 700 }}>PUBLIC</MaybeLink></div>
          {m.seerr ? <>
            <div style={flexCol()}><span style={mono(40, undefined, { fontWeight: 500, lineHeight: 1 })}>{fmt(m.seerr.pending)}</span><span style={{ fontSize: 13, color: 'var(--mut-2)', paddingTop: 4 }}>pending approval</span></div>
            <div style={flexCol(8)}>
              <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', gap: 2 }}><div style={{ flex: m.seerr.approved, background: 'var(--accent)' }} /><div style={{ flex: m.seerr.completed, background: 'var(--ok)' }} /></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                <span style={{ color: 'var(--mut-2)' }}><span style={{ color: 'var(--accent)' }}>●</span> {fmt(m.seerr.approved)} approved</span>
                <span style={{ color: 'var(--mut-2)' }}><span style={{ color: 'var(--ok)' }}>●</span> {fmt(m.seerr.completed)} completed</span>
              </div>
            </div>
          </> : <NotConnected what="Seerr" src="seerr" />}
        </div>}
      </div> : <IdleRow seerrPublic={seerrPublic} />}

      {stagesOn >= 2 && (
      <div style={ruled('22px 0 22px', 'var(--rule)', flexCol(18))}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}><span style={{ fontSize: 17, fontWeight: 700 }}>Acquisition pipeline</span><span style={{ fontSize: 13, color: 'var(--mut-3)' }}>Request → manage → search → download → watch</span></div>
        <div>
          {(() => {
            const parts: { key: string; w: string; el: (n: number, last: boolean) => ReactNode }[] = [];
            if (on(snap, 'seerr')) parts.push({ key: 'request', w: '1fr', el: (n, last) => (
            <Stage n={n} last={last} name="REQUEST" st={st[0]}>
              <div style={row(9)}><AppTile m="SE" h={290} /><AppName name="Seerr" ui="seerr" path="/requests" /></div>
              <div style={{ display: 'flex', gap: 20 }}><Stat v={fmt(m.seerr?.approved)} k="approved" /><Stat v={fmt(m.seerr?.pending)} k="pending" /></div>
            </Stage>
            ) });
            if (on(snap, 'sonarr', 'radarr', 'chaptarr')) parts.push({ key: 'manage', w: '1.45fr', el: (n, last) => (
            <Stage n={n} last={last} name="MANAGE" st={st[1]}>
              <div style={flexCol(11)}>
                {on(snap, 'sonarr') && <div style={row(9)}><AppTile m="SO" h={210} /><span style={{ flex: 1 }}><AppName name="Sonarr" ui="sonarr" path="/activity/queue" /></span><span style={mono(12, 'var(--mut-1)', { whiteSpace: 'nowrap' })} title={m.sonarr ? undefined : media}>{m.sonarr ? `${fmt(m.sonarr.series)} series · ${fmt(m.sonarr.queued)} queued` : '—'}</span></div>}
                {on(snap, 'radarr') && <div style={row(9)}><AppTile m="RA" h={70} /><span style={{ flex: 1 }}><AppName name="Radarr" ui="radarr" path="/activity/queue" /></span><span style={mono(12, 'var(--mut-1)', { whiteSpace: 'nowrap' })} title={m.radarr ? undefined : media}>{m.radarr ? `${fmt(m.radarr.movies)} movies · ${fmt(m.radarr.queued)} queued` : '—'}</span></div>}
                {on(snap, 'chaptarr') && <div style={row(9)}><AppTile m="CH" h={20} /><span style={{ flex: 1 }}><AppName name="Chaptarr" ui="chaptarr" path="/activity/queue" /></span><span style={mono(12, 'var(--mut-1)', { whiteSpace: 'nowrap' })} title={m.chaptarr ? `${fmt(m.chaptarr.books)} of ${fmt(m.chaptarr.booksTotal)} monitored books on disk · ${fmt(m.chaptarr.authors)} authors` : 'Chaptarr not connected'}>{m.chaptarr ? `${fmt(m.chaptarr.books)} books · ${fmt(m.chaptarr.queued)} queued` : '—'}</span></div>}
              </div>
            </Stage>
            ) });
            if (on(snap, 'prowlarr')) parts.push({ key: 'search', w: '1.3fr', el: (n, last) => (
            <Stage n={n} last={last} name="SEARCH" st={st[2]}>
              <div style={row(9)}><AppTile m="PR" h={35} /><span style={{ flex: 1 }}><AppName name="Prowlarr" ui="prowlarr" /></span>{m.prowlarr && <span style={mono(12, 'var(--mut-1)', { whiteSpace: 'nowrap' })}>{m.prowlarr.indexers.length} indexers</span>}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{(m.prowlarr?.indexers ?? []).map(i => <span key={i} style={{ padding: '3px 8px', borderRadius: 99, border: '1px solid var(--pill-bd)', fontSize: 11, color: 'var(--mut-1)' }}>{i}</span>)}</div>
            </Stage>
            ) });
            if (on(snap, 'qbittorrent', 'nzbget')) parts.push({ key: 'download', w: '1.35fr', el: (n, last) => (
            <Stage n={n} last={last} name="DOWNLOAD" st={st[3]} band={packetBand(rate)}>
              <div style={flexCol(11)}>
                {has.qb && <><div style={row(9)}><AppTile m="QB" h={240} /><div style={{ flex: 1, ...flexCol() }}><AppName name="qBittorrent" ui="qbittorrent" />
                  {/* a blocked qBittorrent is its problem only: amber here, the hand-off follows NZBGet too */}
                  <span style={{ fontSize: 11, color: vpn === 'firewalled' || vpn === 'disconnected' ? 'var(--warn)' : 'var(--mut-3)', fontWeight: vpn === 'firewalled' || vpn === 'disconnected' ? 600 : undefined }}>{[snap.ui.qbittorrentVia && `via ${snap.ui.qbittorrentVia}`, vpn === 'firewalled' ? 'firewalled' : vpn === 'disconnected' ? 'disconnected' : vpn === 'connected' ? (snap.ui.qbittorrentVia ? '' : 'connected') : 'connection unknown'].filter(Boolean).join(' · ')}</span></div><span style={mono(12, qbNow == null ? 'var(--mut-3)' : 'var(--accent)')}>↓{fmt1(qbNow)}</span></div></>}
                {has.nz && <div style={row(9)}><AppTile m="NZ" h={145} /><span style={{ flex: 1 }}><AppName name="NZBGet" ui="nzbget" /></span><span style={mono(12, 'var(--mut-1)', { whiteSpace: 'nowrap' })} title={m.nzbget ? undefined : media}>{m.nzbget ? `${fmt1(m.nzbget.todayGB)} GB today` : '—'}</span></div>}
              </div>
            </Stage>
            ) });
            if (on(snap, 'plex')) parts.push({ key: 'watch', w: '1fr', el: (n, last) => (
            <Stage n={n} name="WATCH" st={st[4]} warm last={last}>
              <div style={row(9)}><AppTile m="PL" h={80} /><AppName name="Plex" ui="plex" /></div>
              <div style={{ display: 'flex', gap: 20 }}><Stat v={fmt(p.movies)} n={p.movies} k="movies" warm /><Stat v={fmt(p.shows)} n={p.shows} k="shows" warm /></div>
            </Stage>
            ) });
            if (parts.length < 2) return null; // one stage is not a pipeline
            return (
              <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: parts.map(x => x.w).join(' '), gap: 36 }}>
                {parts.map((x, i) => <Fragment key={x.key}>{x.el(i + 1, i === parts.length - 1)}</Fragment>)}
              </div>
            );
          })()}
        </div>
      </div>
      )}

      {(has.qb || has.nz || libRows.length > 0) && <div style={{ display: 'grid', gridTemplateColumns: has.qb || has.nz ? (libRows.length ? '1.6fr 1fr' : '1fr') : '1fr', gap: 48 }}>
        {(has.qb || has.nz) && <>
        <div style={ruled('22px 0 22px', 'var(--rule)', flexCol(14))}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28 }}>
            <div style={{ flex: 1, ...flexCol(2) }}><span style={{ fontSize: 17, fontWeight: 700 }}>Download activity</span><span style={{ fontSize: 13, color: 'var(--mut-3)' }}>{nz ? <AppName name="NZBGet" ui="nzbget" size={13} /> : <AppName name="qBittorrent" ui="qbittorrent" size={13} />} · last {SERIES_LEN}s{dlNow == null && ulNow == null ? ' · no data right now' : ''}</span></div>
            {has.qb && has.nz && <DlToggle v={dlSrc} set={setDlSrc} />}
            {/* both readouts always, so nothing above the chart moves when the source changes; NZBGet doesn't upload */}
            <Readout k="DOWN" v={dlNow} c="var(--accent)" />
            <Readout k="UP" v={nz ? undefined : ulNow} c="var(--accent-2)" title={nz ? "NZBGet doesn't upload" : undefined} />
          </div>
          <svg width="100%" height="140" viewBox="0 0 600 120" preserveAspectRatio="none" style={{ borderBottom: '1px solid var(--rule-2)' }} aria-hidden="true">
            <path d={d2.area} fill="var(--accent-a14)" /><path d={d2.line} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            {!nz && <path d={u2.line} fill="none" stroke="var(--accent-2)" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
          </svg>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 8 }}>
            {nz ? <>
              <Stat v={nzb ? `${fmt1(nzb.todayGB)} GB` : '—'} k="Today" size={18} /><Stat v={nzb?.queueGB != null ? `${fmt1(nzb.queueGB)} GB` : '—'} k="Queue" size={18} />
              <div style={flexCol()}><span style={mono(18, nzb?.paused ? 'var(--warn)' : nzb ? 'var(--ok)' : 'var(--mut-3)')}>{!nzb || nzb.paused == null ? '—' : nzb.paused ? 'Paused' : (dlNow ?? 0) > 0 ? 'Downloading' : 'Idle'}</span><span style={{ fontSize: 11, color: 'var(--mut-3)' }}>NZBGet</span></div>
              {/* the mirror of 'NZBGet today' on the qBittorrent side: always four columns */}
              <Stat v={m.qbit?.todayGB != null ? `${fmt1(m.qbit.todayGB)} GB` : '—'} k="qBittorrent today" size={18} />
            </> : <>
              <Stat v={fmt(m.qbit?.leeching)} k="Leeching" size={18} /><Stat v={fmt(m.qbit?.seeding)} k="Seeding" size={18} />
              <Stat v={m.nzbget ? `${fmt1(m.nzbget.todayGB)} GB` : '—'} k="NZBGet today" size={18} />
              <div style={flexCol()}><span style={mono(18, connColor(m.qbit?.conn))}>{connText(m.qbit?.conn)}</span><span style={{ fontSize: 11, color: 'var(--mut-3)' }}>qBittorrent{snap.ui.qbittorrentVia ? ` via ${snap.ui.qbittorrentVia.split(' · ')[0]}` : ''}</span></div>
            </>}
          </div>
        </div>
        </>}
        {libRows.length > 0 && <>
        <div style={ruled('22px 0 22px', 'var(--rule)', flexCol(4))}>
          <span style={{ fontSize: 17, fontWeight: 700, paddingBottom: 8 }}>Library health</span>
          {libRows.map(r => { const v = r.v(m), href = url(r.ui, r.path), c = changeLook(m.delta7?.[r.k], v); return (
            <MaybeLink key={r.l} href={href} label={`${r.l} in ${r.src}`} style={row(10, { padding: '9px 0', borderBottom: '1px solid var(--rule-3)', color: 'var(--text)' })}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, ...ellipsis }}>{r.l}</span><span style={{ fontSize: 12, color: 'var(--mut-3)', flex: 'none' }}>{r.src}{href ? ' ↗' : ''}</span>
              <span style={mono(13, v == null ? 'var(--mut-3)' : undefined, { minWidth: 60, textAlign: 'right', flex: 'none' })}>{fmt(v)}</span>
              <span title={c.title} style={mono(12, c.color, { minWidth: 96, textAlign: 'right', flex: 'none', whiteSpace: 'nowrap' })}>{c.text}</span>
            </MaybeLink>
          ); })}
        </div>
        </>}
      </div>}
    </div>
  );
}
