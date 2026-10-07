// Phone layout (< 1152px): full-bleed screens (a centred 560px column on wider windows), a floating
// 5-tab bar (Open = services and bookmarks under one search; Devices sits under Health), a tappable network tree and a guest detail screen. Every hit target is at least 44px and
// the page pads for the notch and the home bar. Same rules as desktop (docs/V3.1-LIVE.md): nothing old shown as current, every dot from
// data, and Home Assistant is display-only. Phones have no hover, so reasons are written out.
import { Fragment, useState, type CSSProperties, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { classicOverview, useApp, type MTab } from '../state.tsx';
import { on as modOn, visibleMTabs } from '../lib/modules.ts';
import { linkChip, linkState, useNow } from '../lib/live.ts';
import {
  GUEST_HUE, STATUS_WORD, ago, agoShort, agoText, aged, cellColor, clockSec, fmt, fmt1, fmtBytes, fullIp, greeting, hueOf, jobAgo, jobColor, jobText, last, monoOf, paths, pveUrl, scaleMax,
  scrollToId, secSince, sevColors, statusColor, statusText, tint, toneColor, uiUrl, whenText, whyMissing,
} from '../lib/util.ts';
import { Badge, Bar, Chip, Dot, FrozenBanner, NotConnected, SR, SearchIcon, StatusDot, Tag, UptimeCells, ellipsis, eyebrow, flexCol, mono, row, ruled, useFrozen } from '../lib/ui.tsx';
import { matches, shortUrl } from '../lib/search.ts';
import { attnHeader, needsYou, openItems, resRows, type LaunchItem } from '../desktop/Overview.tsx';
import { bandModel, incidentItem, type Band } from '../lib/incident.ts';
import { phonePins } from '../lib/groups.ts';
import { DiskBlock, JobPill, NoMonitorLine, groupColor, msColor, sourcesLine, uptimeWindow, useAlertFold } from '../desktop/Health.tsx';
import { STATUS_RANK, alertingRows, automationRows, groupJobs, problemsFirst, sectionIndex, shortLabel, shownMembers, sourcesFirst, storageParts, unitRows, type JobGroup, sectionOn 
} from '../../shared/health.ts';
import { changeLook, connColor, connText, poster } from '../desktop/Media.tsx';
import { TIER_C, Toner, applianceSummary, climateLine, climateTarget, homeState, homeSummary, lightRooms, lightsSub, lockLook, lockNotes, smokeLook } from '../desktop/Home.tsx';
import { useLinkFilter } from '../desktop/Links.tsx';
import { EditButton, LinksEditorView, LinksNote, useLinksEditor } from '../desktop/LinksEdit.tsx';
import { DevDot, Hl, devCounts, devIp, groupSub, lanFolded, lanRows, matchedLine, useDeviceGroups } from '../desktop/Devices.tsx';
import { DisksBlock, NotYetLine, OPS_COLS, OpsEmpty, OpsRow, PowerBlock, UpdatesLine, UpsHomeRow, opsMissing } from '../desktop/Ops.tsx';
import { Heartbeat, useBeatClock } from '../lib/motion.tsx';
import type { Attention, Conn, DeviceRow, DevicesView, JobView, Kpi, LeafView, Monitor, Res, Snapshot, SourceView, Status, Volume } from '../../shared/types.ts';

// side gutters grow with the landscape safe area; the bottom clears the tab bar and the home indicator. Wider windows
// (a tablet, a half-screen browser) get a centred 560px column; it's content-box, so the gutters add to it.
const COL = 560;
const PAGE: CSSProperties = { maxWidth: COL, margin: '0 auto', padding: '10px max(20px, env(safe-area-inset-right)) calc(120px + env(safe-area-inset-bottom)) max(20px, env(safe-area-inset-left))', display: 'flex', flexDirection: 'column' };
/** a side inset that keeps the safe area on a phone and centres a COL-wide box on a wider window */
const side = (min: number, edge: 'left' | 'right') => `max(${min}px, env(safe-area-inset-${edge}), calc((100% - ${COL}px) / 2))`;
const BLEED: CSSProperties = { margin: '0 -20px', padding: '0 20px' };
const EXT = { target: '_blank', rel: 'noopener noreferrer' } as const;
const RULE3 = '1px solid var(--rule-3)';
const GLASS = 'color-mix(in srgb, var(--surface) 85%, transparent)';
const eb = (c = 'var(--mut-3)') => eyebrow(c);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const tileS = (hue: number, extra: CSSProperties = {}): CSSProperties => ({ width: 30, height: 30, borderRadius: 8, ...tint(hue), display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, flex: 'none', ...extra });
const kpiColor = (t?: Kpi['tone']) => (t === 'pub' ? 'var(--pub-fg)' : toneColor(t));
const pctOf = (u: number | null, t: number | null) => (u != null && t ? (u / t) * 100 : null);
// the same display thresholds as desktop Home (attentionRules isn't in the Snapshot)
const LOCK_BATTERY_LOW = 30, TONER_LOW = 10;

/** A short reason for a missing number: 'not connected' / 'not answering' (the full one is on Health → Sources). */
const srcWord = (snap: Snapshot, src: string) => {
  const s = snap.sources.find(x => x.name === src);
  return !s || s.conn === 'not-connected' ? 'not connected' : s.conn === 'stale' || s.conn === 'error' ? 'not answering' : '—';
};
const NO_DATA = /^(—|not )/;

const Empty = ({ children }: { children: ReactNode }) => <span style={{ fontSize: 12, color: 'var(--mut-3)', padding: '12px 0', lineHeight: 1.4 }}>{children}</span>;
/** A text link padded to a 44px tap target (inline links are too small for a thumb). */
const TapLink = ({ href, children, label }: { href: string; children: ReactNode; label?: string }) =>
  <a href={href} {...EXT} aria-label={label} style={row(4, { minHeight: 44, fontSize: 13, fontWeight: 600, color: 'var(--accent)', flex: 'none', whiteSpace: 'nowrap' })}>{children}</a>;
/** 'Show all 24 ▾' / 'Hide ▴', full width so it is easy to hit. */
const More = ({ open, onClick, children }: { open: boolean; onClick: () => void; children: ReactNode }) => (
  <button aria-expanded={open} onClick={onClick} style={row(6, { minHeight: 44, width: '100%', boxSizing: 'border-box', fontSize: 13, fontWeight: 600, color: 'var(--accent)' })}>
    {children}<span aria-hidden="true">{open ? '▴' : '▾'}</span>
  </button>
);
/** Eyebrow title over a 1px rule. id = the anchor ⌘K jumps to (same ids as desktop). */
const Section = ({ id, title, sub, right, children }: { id?: string; title: string; sub?: string; right?: ReactNode; children: ReactNode }) => (
  <section id={id} style={flexCol(6, { scrollMarginTop: 16 })}>
    <div style={row(8, { minWidth: 0, minHeight: 20 })}>
      <span style={{ ...eb(), flex: 'none' }}>{title}</span>
      {sub && <span style={{ fontSize: 11, color: 'var(--mut-3)', minWidth: 0, ...ellipsis }}>{sub}</span>}
      {right && <><span style={{ flex: 1 }} />{right}</>}
    </div>
    <div style={flexCol(0, { borderTop: '1px solid var(--rule)' })}>{children}</div>
  </section>
);
const Strip = ({ days }: { days: Status[] }) => (
  <div style={{ display: 'flex', gap: 2, flex: 'none' }} role="img" aria-label="last 14 days">{days.map((d, j) => <span key={j} style={{ width: 4, height: 12, borderRadius: 1, background: cellColor(d) }} />)}</div>
);

/** LIVE / PARTIAL / STALE / OFFLINE and when the data on screen is from. */
function LinkLine() {
  const { snap, live } = useApp();
  const now = useNow();
  const st = linkState(live, now.getTime()), chip = linkChip(st, snap);
  const bad = snap.fresh.stale.length + snap.fresh.errors.length;
  const why = st === 'offline' ? 'reconnecting…' : st === 'stale' ? 'no new data from the server' : snap.mock ? 'sample values' : snap.simulated ? 'one failure is made up' : st === 'partial' ? `${plural(bad, 'source')} not answering` : '';
  return (
    <div data-link={st} style={row(6, { fontSize: 11, color: 'var(--mut-3)', letterSpacing: '.06em', minWidth: 0, whiteSpace: 'nowrap' })}>
      <Dot size={6} color={chip.color} pulse={chip.pulse ? 'ok2' : undefined} />
      <span style={{ fontWeight: 700, flex: 'none', color: chip.pulse ? 'var(--mut-2)' : chip.color }}>{chip.label}</span>
      <span style={{ minWidth: 0, ...ellipsis }}>· updated <span style={mono(11)}>{live.lastSnapshotAt ? clockSec(new Date(live.lastSnapshotAt)) : '—'}</span>{why && ` · ${why}`}</span>
    </div>
  );
}
const H1 = ({ children, right }: { children: ReactNode; right?: ReactNode }) => (
  <div style={flexCol(4)}>
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}><span style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-.02em' }}>{children}</span>{right}</div>
    <LinkLine />
  </div>
);
const SearchField = ({ value, onChange, placeholder, id }: { value: string; onChange: (v: string) => void; placeholder: string; id?: string }) => (
  <label style={row(10, { minHeight: 46, borderBottom: '1px solid var(--rule)' })}>
    <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>/</span>
    <input id={id} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder} autoCapitalize="off" autoComplete="off" type="search" enterKeyHint="search"
      style={{ flex: 1, minWidth: 0, background: 'transparent', border: 0, outline: 'none', color: 'var(--text)', font: '500 16px var(--font-ui)', appearance: 'none', WebkitAppearance: 'none' }} />
  </label>
);

export function Mobile() {
  const { ui: u0, set, snap: s0 } = useApp();
  // a tab whose modules a config reload turned off falls back to Overview (Devices sits under Health)
  const ui = u0.mTab === 'Devices' || visibleMTabs(s0).includes(u0.mTab) ? u0 : { ...u0, mTab: 'Overview' as MTab };
  const screen = ui.mTab === 'Overview' ? (ui.mScreen === 'guest' ? <MGuest /> : <MOverview />)
    : ui.mTab === 'Open' ? <MOpen /> : ui.mTab === 'Media' ? <MMedia /> : ui.mTab === 'Health' ? <MHealth /> : ui.mTab === 'House' ? <MHome /> : <MDevices />;
  const { snap } = useApp();
  const go = (t: MTab) => { set({ mTab: t, mScreen: 'home' }); scrollTo(0, 0); };
  const old = useFrozen();
  // review Phase 5: the Overview glows red while its incident hero leads (never over old data)
  const red = ui.mTab === 'Overview' && ui.mScreen === 'home' && !classicOverview() && !old && !!incidentItem(snap);
  return (
    <div style={{ minHeight: '100vh', background: red ? 'var(--bg-mobile-glow-danger)' : 'var(--bg-mobile-glow)', color: 'var(--text)', paddingTop: 'max(16px, env(safe-area-inset-top))', overflowX: 'clip' }}>
      <FrozenBanner style={{ margin: `0 ${side(20, 'right')} 8px ${side(20, 'left')}`, padding: '10px 0' }} />
      {/* the tab bar stays outside: a filter on its ancestor would pin it to the page instead of the screen */}
      <div className={old ? 'frozen' : undefined}>{screen}</div>
      <nav role="tablist" style={{ position: 'fixed', left: side(12, 'left'), right: side(12, 'right'), bottom: 'max(22px, env(safe-area-inset-bottom))', height: 64, borderRadius: 24, background: GLASS, backdropFilter: 'blur(18px)', WebkitBackdropFilter: 'blur(18px)', border: '1px solid var(--pill-bd)', display: 'grid', gridTemplateColumns: `repeat(${visibleMTabs(snap).length},1fr)`, alignItems: 'stretch', textAlign: 'center', fontSize: 11, fontWeight: 600, zIndex: 20 }}>
        {/* Devices is a screen under Health, so Health stays lit there */}
        {visibleMTabs(snap).map(t => { const on = ui.mTab === t || (t === 'Health' && ui.mTab === 'Devices'); return (
          <button key={t} role="tab" aria-selected={on} onClick={() => go(t)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 5, color: on ? 'var(--accent)' : 'var(--mut-3)', minHeight: 44, boxSizing: 'border-box' }}>
            <span style={{ width: 20, height: 3, borderRadius: 2, background: on ? 'var(--accent)' : 'transparent' }} />{t}
          </button>
        ); })}
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------- Overview

function MOverview() {
  const { snap, live, set } = useApp();
  const w = snap.weather, st = snap.status, tc = toneColor(st.tone);
  // Open with its field focused: render it now, inside the tap, so iOS raises the keyboard
  const openSearch = () => { flushSync(() => set({ mTab: 'Open', mScreen: 'home' })); scrollTo(0, 0); document.getElementById(OPEN_SEARCH)?.focus(); };
  const wanIn = last(live.history.wanIn), wanOut = last(live.history.wanOut);
  // review Phase 5: anything red, and the hero becomes the incident (amber and calm keep today's hero)
  const band = classicOverview() ? null : bandModel(snap, wanIn);
  return (
    <div style={{ ...PAGE, gap: 18 }}>
      {/* one live region whichever hero shows, so going red (or back) is announced */}
      <span role="status" style={SR}>{band ? band.item.title : st.ok ? st.label : st.short}</span>
      {band ? <MIncidentHero band={band} openSearch={openSearch} /> : <>
      <div style={row(12)}>
        <div style={{ flex: 1, minWidth: 0, ...flexCol(2) }}>
          <span style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-.02em' }}>{greeting()}</span>
          <span style={{ fontSize: 12, color: 'var(--mut-2)', ...ellipsis }}>{w ? `${w.tempC.toFixed(1)}°C, ${w.text} · ${w.place}` : whyMissing(snap, 'weather', 'weather')}</span>
          <LinkLine />
        </div>
        <button onClick={openSearch} aria-label="Search and launch" style={{ width: 44, height: 44, borderRadius: 12, border: '1px solid var(--rule)', display: 'grid', placeItems: 'center', color: 'var(--mut-1)', flex: 'none' }}><SearchIcon size={18} /></button>
      </div>
      <div style={{ padding: '18px 0', borderTop: `2px solid ${st.tone === 'ok' ? 'var(--accent)' : tc}`, ...flexCol(8) }}>
        <div style={row(8)}><Dot size={8} color={tc} pulse={st.tone === 'ok' ? 'ok2' : st.tone === 'danger' ? 'danger' : undefined} /><span style={eb(tc)}>{st.ok ? st.label : st.short}</span></div>
        <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.02em', lineHeight: 1.1, overflowWrap: 'anywhere' }}>{st.headline}</div>
        {snap.network.gateway && <div style={{ display: 'flex', gap: 16, fontFamily: 'var(--font-mono)', fontSize: 13, paddingTop: 4, whiteSpace: 'nowrap' }}>
          <span style={{ color: wanIn == null ? 'var(--mut-3)' : 'var(--accent)' }}>↓ {fmt(wanIn)} Mb/s</span><span style={{ color: wanOut == null ? 'var(--mut-3)' : 'var(--accent-2)' }}>↑ {fmt(wanOut)} Mb/s</span>
          <span style={{ color: 'var(--mut-3)', fontFamily: 'var(--font-ui)', fontSize: 11, alignSelf: 'center' }}>WAN</span>
        </div>}
      </div>
      </>}
      <MSpotlight />
      <div className="noscroll" style={{ display: 'flex', gap: 24, overflowX: 'auto', ...BLEED }}>
        {snap.kpis.map(k => (
          <div key={k.id} title={k.sub || undefined} style={ruled('10px 0 10px', 'var(--rule)', { flex: 'none', ...flexCol(2) })}>
            <span style={eyebrow()}>{k.label}</span>
            <span style={mono(18, kpiColor(k.tone))}>{k.value}</span>
          </div>
        ))}
      </div>
      <MAttention skip={band?.item.id} notes={!band} />
      <MNetwork />
      <MActivity />
      <MPlex />
    </div>
  );
}

function MSpotlight() {
  const { snap } = useApp();
  if (!modOn(snap, 'spotlight')) return null;
  const n = snap.spotlight;
  if (!n) return <div style={ruled('12px 0 12px', 'var(--rule)', flexCol(4))}><span style={eb()}>Spotlight</span><NotConnected what="Readiness probe" src="prom-infra" /></div>;
  const rule = n.status === 'down' ? 'var(--danger-rule)' : n.status === 'degraded' ? 'var(--warn-rule)' : 'var(--rule)';
  const probe = aged(n.probeAgeSec, snap), oldProbe = probe == null || probe > 180;
  const jobs = [n.backupJob && `backup ${ago(n.backupAt)}`, n.restoreJob && `restore test ${ago(n.restoreAt)}`].filter(Boolean).join(' · ');
  const inner = <>
    <Dot size={8} color={statusColor(n.status)} pulse={n.status === 'down' ? 'danger' : undefined} />
    <div style={{ flex: 1, minWidth: 0, ...flexCol(4) }}>
      <span style={row(8)}><span style={eb()}>{n.name}</span><span style={{ fontSize: 13, fontWeight: 700, color: statusText(n.status) }}>{STATUS_WORD[n.status]}</span></span>
      <span style={row(10, { fontSize: 12, color: 'var(--mut-2)', flexWrap: 'wrap', rowGap: 2 })}>
        {n.signals.map(x => <span key={x.name} style={row(5)}><StatusDot status={x.status} size={6} />{x.name}</span>)}
        {n.probed && <span style={mono(11, oldProbe ? 'var(--warn)' : 'var(--mut-3)')}>{probe == null ? 'no probe data' : `probe ${agoText(probe)} ago`}</span>}
      </span>
      {(jobs || !!n.autoRecoveries) && <span style={{ fontSize: 11.5, color: 'var(--mut-3)' }}>
        {jobs}
        {n.autoRecoveries ? <>{jobs ? ' · ' : ''}<span style={{ color: 'var(--warn)' }}>{n.autoRecoveries} auto-recover{n.autoRecoveries === 1 ? 'y' : 'ies'}</span></> : null}
      </span>}
    </div>
    {n.url && <span aria-hidden="true" style={{ color: 'var(--accent)', fontSize: 16 }}>↗</span>}
  </>;
  const st = ruled('12px 0 12px', rule, row(12, { minHeight: 52, color: 'var(--text)' }));
  return n.url ? <a href={n.url} {...EXT} aria-label={`Open ${n.name} · ${STATUS_WORD[n.status]}`} style={st}>{inner}</a> : <div style={st}>{inner}</div>;
}

function MAttnRow({ a }: { a: Attention }) {
  const c = sevColors(a.severity);
  const inner = <>
    <Dot size={7} color={c.c} style={{ marginTop: 6 }} />
    <div style={{ flex: 1, minWidth: 0, ...flexCol(2) }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, color: a.severity === 'info' ? 'var(--text-2)' : 'var(--text)' }}>{a.title}</span>
        {a.since != null && <span style={mono(11, 'var(--mut-3)', { flex: 'none' })}>{agoText(secSince(a.since))}</span>}
      </div>
      <span title={a.detail} style={{ fontSize: 12, color: c.sub, lineHeight: 1.4, overflowWrap: 'anywhere', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.detail}</span>
      {a.action && <span style={{ fontSize: 12, fontWeight: 600, color: c.c, paddingTop: 2 }}>{a.action.label} ↗</span>}
    </div>
  </>;
  // only a row with somewhere to go looks tappable
  const s: CSSProperties = { display: 'flex', gap: 12, padding: '12px 0', minHeight: 44, boxSizing: 'border-box', borderTop: RULE3, color: 'var(--text)' };
  return a.action ? <a href={a.action.href} {...EXT} style={s}>{inner}</a> : <div style={s}>{inner}</div>;
}

/** skip: the item the incident hero already shows; notes false: the hero has the notes row (review Phase 5). */
function MAttention({ skip, notes: withNotes = true }: { skip?: string; notes?: boolean }) {
  const { snap } = useApp();
  const [open, setOpen] = useState(false);
  const main = needsYou(snap.attention).filter(a => a.id !== skip), notes = withNotes ? snap.attention.filter(a => a.severity === 'info') : [];
  const ac = attnHeader(snap.attention.filter(a => a.id !== skip));
  if (skip && !main.length && !notes.length) return null;
  return (
    <div style={ruled('14px 0 0', ac.rule, flexCol())}>
      <span style={{ ...eb(ac.c), paddingBottom: 6 }}>Needs attention · {main.length}</span>
      {main.map(a => <MAttnRow key={a.id} a={a} />)}
      {!main.length && <span style={{ fontSize: 13, color: 'var(--mut-3)', padding: '14px 0', borderTop: RULE3 }}>Nothing needs you right now.</span>}
      {notes.length > 0 && <>
        <div style={{ borderTop: RULE3 }}><More open={open} onClick={() => setOpen(o => !o)}><span style={{ color: 'var(--info)' }}>{open ? 'Hide notes' : `+${plural(notes.length, 'note')}`}</span></More></div>
        {open && notes.map(a => <MAttnRow key={a.id} a={a} />)}
      </>}
    </div>
  );
}

const leafHue = (k: LeafView) => (k.kind === 'app' ? 25 : k.kind === 'role' ? 270 : GUEST_HUE[k.kind]);
/** The └ connector in front of a tree row. */
const Elbow = ({ h = 18 }: { h?: number }) => <span aria-hidden="true" style={{ width: 10, height: h, borderLeft: '1.5px solid var(--line)', borderBottom: '1.5px solid var(--line)', marginTop: -(h - 4), borderBottomLeftRadius: 4, flex: 'none' }} />;
const INDENT = [16, 30, 44] as const;
/** One fixed row of the tree (gateway, switch, AP): tile, name, sub-line, status dot from data. */
const NetRow = ({ depth, tile, name, sub, status, badge }: { depth: 0 | 1 | 2; tile: ReactNode; name: string; sub: ReactNode; status: Status; badge?: ReactNode }) => (
  <div style={row(12, { padding: `8px 16px 8px ${INDENT[depth]}px`, minHeight: 44, borderBottom: RULE3 })}>
    {depth > 0 && <Elbow />}
    {tile}
    <div style={{ flex: 1, minWidth: 0, ...flexCol() }}>
      <span style={{ fontSize: 14, fontWeight: 700, ...ellipsis }}>{name}</span>
      <span style={mono(11, 'var(--mut-3)', ellipsis)}>{sub}</span>
    </div>
    {badge}
    <StatusDot status={status} />
  </div>
);
function resLine(r: Res | null) {
  if (!r) return 'no resource data';
  const m = pctOf(r.memUsed, r.memTotal), d = pctOf(r.diskUsed, r.diskTotal);
  return [m != null && `RAM ${Math.round(m)}% of ${fmtBytes(r.memTotal)}`, d != null && `disk ${Math.round(d)}%`, r.uptimeSec != null && `up ${agoText(r.uptimeSec)}`].filter(Boolean).join(' · ') || 'no resource data';
}

function MNetwork() {
  const { snap, live, ui, set } = useApp();
  const n = snap.network, fw = n.gateway, sw = n.switch;
  const toggle = (id: string) => set(s => { const o = new Set(s.openHosts); if (o.has(id)) o.delete(id); else o.add(id); return { openHosts: o }; });
  const openGuest = (id: string) => { set({ mScreen: 'guest', mobileGuestId: id }); scrollTo(0, 0); };
  return (
    <div style={flexCol(10)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span style={eb()}>Network</span><span style={{ fontSize: 11, color: 'var(--mut-3)' }}>Tap a host to expand</span></div>
      <div style={ruled('6px 0 0', 'var(--rule)', { display: 'flex', flexDirection: 'column', overflow: 'hidden' })}>
        {fw && <NetRow depth={0} name={fw.name} status={fw.status}
          tile={<div style={tileS(0, { background: 'var(--text)', color: 'var(--on-accent)' })}>{snap.ui.gatewayMonogram ?? 'GW'}</div>}
          sub={<>{fw.ipShort} · {fw.devices ?? '—'} devices · <span style={{ color: fw.wan === 'up' ? undefined : statusColor(fw.wan) }}>WAN {STATUS_WORD[fw.wan].toLowerCase()}</span> · <span style={{ color: n.internet === 'up' ? undefined : statusColor(n.internet) }}>internet {STATUS_WORD[n.internet].toLowerCase()}</span></>} />}
        {n.segments.map(g => <NetRow key={g.id} depth={1} name={g.label} status={g.status} tile={<div style={tileS(25)}>{g.label.slice(0, 2).toUpperCase()}</div>} sub={`behind ${fw?.name ?? 'the gateway'}`} />)}
        {sw && <NetRow depth={fw ? 1 : 0} name={sw.name} status={sw.status} tile={<div style={tileS(230)}>SW</div>}
          sub={[sw.ipShort, plural(sw.aps, 'AP'), sw.mirror && `mirror ${sw.mirror}`].filter(Boolean).join(' · ')} badge={sw.eol ? <Badge kind="eol">EOL</Badge> : undefined} />}
        {sw && n.aps.map(a => <NetRow key={a.name} depth={2} name={a.name} status={a.status} tile={<div style={tileS(190)}>AP</div>} sub={`switch port ${a.port}`} />)}
        {snap.hosts.map(h => {
          const open = ui.openHosts.has(h.id), series = live.history.cpu[h.id] ?? [], cpu = last(series), hasCpu = series.some(v => v != null);
          return (
            <div key={h.id} style={{ display: 'flex', flexDirection: 'column', borderBottom: RULE3 }}>
              <button onClick={() => toggle(h.id)} aria-expanded={open} style={row(12, { padding: '8px 16px 8px 44px', minHeight: 52, background: open ? 'color-mix(in srgb, var(--accent) 5%, transparent)' : 'transparent', width: '100%', boxSizing: 'border-box' })}>
                <Elbow h={22} />
                <div style={tileS(h.hue)}>{h.mono}</div>
                <div style={{ flex: 1, minWidth: 0, ...flexCol() }}>
                  <span style={row(6, { fontSize: 14, fontWeight: 700, minWidth: 0 })}><span style={ellipsis}>{h.short}</span><StatusDot status={h.status} size={6} /></span>
                  <span style={mono(11, 'var(--mut-3)', ellipsis)}>{h.summary}</span>
                </div>
                {hasCpu ? <>
                  <svg width="44" height="20" viewBox="0 0 300 52" preserveAspectRatio="none" aria-hidden="true" style={{ flex: 'none' }}><path d={paths(series, 300, 52, scaleMax(series, h.cpuScale)).line} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>
                  <span style={mono(12, cpu == null ? 'var(--mut-3)' : undefined, { width: 34, textAlign: 'right', flex: 'none' })}>{cpu != null ? `${Math.round(cpu)}%` : '—'}</span>
                </> : <span style={{ fontSize: 11, color: 'var(--mut-3)', flex: 'none' }}>no CPU feed</span>}
                <span aria-hidden="true" style={{ color: 'var(--mut-3)', fontSize: 14, width: 12, flex: 'none', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .2s' }}>›</span>
              </button>
              {open && (
                <div style={{ display: 'flex', flexDirection: 'column', padding: '0 16px 8px 86px' }}>
                  <div style={row(10, { minHeight: 44, borderTop: RULE3 })}>
                    <div style={{ flex: 1, minWidth: 0, ...flexCol(1) }}>
                      <span style={mono(11, 'var(--mut-2)', ellipsis)}>{h.os}</span>
                      <span style={{ fontSize: 11, color: 'var(--mut-3)', ...ellipsis }}>{resLine(h.res)}</span>
                    </div>
                    {h.url && <TapLink href={h.url} label={`Open ${h.name}`}>Open ↗</TapLink>}
                  </div>
                  {h.updates && <div style={row(8, { minHeight: 36, borderTop: RULE3 })}><span style={eb()}>Updates</span><UpdatesLine u={h.updates} /></div>}
                  {h.leaves.map((k, i) => {
                    const inner = <>
                      <span style={{ minWidth: 26, height: 18, padding: '0 4px', boxSizing: 'border-box', borderRadius: k.kind === 'vm' ? 3 : 9, ...tint(leafHue(k)), display: 'grid', placeItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, flex: 'none' }}>{k.tag}</span>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-2)', textAlign: 'left', ...ellipsis }}>{k.name}</span>
                      {k.public && <span title="public" style={{ width: 7, height: 7, borderRadius: '50%', border: '1.5px solid var(--pub)', flex: 'none' }} />}
                      <span style={mono(11, 'var(--mut-3)', { flex: 'none' })}>{k.count || (k.kind === 'vm' ? 'VM' : '')}</span>
                      {k.kind !== 'role' && <StatusDot status={k.status} monitored={k.monitored !== false} size={6} />}
                      {(k.guestId || k.url) && <span aria-hidden="true" style={{ color: k.guestId ? 'var(--mut-3)' : 'var(--accent)', fontSize: k.guestId ? 16 : 12, width: 10, flex: 'none' }}>{k.guestId ? '›' : '↗'}</span>}
                    </>;
                    const s = row(10, { minHeight: 44, borderTop: RULE3, width: '100%', boxSizing: 'border-box', color: 'var(--text)' });
                    if (k.guestId) return <button key={`${k.key}-${i}`} onClick={() => openGuest(k.guestId!)} style={s}>{inner}</button>;
                    if (k.url) return <a key={`${k.key}-${i}`} href={k.url} {...EXT} aria-label={`Open ${k.name}`} style={s}>{inner}</a>;
                    return <div key={`${k.key}-${i}`} style={s}>{inner}</div>;
                  })}
                </div>
              )}
            </div>
          );
        })}
        {!snap.hosts.length && <span style={{ padding: '12px 16px' }}><NotConnected what="Proxmox" src="proxmox" /></span>}
      </div>
    </div>
  );
}

const LEVEL_C = { danger: 'var(--danger)', warn: 'var(--warn)', info: 'var(--info)', ok: 'var(--ok)' } as const;
function MActivity() {
  const { snap } = useApp();
  if (!modOn(snap, 'ntfy')) return null;
  const a = snap.activity, ntfy = uiUrl(snap, 'ntfy'), now = new Date();
  return (
    <Section title="Recent activity" sub="ntfy" right={ntfy ? <TapLink href={ntfy} label="Open ntfy">Open ↗</TapLink> : undefined}>
      {a == null ? <Empty>{whyMissing(snap, 'ntfy', 'ntfy')}</Empty>
        : !a.length ? <Empty>No notifications in the last 7 days</Empty>
          : a.slice(0, 5).map((m, i) => (
            <div key={`${m.at}-${i}`} style={row(10, { fontSize: 12, minHeight: 34, borderBottom: RULE3 })}>
              <span style={mono(11, 'var(--mut-3)', { width: 42, flex: 'none' })}>{whenText(m.at, now)}</span>
              <Dot size={6} color={LEVEL_C[m.level]} />
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-2)', ...ellipsis }}>{m.title || m.body}</span>
              <span style={mono(11, 'var(--mut-3)', { flex: 'none', maxWidth: 90, ...ellipsis })}>{m.topic}</span>
            </div>
          ))}
    </Section>
  );
}

function MPlex() {
  const { snap } = useApp();
  if (!modOn(snap, 'plex')) return null;
  const p = snap.plex, np = p.nowPlaying, href = uiUrl(snap, 'plex');
  const inner = <>
    <div style={{ width: 40, height: 56, borderRadius: 5, background: poster(np?.poster), flex: 'none' }} />
    <div style={{ flex: 1, minWidth: 0, ...flexCol(2) }}>
      <span style={eb('var(--warn)')}>Plex{href ? ' ↗' : ''}</span>
      <span style={{ fontSize: 14, fontWeight: 700, ...ellipsis }}>{np ? <>{np.state !== 'playing' && <span style={{ color: 'var(--warn)' }}>{np.state[0].toUpperCase() + np.state.slice(1)} · </span>}{np.title}</> : 'Nothing playing'}</span>
      <span style={{ fontSize: 12, color: 'var(--warn-sub)', ...ellipsis }}>
        {[p.streams == null ? whyMissing(snap, 'tautulli', 'Tautulli') : np ? `${np.user}${p.others > 0 ? ` · +${p.others} more` : ''}` : plural(p.streams, 'stream'), p.queued != null && `${fmt(p.queued)} in the download queue`].filter(Boolean).join(' · ')}
      </span>
    </div>
  </>;
  const s = ruled('14px 0 14px', 'var(--warn-rule)', row(12, { minHeight: 44, color: 'var(--text)' }));
  return href ? <a href={href} {...EXT} aria-label="Open Plex" style={s}>{inner}</a> : <div style={s}>{inner}</div>;
}

// ---------------------------------------------------------------- guest detail

function MResources({ res }: { res: Res | null }) {
  if (!res) return <Empty>No resource data from Proxmox</Empty>;
  // the same rows and colours as desktop (bars follow the attention rules); a metric the guest lacks is left out
  const rows = resRows(res, false, true);
  return (
    <div style={flexCol(12)}>
      {rows.map(([k, p, txt, color]) => (
        <div key={k} style={flexCol(6)}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={eb()}>{k}</span><span style={{ flex: 1 }} />
            <span style={mono(12, 'var(--text-2)')}>{k === 'CPU' ? (res.cpuPct == null ? '—' : `${Math.round(res.cpuPct)}%`) : txt}</span>
            {k !== 'CPU' && <span style={mono(12, 'var(--mut-3)', { width: 36, textAlign: 'right' })}>{p == null ? '—' : `${Math.floor(p)}%`}</span>}
          </div>
          <Bar pct={p} color={color} height={5} />
        </div>
      ))}
      <div style={row(16, { fontSize: 12, color: 'var(--mut-3)' })}>
        <span>Up <span style={mono(12, 'var(--text-2)')}>{agoText(res.uptimeSec)}</span></span>
        {res.load1 != null && <span>Load <span style={mono(12, 'var(--text-2)')}>{res.load1.toFixed(2)}</span></span>}
      </div>
    </div>
  );
}

function MGuest() {
  const { snap, ui, set, hostById } = useApp();
  const g = snap.guests.find(x => x.id === ui.mobileGuestId);
  const h = g ? hostById(g.host) : undefined;
  const back = (
    <div style={row(12, { justifyContent: 'space-between', minWidth: 0 })}>
      <button onClick={() => set({ mScreen: 'home' })} style={row(6, { minHeight: 44, color: 'var(--accent)', fontSize: 15, fontWeight: 600, flex: 'none' })}>
        <span style={{ fontSize: 22 }} aria-hidden="true">‹</span>{h?.short ?? g?.host ?? 'Overview'}
      </button>
      <LinkLine />
    </div>
  );
  if (!g) return <div style={{ ...PAGE, paddingTop: 6, gap: 12 }}>{back}<Empty>{snap.guests.length ? 'Proxmox no longer lists this guest.' : whyMissing(snap, 'proxmox', 'Proxmox')}</Empty></div>;
  const sibs = snap.guests.filter(x => x.host === g.host);
  const pve = pveUrl(h?.url, g);
  const pill = g.status === 'up' ? { background: 'var(--ok-bg)', color: 'var(--ok-fg)' } : { background: 'var(--rule-3)', color: g.status === 'unknown' ? 'var(--mut-3)' : statusColor(g.status) };
  return (
    <div style={{ ...PAGE, paddingTop: 6, gap: 18 }}>
      {back}
      <div className="noscroll" style={{ display: 'flex', gap: 6, overflowX: 'auto', ...BLEED }}>
        {sibs.map(s => { const on = s.id === g.id; return (
          <button key={s.id} aria-pressed={on} onClick={() => set({ mobileGuestId: s.id })} style={{ flex: 'none', padding: '0 14px', minHeight: 44, boxSizing: 'border-box', borderRadius: 99, fontSize: 12, fontWeight: 600, background: on ? 'var(--accent)' : 'color-mix(in srgb, var(--surface) 80%, transparent)', color: on ? 'var(--on-accent)' : 'var(--mut-1)', border: `1px solid ${on ? 'var(--accent)' : 'var(--pill-bd)'}` }}>{s.name}</button>
        ); })}
      </div>
      <div style={row(14)}>
        <div style={{ minWidth: 48, height: 48, padding: '0 6px', boxSizing: 'border-box', borderRadius: 13, ...tint(GUEST_HUE[g.kind]), display: 'grid', placeItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, flex: 'none' }}>{g.vmid}</div>
        <div style={{ flex: 1, minWidth: 0, ...flexCol(2) }}>
          <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.01em', ...ellipsis }}>{g.name}</span>
          <span style={mono(11, 'var(--mut-3)', ellipsis)}>{g.ip ? fullIp(g.ip) : 'no IP in inventory'} · {g.type}</span>
        </div>
        <span style={row(6, { padding: '5px 10px', borderRadius: 99, fontSize: 11, fontWeight: 700, flex: 'none', ...pill })}><Dot size={6} color={statusColor(g.status)} />{STATUS_WORD[g.status].toUpperCase()}</span>
      </div>
      {(g.undocumented || g.missing) && (
        <div style={flexCol(6, { fontSize: 12, color: 'var(--mut-3)' })}>
          {g.undocumented && <span style={row(8)}><Tag color="var(--warn)">undocumented</Tag>in Proxmox, not in homelab.json</span>}
          {g.missing && <span style={row(8)}><Tag color="var(--warn)">not in Proxmox</Tag>in homelab.json only</span>}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <div style={ruled('12px 0 12px', 'var(--rule)', flexCol(2))}><span style={mono(24, g.containers == null ? 'var(--mut-3)' : undefined)}>{g.containers ?? '—'}</span><span style={{ fontSize: 11, color: 'var(--mut-3)' }}>{g.containers != null ? 'Containers running' : g.kind === 'vm' ? 'VM · no container data' : 'No container data'}</span></div>
        <div style={ruled('12px 0 12px', 'var(--rule)', flexCol(2))}><span style={mono(24)}>{g.ui.length}</span><span style={{ fontSize: 11, color: 'var(--mut-3)' }}>Web UIs</span></div>
      </div>
      {g.updates && <div style={row(10, { minHeight: 44, borderTop: '1px solid var(--rule)' })}><span style={eb()}>Updates</span><UpdatesLine u={g.updates} size={13} /></div>}
      <Section title="Resources" sub={h ? `on ${h.name}` : undefined}><div style={{ paddingTop: 12 }}><MResources res={g.res} /></div></Section>
      {g.ui.length > 0 && (
        <Section title="Web UIs">
          {g.ui.map(u => { const url = u.url; return (
            <a key={u.name} href={url} {...EXT} aria-label={`Open ${u.name}`} style={row(10, { minHeight: 48, borderBottom: RULE3, color: 'var(--text)' })}>
              <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, ...ellipsis }}>{shortUrl(url)}</span>
              {u.public && <Badge kind="pub">PUBLIC</Badge>}
              <span style={mono(11, 'var(--mut-3)', { flex: 'none' })}>{u.port}</span>
              <span aria-hidden="true" style={{ color: 'var(--accent)', fontSize: 16 }}>↗</span>
            </a>
          ); })}
        </Section>
      )}
      {g.services.length > 0 && (
        <div style={flexCol(8)}>
          <span style={eb()}>Services <span style={{ color: 'var(--mut-3)', letterSpacing: '.06em' }}>· from inventory</span></span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{g.services.map(s => <Chip key={s} size={12} pad="6px 10px">{s}</Chip>)}</div>
        </div>
      )}
      {g.devices.length > 0 && (
        <div style={flexCol(8)}>
          <span style={eb()}>Connected devices</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{g.devices.map(s => <Chip key={s} size={12} pad="6px 10px">{s}</Chip>)}</div>
        </div>
      )}
      <div style={flexCol(8)}>
        {pve
          ? <a href={pve} {...EXT} aria-label={`Console: open ${g.name} in Proxmox`} style={{ display: 'grid', placeItems: 'center', minHeight: 48, borderRadius: 14, background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 14, fontWeight: 700 }}>Console ↗</a>
          : <Empty>No Proxmox address for {g.host}</Empty>}
        {/* no Restart: the dashboard is read-only (power actions stay in Proxmox) */}
        <span style={{ fontSize: 12, color: 'var(--mut-3)', textAlign: 'center' }}>Start, stop and restart in Proxmox</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Open

/** A service in Open's grid (and the incident hero's): a 60px tile with its status dot. label: the hero's display name. */
function MTile({ u, label = u.name }: { u: LaunchItem; label?: string }) {
  return (
    <a href={u.url} {...EXT} aria-label={`Open ${label}${u.app ? ' (app)' : ''} · ${u.monitored ? STATUS_WORD[u.status].toLowerCase() : 'no monitor'}`}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 0, color: 'inherit' }}>
      <div style={{ position: 'relative', width: 60, height: 60, borderRadius: u.app ? 30 : 17, ...tint(hueOf(u.name)), display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 17, boxShadow: u.public ? '0 0 0 2px var(--pub)' : 'none' }}>
        {monoOf(u.name)}
        <span style={{ position: 'absolute', right: -1, bottom: -1, width: 12, height: 12, borderRadius: '50%', background: u.monitored ? statusColor(u.status) : 'var(--bg)', border: '2.5px solid var(--bg)', boxShadow: u.monitored ? 'none' : 'inset 0 0 0 1.5px var(--mut-5)' }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', maxWidth: '100%', ...ellipsis }}>{label}</span>
    </a>
  );
}

const OPEN_SEARCH = 'open-search';
/** A 17/700 heading inside Open (Services, Bookmarks), with an optional count and a control at the right. */
const OpenHead = ({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) => (
  <div style={row(10, { minHeight: 44, minWidth: 0 })}>
    <span style={{ fontSize: 17, fontWeight: 700, flex: 'none' }}>{title}</span>
    {sub && <span style={{ fontSize: 12, color: 'var(--mut-3)', minWidth: 0, ...ellipsis }}>{sub}</span>}
    {right && <><span style={{ flex: 1 }} />{right}</>}
  </div>
);

/** Open (review finding 9): the Launch grid (services), then the Links groups (bookmarks), under one search.
 *  The links editor works as on the Links tab: while editing it takes the screen. */
function MOpen() {
  const { snap, ui, set } = useApp();
  const ed = useLinksEditor();
  const q = ui.launcherQuery.trim().toLowerCase();
  const all = openItems(snap), list = all.filter(u => !q || matches(u.hay, q)), nApps = all.filter(a => a.app).length;
  const bm = useLinkFilter(ed.shown, ui.launcherQuery), nLinks = bm.groups.reduce((n, g) => n + g.items.length, 0);
  if (ed.draft) return <div style={{ ...PAGE, gap: 16 }}><H1>Bookmarks</H1><LinksEditorView ed={ed} phone /></div>;
  return (
    <div style={{ ...PAGE, gap: 16 }}>
      <H1>Open</H1>
      <SearchField id={OPEN_SEARCH} value={ui.launcherQuery} onChange={v => set({ launcherQuery: v })} placeholder="Search services and bookmarks" />
      {list.length > 0 && <>
        <OpenHead title="Services" sub={q ? `${list.length} of ${all.length}` : `${all.length - nApps} UIs · ${nApps} apps`} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: '14px 8px' }}>
          {list.map(u => <MTile key={u.key} u={u} label={u.label} />)}
        </div>
        <div style={row(14, { fontSize: 11, color: 'var(--mut-3)', flexWrap: 'wrap', rowGap: 6 })}>
          <span style={row(6)}><span style={{ width: 12, height: 12, borderRadius: 4, boxShadow: '0 0 0 2px var(--pub)' }} />public</span>
          <span style={row(6)}><span style={{ width: 12, height: 12, borderRadius: 6, ...tint(25) }} />app</span>
          <span style={row(6)}><StatusDot status="unknown" monitored={false} size={9} />no monitor</span>
        </div>
      </>}
      {(nLinks > 0 || !q) && <div style={flexCol(16, { paddingTop: list.length ? 10 : 0 })}>
        {/* as on desktop: the editor lists every link, so say how many Open already shows */}
        <OpenHead title="Bookmarks" sub={!bm.q && bm.hidden ? `${bm.label} · ${bm.hidden} more in Open` : bm.label} right={<EditButton ed={ed} phone />} />
        <LinksNote ed={ed} />
        {bm.groups.map(g => (
          <Section key={g.group} title={g.group}>
            {g.items.map((l, i) => (
              <a key={`${l.name}-${i}`} href={l.url} {...EXT} style={row(12, { minHeight: 52, borderBottom: RULE3, color: 'var(--text)' })}>
                <span style={tileS(hueOf(l.name, 41))}>{bm.mono(l.name)}</span>
                <div style={{ flex: 1, minWidth: 0, ...flexCol() }}><span style={{ fontSize: 14, fontWeight: 600, ...ellipsis }}>{l.name}</span><span style={mono(11, 'var(--mut-3)', ellipsis)}>{l.domain}</span></div>
                <span aria-hidden="true" style={{ color: 'var(--accent)', fontSize: 15 }}>↗</span>
              </a>
            ))}
          </Section>
        ))}
      </div>}
      {!list.length && !nLinks && <Empty>Nothing matches “{ui.launcherQuery}”</Empty>}
      <button onClick={() => set({ cmdOpen: true })} style={row(10, { minHeight: 48, borderTop: '1px solid var(--rule)', color: 'var(--text-2)', fontSize: 14, fontWeight: 600 })}>
        <SearchIcon size={16} stroke="var(--accent)" /><span style={{ flex: 1, textAlign: 'left' }}>Search everything</span><span style={{ fontSize: 11, color: 'var(--mut-3)', fontWeight: 500 }}>hosts, guests, jobs, devices</span>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- Media

function MMedia() {
  const { snap, live } = useApp();
  const m = snap.media, p = snap.plex, np = p.nowPlaying, dl = live.history.qbDl, ul = live.history.qbUl;
  const qbNow = last(dl), nzNow = last(live.history.nzDl), dlBoth = qbNow == null && nzNow == null ? null : (qbNow ?? 0) + (nzNow ?? 0);
  const qmax = scaleMax([...dl, ...ul], 10), d2 = paths(dl, 600, 120, qmax), u2 = paths(ul, 600, 120, qmax);
  const url = (ui: string, path = '') => uiUrl(snap, ui, path);
  const queued = m.sonarr?.queued == null && m.radarr?.queued == null ? null : (m.sonarr?.queued ?? 0) + (m.radarr?.queued ?? 0);
  const why = (src: string) => srcWord(snap, src);
  // only the stages, tiles and blocks of the apps this lab has
  const has = (...ids: Parameters<typeof modOn>[1][]) => modOn(snap, ...ids);
  const both = (a: string, b: string, x: boolean, y: boolean) => [x && a, y && b].filter(Boolean).join(' · ');
  const steps = ([
    has('seerr') && ['Seerr', 'request', m.seerr ? `${fmt(m.seerr.approved)} ok · ${fmt(m.seerr.pending)} pending` : why('seerr'), url('seerr', '/requests')],
    has('sonarr', 'radarr') && [both('Sonarr', 'Radarr', has('sonarr'), has('radarr')), 'manage', queued == null ? why('prom-media') : `${fmt(queued)} queued`, url(has('sonarr') ? 'sonarr' : 'radarr', '/activity/queue')],
    has('prowlarr') && ['Prowlarr', 'search', m.prowlarr ? `${m.prowlarr.indexers.length} idx` : why('prowlarr'), url('prowlarr')],
    has('qbittorrent', 'nzbget') && [both('qBit', 'NZBGet', has('qbittorrent'), has('nzbget')), 'download', dlBoth == null ? '—' : `↓${fmt1(dlBoth)}`, url(has('qbittorrent') ? 'qbittorrent' : 'nzbget'), 'var(--accent)'],
    has('plex') && ['Plex', 'watch', p.streams == null ? why('tautulli') : plural(p.streams, 'stream'), url('plex')],
  ] as const).filter((x): x is Exclude<typeof x, false> => !!x) as [string, string, string, string | null, string?][];
  const tiles = ([[p.movies, 'Movies', has('plex')], [p.shows, 'Shows', has('plex')], [m.immich?.photos, 'Photos · Immich', has('immich')], [m.seerr?.pending, 'Pending requests', has('seerr')]] as const).filter(t => t[2]);
  const plexHref = url('plex');
  const bazarr = url('bazarr', '/wanted/series'), bz = changeLook(m.delta7?.bazarr, m.bazarr?.episodes);
  return (
    <div style={{ ...PAGE, gap: 16 }}>
      <H1>Media</H1>
      {has('plex') && <a href={plexHref ?? undefined} {...(plexHref ? EXT : {})} aria-label="Plex now playing" style={ruled('16px 0 16px', 'var(--warn-rule)', row(14, { color: 'var(--text)' }))}>
        <div style={{ width: 56, height: 82, borderRadius: 6, background: poster(np?.poster), flex: 'none' }} />
        <div style={{ flex: 1, minWidth: 0, ...flexCol(3) }}>
          <span style={eb('var(--warn)')}>Plex · {np && np.state !== 'playing' ? np.state : 'now playing'}{plexHref ? ' ↗' : ''}</span>
          <span style={{ fontSize: 16, fontWeight: 700, overflowWrap: 'anywhere', color: !np && p.streams == null ? 'var(--mut-3)' : undefined }}>{np?.title ?? (p.streams == null ? "Can't see what's playing" : 'Nothing playing')}</span>
          {np && <span style={{ fontSize: 12, color: 'var(--warn-sub)', ...ellipsis }}>{np.sub} · {np.user}</span>}
          {np && <div style={{ height: 3, borderRadius: 2, background: 'var(--rule-3)', overflow: 'hidden', marginTop: 4 }}><div style={{ width: `${np.progress}%`, height: '100%', background: 'var(--warn)' }} /></div>}
          <span style={{ fontSize: 12, color: 'var(--warn-sub)' }}>{p.streams == null ? whyMissing(snap, 'tautulli', 'Tautulli') : `${plural(p.streams, 'active stream')}${p.others > 0 ? ` · +${p.others} more` : ''}`}</span>
        </div>
      </a>}
      {tiles.length > 0 && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 8 }}>
        {tiles.map(([v, k]) => (
          <div key={k} style={ruled('12px 0 12px', 'var(--rule)', flexCol())}><span style={mono(22, v == null ? 'var(--mut-3)' : undefined)}>{fmt(v)}</span><span style={{ fontSize: 11, color: 'var(--mut-3)' }}>{k}</span></div>
        ))}
      </div>}
      {steps.length >= 2 && <Section title="Pipeline">
        {steps.map(([nm, role, v, href, c], i) => {
          const inner = <>
            <span style={mono(11, 'var(--mut-3)', { width: 18, flex: 'none' })}>0{i + 1}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, ...ellipsis }}>{nm}<span style={{ color: 'var(--mut-3)', fontWeight: 500 }}> · {role}</span></span>
            <span style={mono(12, NO_DATA.test(v) ? 'var(--mut-3)' : c ?? 'var(--mut-1)', { flex: 'none' })}>{v}</span>
            {href && <span aria-hidden="true" style={{ color: 'var(--accent)', fontSize: 12 }}>↗</span>}
          </>;
          const s = row(12, { minHeight: 52, borderBottom: i === steps.length - 1 ? 0 : RULE3, color: 'var(--text)' });
          return href ? <a key={nm} href={href} {...EXT} aria-label={`Open ${nm}`} style={s}>{inner}</a> : <div key={nm} style={s}>{inner}</div>;
        })}
      </Section>}
      {has('qbittorrent') && <div style={ruled('16px 0 16px', 'var(--rule)', flexCol(10))}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}><span style={eb()}>qBittorrent</span><span style={mono(13, undefined, { whiteSpace: 'nowrap' })}><span style={{ color: 'var(--accent)' }}>↓ {fmt1(last(dl))}</span> <span style={{ color: 'var(--accent-2)' }}>↑ {fmt1(last(ul))}</span> MB/s</span></div>
        <svg width="100%" height="60" viewBox="0 0 600 120" preserveAspectRatio="none" aria-hidden="true"><path d={d2.area} fill="var(--accent-a14)" /><path d={d2.line} fill="none" stroke="var(--accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" /><path d={u2.line} fill="none" stroke="var(--accent-2)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>
        <span style={{ fontSize: 12, color: 'var(--mut-3)' }}>{fmt(m.qbit?.leeching)} leeching · {fmt(m.qbit?.seeding)} seeding · <span style={{ color: connColor(m.qbit?.conn) }}>{connText(m.qbit?.conn)}</span>{m.nzbget ? ` · NZBGet ${fmt1(m.nzbget.todayGB)} GB today` : ''}</span>
      </div>}
      {m.bazarr && (
        <a href={bazarr ?? undefined} {...(bazarr ? EXT : {})} style={ruled('14px 0 14px', 'var(--warn-rule)', row(12, { minHeight: 44, color: 'var(--text)' }))}>
          <div style={{ flex: 1, minWidth: 0, ...flexCol() }}><span style={{ fontSize: 14, fontWeight: 600 }}>{fmt(m.bazarr.episodes)} episode{m.bazarr.episodes === 1 ? '' : 's'}{m.bazarr.movies ? ` and ${fmt(m.bazarr.movies)} movie${m.bazarr.movies === 1 ? '' : 's'}` : ''} missing subtitles</span>
            {/* the episodes' 7-day change (review finding 17), once there are 7 days of samples */}
            <span style={{ fontSize: 12, color: 'var(--warn-sub)' }}>Bazarr{bz.text !== '—' && <> · <span title={bz.title} style={mono(12, bz.color)}>{bz.text}</span></>}</span></div>
          {bazarr && <span aria-hidden="true" style={{ color: 'var(--warn-sub)', fontSize: 14 }}>↗</span>}
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Health

const CONN: Record<Conn, [string, string]> = {
  ok: ['ok', 'var(--ok)'], stale: ['stale', 'var(--warn)'], error: ['error', 'var(--danger)'], 'not-connected': ['not connected', 'var(--mut-3)'], mock: ['mock', 'var(--accent-2)'],
};
const certSoon = (m: Monitor) => m.certDays != null && m.certDays <= 14;

function MMonitorRow({ m }: { m: Monitor }) {
  const watched = m.kumaId != null;
  return (
    <div style={row(10, { minHeight: 40, borderBottom: RULE3, opacity: watched ? 1 : 0.6 })}>
      <StatusDot status={m.status} monitored={watched} size={6} />
      <span style={{ width: 96, flex: 'none', fontSize: 13, fontWeight: 600, ...ellipsis }}>{m.label || m.name}</span>
      {watched
        ? <div style={{ flex: 1, minWidth: 0, display: 'flex', gap: 1, height: 12 }}>{m.cells.map((c, j) => <span key={j} style={{ flex: 1, borderRadius: 1, background: cellColor(c) }} />)}</div>
        : <span style={{ flex: 1, fontSize: 11, color: 'var(--mut-3)' }}>no monitor</span>}
      {certSoon(m) && <span style={mono(11, 'var(--warn)', { flex: 'none' })}>cert {m.certDays} d</span>}
      <span style={mono(11, msColor(m.status), { width: 46, flex: 'none', textAlign: 'right' })}>{!watched || m.ms == null ? '—' : `${m.ms} ms`}</span>
    </div>
  );
}

/** label: the name shown (a family member's short label); indent: a row under a group line; anchor false: no #job- id
 *  (a fallback row); detailColor / dotColor override the job's tier (Automation's merged rows); lead: the detail is the
 *  merged signal (NFS counts, paused pipelines), so it goes before 'where' even when the job is up. */
function MJobRow({ j, label, indent, anchor = true, detailColor, dotColor, lead }: { j: JobView; label?: string; indent?: boolean; anchor?: boolean; detailColor?: string; dotColor?: string; lead?: boolean }) {
  const bad = j.status !== 'up', first = bad || lead;
  const inner = <>
    <StatusDot status={j.status} color={dotColor ?? jobColor(j)} />
    <div style={{ flex: 1, minWidth: 0, ...flexCol(2) }}>
      <span style={{ fontSize: 14, fontWeight: 600, ...ellipsis }}>{label ?? j.name}{j.link && <span aria-hidden="true" style={{ color: 'var(--accent)', fontSize: 11 }}> ↗</span>}</span>
      <span style={{ fontSize: 12, color: detailColor ?? jobText(j), ...ellipsis }}>{[first ? j.detail : '', j.where, first ? '' : j.detail].filter(Boolean).join(' · ')}</span>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flex: 'none' }}>
      <span style={mono(12, 'var(--mut-1)')}>{jobAgo(j)}</span>
      {j.days ? <Strip days={j.days} /> : <span style={{ fontSize: 11, color: 'var(--mut-3)' }}>{j.signal === 'none' || !anchor ? '' : 'no history'}</span>}
    </div>
  </>;
  const id = anchor ? `job-${j.id}` : undefined;
  const s = row(10, { minHeight: 52, padding: `6px 0 6px ${indent ? 17 : 0}px`, boxSizing: 'border-box', borderBottom: RULE3, color: 'var(--text)', scrollMarginTop: 16 });
  return j.link ? <a id={id} href={j.link} {...EXT} aria-label={`Open ${j.name}`} style={s}>{inner}</a> : <div id={id} style={s}>{inner}</div>;
}

/** A job family on one line (dot · name with its member pills · age over the merged strip). Members that aren't up
 *  show as rows under it; a tap shows every member. compact: 'n/m on time' instead of the strip (collectors). */
function MGroupRow({ g, compact }: { g: JobGroup; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const kids = shownMembers(g, open), ok = g.members.filter(m => m.status === 'up').length;
  return <>
    <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} data-group={g.family}
      style={row(10, { width: '100%', minHeight: 52, padding: '8px 0', boxSizing: 'border-box', borderBottom: RULE3, scrollMarginTop: 16, textAlign: 'left' })}>
      {/* on the name line (19px), not centred on the name plus its wrapped pills */}
      <StatusDot status={g.status} color={groupColor(g)} style={{ alignSelf: 'flex-start', marginTop: 6 }} />
      <div style={{ flex: 1, minWidth: 0, ...flexCol(5) }}>
        <span style={row(6, { fontSize: 14, fontWeight: 600, minWidth: 0 })}><span style={ellipsis}>{g.family}</span><span aria-hidden="true" style={mono(11, 'var(--mut-3)', { flex: 'none' })}>{open ? '▴' : '▾'}</span></span>
        {!open && <span style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{g.members.map(m => <JobPill key={m.id} j={m} anchor={!kids.includes(m)} />)}</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flex: 'none', alignSelf: 'flex-start', paddingTop: 1 }}>
        <span style={mono(12, 'var(--mut-1)')}>{jobAgo(g.ageMember)}</span>
        {compact ? <span style={{ fontSize: 11, color: 'var(--mut-3)' }}>{ok}/{g.members.length} on time</span>
          : g.days ? <Strip days={g.days} /> : <span style={{ fontSize: 11, color: 'var(--mut-3)' }}>no history</span>}
      </div>
    </button>
    {kids.map(m => <MJobRow key={m.id} j={m} label={shortLabel(m)} indent />)}
  </>;
}

/** Problems always shown, the healthy rest behind 'Show all'. A phone shouldn't scroll past 20 green rows.
 *  openFooter: shown under the items once they are all shown. */
function Folded<T>({ items, bad, render, all, none, openFooter }: { items: T[]; bad: (x: T) => boolean; render: (x: T, i: number) => ReactNode; all: string; none: ReactNode; openFooter?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.filter(bad), hidden = items.length - items.filter(bad).length;
  return <>
    {shown.map(render)}
    {!shown.length && !open && none}
    {(open || hidden === 0) && openFooter}
    {hidden > 0 && <More open={open} onClick={() => setOpen(o => !o)}>{open ? 'Show problems only' : `Show all ${items.length} ${all}`}</More>}
  </>;
}

/** Sources, problems first; one clock for every row's heartbeat (review 3c) */
function MSources({ sources, bad }: { sources: SourceView[]; bad: (s: SourceView) => boolean }) {
  const t = useBeatClock();
  return <Folded items={sourcesFirst(sources)} all="sources" bad={bad} render={s => <MSourceRow key={s.name} s={s} t={t} />} none={<Empty>Every source is answering.</Empty>} />;
}
/** name, pill and age; under them the heartbeat across the row (2 minutes), then the note */
function MSourceRow({ s, t }: { s: SourceView; t: number }) {
  const [label, c] = CONN[s.conn], note = s.error ?? (s.conn === 'not-connected' && s.needs ? `needs ${s.needs}` : '');
  return (
    <div style={flexCol(3, { padding: '10px 0', borderBottom: RULE3 })}>
      <div style={row(10)}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, ...ellipsis }}>{s.label}</span>
        <span style={{ padding: '1px 7px', borderRadius: 99, border: `1px solid ${c}`, color: c, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap', flex: 'none' }}>{label}</span>
        {/* compact ('57m'), so a long age never wraps */}
        <span title={s.lastOk == null ? undefined : ago(s.lastOk)} style={mono(11.5, 'var(--mut-2)', { width: 64, flex: 'none', textAlign: 'right', whiteSpace: 'nowrap' })}>{s.lastOk == null ? '—' : agoShort(secSince(s.lastOk))}</span>
      </div>
      <Heartbeat s={s} t={t} fill />
      {note && <span style={{ fontSize: 12, color: s.error ? 'var(--danger-sub)' : 'var(--mut-3)', lineHeight: 1.4, overflowWrap: 'anywhere' }}>{note}</span>}
    </div>
  );
}

function MVolume({ v, compact }: { v: Volume; compact?: boolean }) {
  const c = v.tone === 'ok' ? null : toneColor(v.tone);
  if (v.missing) return (
    <div style={flexCol(3, { padding: '10px 0', borderBottom: RULE3 })}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}><span style={{ flex: 1, minWidth: 0, fontWeight: 600, ...ellipsis }}>{v.name}</span><span style={mono(12, 'var(--mut-3)', { flex: 'none' })}>— / {v.cap}</span></div>
      <span style={{ fontSize: 11.5, color: c ?? 'var(--mut-3)', lineHeight: 1.4 }}>{v.missing}</span>
    </div>
  );
  return (
    <div style={flexCol(compact ? 6 : 7, { padding: compact ? '10px 0' : '12px 0', borderBottom: RULE3 })}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 13 }}>
        <span style={{ flex: 1, minWidth: 0, fontWeight: 600, ...ellipsis }}>{v.name}{compact && v.sub && <span style={{ fontWeight: 500, fontSize: 11.5, color: 'var(--mut-3)' }}> · {v.sub}</span>}</span>
        <span style={mono(12, 'var(--text-2)', { flex: 'none' })}>{v.used} / {v.cap}</span>
        <span style={mono(12, c ?? 'var(--mut-3)', { width: 36, textAlign: 'right', flex: 'none' })}>{v.pct}%</span>
      </div>
      <Bar pct={v.pct} color={c ?? 'var(--accent)'} height={5} />
      {!compact && v.sub && <span style={{ fontSize: 11.5, color: c ?? 'var(--mut-3)' }}>{v.sub}</span>}
    </div>
  );
}

/** Health's index on the phone (review finding 13): a sideways-scrolling row of 44px chips under the title, the
 *  section's tier as the chip's border; a tap jumps to the section. */
function MIndex() {
  const { snap, set } = useApp();
  return (
    <nav aria-label="Health sections" className="noscroll" style={{ ...BLEED, display: 'flex', gap: 8, overflowX: 'auto', marginTop: -8 }}>
      {sectionIndex(snap).map(e => { const bad = e.tone !== 'ok'; return (
        // Devices is its own screen on the phone (review finding 9)
        <button key={e.id} onClick={() => { if (e.id === 'devices') { set({ mTab: 'Devices', mScreen: 'home' }); scrollTo(0, 0); } else scrollToId(e.anchor); }} aria-label={`${e.name}: ${e.state}. ${e.id === 'devices' ? 'Open Devices' : 'Go to the section'}`}
          style={row(6, { flex: 'none', maxWidth: 280, height: 44, boxSizing: 'border-box', padding: '0 14px', borderRadius: 99, border: `1px solid ${bad ? toneColor(e.tone) : 'var(--pill-bd)'}`, fontSize: 13, whiteSpace: 'nowrap' })}>
          <span style={{ fontWeight: 700, flex: 'none' }}>{e.name}</span>
          <span style={{ fontSize: 12, color: bad ? toneColor(e.tone) : 'var(--mut-3)', fontWeight: bad ? 600 : undefined, minWidth: 0, ...ellipsis }}>{e.state}</span>
        </button>
      ); })}
    </nav>
  );
}

function MHealth() {
  const { snap, set } = useApp();
  const h = snap.health;
  const [notMon, setNotMon] = useState(false);
  const fold = useAlertFold(snap.alerts);
  const mons = problemsFirst([...h.monitors, ...h.unmapped].filter(m => m.kumaId != null), m => STATUS_RANK[m.status]);
  const noMon = h.monitors.filter(m => m.kumaId == null);
  const upN = mons.filter(m => m.status === 'up').length;
  const backups = h.jobs.filter(j => j.group === 'backup'), bkUnits = groupJobs(backups);
  const auto = automationRows(h), autoSt = unitRows(auto);
  const okN = (js: JobView[]) => js.filter(j => j.status === 'up').length;
  const srcBad = (s: SourceView) => s.conn !== 'ok' && s.conn !== 'mock';
  const grafana = uiUrl(snap, 'grafana');
  const probed = h.exposure.filter(x => x.via !== 'port-forward');
  const st = storageParts(h);
  const lanN = snap.kpis.find(k => k.id === 'lan')?.value ?? '—';
  return (
    <div style={{ ...PAGE, gap: 26 }}>
      <H1>Health</H1>
      <MIndex />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: '18px 20px' }}>
        {h.stats.map(k => (
          <div key={k.id} style={ruled('10px 0 0', 'var(--rule)', flexCol(3))}>
            <span style={eyebrow()}>{k.label}</span>
            <span style={mono(22, toneColor(k.tone))}>{k.value}</span>
            <span style={{ fontSize: 11, color: 'var(--mut-3)', lineHeight: 1.35 }}>{k.sub || '\u00a0'}</span>
          </div>
        ))}
      </div>
      {/* Devices lives here on the phone (review finding 9): one row that opens its screen */}
      <button onClick={() => { set({ mTab: 'Devices', mScreen: 'home' }); scrollTo(0, 0); }} aria-label={`LAN devices · ${lanN}: open Devices`}
        style={row(10, { minHeight: 52, width: '100%', boxSizing: 'border-box', borderTop: '1px solid var(--rule)', borderBottom: RULE3, color: 'var(--text)', textAlign: 'left' })}>
        <span style={{ fontSize: 14, fontWeight: 600, flex: 'none' }}>LAN devices · <span style={mono(14)}>{lanN}</span></span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--mut-3)', textAlign: 'right', ...ellipsis }}>{snap.devices.counts ? snap.devices.counts.segments.map(x => `${x.online} on ${x.name}`).join(' · ') : whyMissing(snap, 'devices', 'device list')}</span>
        <span aria-hidden="true" style={{ color: 'var(--accent)', fontSize: 20, flex: 'none' }}>›</span>
      </button>

      {sectionOn(snap, 'alerts') && <>
      <Section id="health-alerts" title="Grafana alerts" sub={snap.alerts ? `${snap.alerts.length} firing` : undefined} right={grafana ? <TapLink href={`${grafana}/alerting/list`} label="Open Grafana alerting">Grafana ↗</TapLink> : undefined}>
        {snap.alerts == null ? <Empty>{whyMissing(snap, 'grafana', 'Grafana')}</Empty>
          : !snap.alerts.length ? <Empty>Nothing firing</Empty>
            : <>
              {/* one line each: the rule's page in Grafana has the full text */}
              {fold.shown.map((a, i) => { const c = sevColors(a.severity); return (
                <a key={`${a.name}-${i}`} href={a.url} {...EXT} aria-label={`${a.name}: open the rule in Grafana`} style={{ display: 'flex', gap: 10, padding: '11px 0', minHeight: 44, boxSizing: 'border-box', borderBottom: RULE3, color: 'var(--text)' }}>
                  <Dot size={7} color={c.c} style={{ marginTop: 6 }} />
                  <div style={{ flex: 1, minWidth: 0, ...flexCol(2) }}>
                    <span style={{ fontSize: 14, fontWeight: 600, ...ellipsis }}>{a.name}</span>
                    <span style={{ fontSize: 12, color: c.sub, ...ellipsis }}>{a.summary || a.severity}</span>
                  </div>
                  <span style={mono(11, 'var(--mut-3)', { flex: 'none', paddingTop: 2 })}>{a.since == null ? '' : agoText(secSince(a.since))}</span>
                </a>
              ); })}
              {fold.info > 0 && <More open={fold.open} onClick={fold.toggle}><span style={{ color: 'var(--info)' }}>{fold.open ? 'Hide info alerts' : `+${plural(fold.info, 'info alert')}`}</span></More>}
            </>}
      </Section>
      </>}

      {sectionOn(snap, 'uptime') && <>
      <Section id="health-uptime" title="Service uptime" sub={mons.length ? `${upN} of ${mons.length} up · ${noMon.length} no monitor · ${uptimeWindow(snap)}` : undefined}>
        {mons.length
          ? <Folded items={mons} all="services" bad={m => m.status !== 'up' || certSoon(m)} render={m => <MMonitorRow key={m.name} m={m} />}
            none={<Empty>Every watched service is up.</Empty>} openFooter={<NoMonitorLine snap={snap} mons={noMon} style={{ padding: '12px 0 4px' }} />} />
          : <><Empty>{whyMissing(snap, 'kuma', 'Uptime Kuma')}</Empty><NoMonitorLine snap={snap} mons={noMon} style={{ padding: '0 0 4px' }} /></>}
      </Section>
      </>}

      <Section id="health-backups" title="Backups" sub={backups.length ? `${okN(backups)} of ${backups.length} ok · last 14 days` : undefined}>
        {backups.length
          ? <Folded items={bkUnits} all={bkUnits.some(g => g.members.length > 1) ? 'backup groups' : 'backups'} bad={g => g.status !== 'up'}
            render={g => (g.members.length > 1 ? <MGroupRow key={`f-${g.family}`} g={g} /> : <MJobRow key={g.members[0].id} j={g.members[0]} />)} none={<Empty>Every backup is current.</Empty>} />
          : <Empty>{whyMissing(snap, 'prom-jobs', 'Backup checks')}</Empty>}
      </Section>

      <Section id="health-automation" title="Automation" sub={autoSt.length ? `${autoSt.filter(s => s === 'up').length} of ${autoSt.length} ok` : undefined}>
        {auto.length
          ? <Folded items={auto} all="checks" bad={u => u.status !== 'up'} none={<Empty>Every collector, monitor and report is on time.</Empty>}
            render={u => (u.kind === 'group' ? <MGroupRow key={`f-${u.group.family}`} g={u.group} compact />
              : <MJobRow key={u.row.job.id} j={u.row.job} anchor={u.row.anchor} lead={u.row.lead}
                detailColor={u.row.detailColor === 'warn' ? 'var(--warn)' : u.row.detailColor ? statusColor(u.row.detailColor) : undefined}
                dotColor={u.row.plain ? statusColor(u.row.job.status) : undefined} />)} />
          : <Empty>{whyMissing(snap, 'prom-jobs', 'Automation checks')}</Empty>}
        {h.unmonitored.length > 0 && <>
          <div id="health-unmonitored" style={{ borderTop: RULE3, scrollMarginTop: 16 }}><More open={notMon} onClick={() => setNotMon(o => !o)}><span style={{ color: 'var(--mut-2)' }}>Not monitored · {h.unmonitored.length}</span></More></div>
          {notMon && h.unmonitored.map((u, i) => (
            <div key={`${u.name}-${i}`} style={row(10, { minHeight: 44, padding: '6px 0', boxSizing: 'border-box', borderTop: RULE3 })}>
              <StatusDot status="unknown" monitored={false} />
              <div style={{ flex: 1, minWidth: 0, ...flexCol(1) }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>{u.name}</span>
                <span style={{ fontSize: 11.5, color: 'var(--mut-3)', lineHeight: 1.4 }}>{[u.where, u.note].filter(Boolean).join(' · ')}</span>
              </div>
            </div>
          ))}
        </>}
      </Section>

      <MOps where="top" />

      <Section id="health-storage" title="Storage" sub={`${h.storage.length} volumes`}>
        {st.parent && <MVolume v={st.parent} />}
        {st.parent && st.disks.length > 0 && <DiskBlock disks={st.disks} parent={st.parent} labelW={48} />}
        {st.rest.map(v => <MVolume key={v.name} v={v} compact={v.tone === 'ok' && !v.missing} />)}
        {!h.storage.length && <Empty>{whyMissing(snap, 'prom-infra', 'Storage')}</Empty>}
      </Section>

      <Section id="health-alerting" title="Alerting">
        <Folded items={alertingRows(h)} all="paths" bad={a => a.tone !== 'ok'} none={<Empty>Every alerting path is working.</Empty>}
          render={a => { const j = a.jobRow, jobBad = !!j && j.status !== 'up'; return (
            <div key={a.name} id={j ? `job-${j.id}` : undefined} style={row(12, { minHeight: 50, borderBottom: RULE3, scrollMarginTop: 16 })}>
              <Dot size={7} color={toneColor(a.tone)} />
              <div style={{ flex: 1, minWidth: 0, ...flexCol(1) }}><span style={{ fontSize: 14, fontWeight: 600 }}>{a.name}</span><span style={{ fontSize: 11.5, color: jobBad ? jobText(j) : 'var(--mut-3)', ...ellipsis }}>{jobBad ? j.detail || a.where : a.where}</span></div>
              <span style={{ fontSize: 12, color: toneColor(a.tone), textAlign: 'right', maxWidth: '45%' }}>{a.state}</span>
            </div>
          ); }} />
      </Section>

      <MOps where="edge" />

      {sectionOn(snap, 'exposure') && <>
      <Section id="health-exposure" title="Public exposure" sub={h.exposure.length ? `${probed.filter(x => x.status === 'up').length} of ${probed.length} probed up` : undefined}>
        {h.exposure.length
          ? <Folded items={h.exposure} all="endpoints" bad={x => (x.via === 'port-forward' ? x.status === 'down' : x.status !== 'up')} none={<Empty>Every public endpoint answers as expected.</Empty>}
            render={(x, i) => {
              const inner = <>
                <StatusDot status={x.status} />
                <div style={{ flex: 1, minWidth: 0, ...flexCol(1) }}>
                  <span style={row(6, { fontSize: 13, fontWeight: 600, minWidth: 0 })}><span style={ellipsis}>{x.name}</span>{x.access && <Tag>{x.access}</Tag>}</span>
                  <span style={{ fontSize: 11, color: 'var(--mut-3)', ...ellipsis }}>{x.host} · {x.origin}</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flex: 'none' }}>
                  <span style={mono(11, x.code == null ? 'var(--mut-3)' : x.status === 'up' ? 'var(--mut-1)' : statusColor(x.status))}>{x.code ?? x.note ?? (x.via === 'port-forward' ? 'not probed' : '—')}</span>
                  <span style={mono(11, x.via === 'port-forward' ? 'var(--pub-fg)' : 'var(--mut-3)')}>{x.via}</span>
                </div>
              </>;
              const s = row(10, { minHeight: 48, padding: '4px 0', boxSizing: 'border-box', borderBottom: RULE3, color: 'var(--text)' });
              return x.via === 'port-forward' ? <div key={`${x.host}-${i}`} style={s}>{inner}</div> : <a key={`${x.host}-${i}`} href={x.url} {...EXT} aria-label={`Open ${x.host}`} style={s}>{inner}</a>;
            }} />
          : <Empty>{whyMissing(snap, 'probes', 'Public probes')}</Empty>}
        {h.orphans.map(o => (
          <div key={o.host} style={row(10, { minHeight: 44, borderBottom: RULE3 })}>
            <Dot size={7} color="var(--info)" />
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--info)', ...ellipsis }}>{o.host}</span>
            <span style={mono(11, 'var(--info-sub)', { flex: 'none' })}>retired, still answers{o.code != null ? ` · ${o.code}` : ''}</span>
          </div>
        ))}
      </Section>
      </>}

      <MOps where="bottom" />

      <Section id="health-sources" title="Sources" sub={sourcesLine(snap.sources)}>
        <MSources sources={snap.sources} bad={srcBad} />
      </Section>
    </div>
  );
}

/** Plans H5-H13 on the phone. top: Power and Unraid disks (after Automation); edge: tunnels, Caddy, ntfy
 *  (after Alerting); bottom: apt updates and the 'Not monitored yet' chips (before Sources). A section only shows once
 *  its area has data; an area without data is one chip. Problems first, the healthy rest behind 'Show all'. */
function MOps({ where }: { where: 'top' | 'edge' | 'bottom' }) {
  const { snap } = useApp();
  const ops = snap.health.ops;
  const [allDisks, setAllDisks] = useState(false);
  if (!ops) return null;
  if (where === 'top') {
    const d = ops.disks, bad = d ? d.rows.filter(r => r.tone !== 'ok') : [];
    return <>
      {ops.power && <Section id="health-power" title="Power" sub="UPS"><div style={{ paddingTop: 10 }}><PowerBlock p={ops.power} compact /></div></Section>}
      {d && (
        <Section id="health-disks" title="Unraid disks" sub={d.rows.length ? `${d.rows.length - bad.length} of ${d.rows.length} ok${d.readAt != null ? ` · read ${ago(d.readAt)}` : ''}` : undefined}>
          <DisksBlock d={allDisks ? d : { ...d, rows: bad }} tall />
          {d.rows.length > bad.length && <More open={allDisks} onClick={() => setAllDisks(o => !o)}>{allDisks ? 'Show problems only' : `Show all ${d.rows.length} disks`}</More>}
        </Section>
      )}
    </>;
  }
  if (where === 'edge') {
    if (!ops.edge) return null;
    const missing = opsMissing(ops, OPS_COLS.edge);
    return (
      <Section id="health-edge" title="Edge" sub="tunnels, proxy, push">
        <Folded items={ops.edge} all="edge checks" bad={l => l.tone !== 'ok'} render={l => <OpsRow key={l.id} l={l} tall />} none={<Empty>Tunnels, Caddy and ntfy are fine.</Empty>} />
        {missing.length > 0 && <OpsEmpty missing={missing} />}
      </Section>
    );
  }
  // bottom: the updates per host, then every area still without data (the Edge section lists its own)
  const shownCols = new Set<string>([...(ops.power ? OPS_COLS.power : []), ...(ops.disks ? OPS_COLS.disks : []), ...(ops.edge ? OPS_COLS.edge : [])]);
  const chips = ops.missing.filter(m => !shownCols.has(m.id));
  return <>
    {ops.updates && (
      <Section id="health-updates" title="Updates" sub="apt · pending updates never change the status line">
        {ops.updates.map(u => <OpsRow key={u.id} l={{ id: u.id, name: u.name, sub: u.sub, value: u.value, tone: u.tone }} tall />)}
      </Section>
    )}
    {chips.length > 0 && <NotYetLine missing={chips} />}
  </>;
}

// ---------------------------------------------------------------- Home (display-only)

/** Home on the phone (review findings 18-20): the summary, then the security rows (locks, garage, detectors, power,
 *  printer), then one row each for climate, appliances and lights. Display-only: the only expander is the lights'
 *  room list, and the one way to act is the 'Open in Home Assistant' link. */
function MHome() {
  const { snap } = useApp();
  const h = snap.home, c = homeState(h), cl = h.climate;
  const r = row(12, { minHeight: 52, borderBottom: RULE3 });
  const p = h.printer, tonerLow = !!p?.available && !!p.toner && Object.values(p.toner).some(v => v < TONER_LOW);
  const sm = homeSummary(h), t = TIER_C[sm.tier], ap = applianceSummary(h.appliances), lr = lightRooms(h.lights), lsub = lightsSub(h.lights);
  const [rooms, setRooms] = useState(false);
  const haDown = <Empty>{whyMissing(snap, 'prom-home', 'Home Assistant')}</Empty>;
  const name = (n: string) => <span style={{ flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600, ...ellipsis }}>{n}</span>;
  return (
    <div style={{ ...PAGE, gap: 22 }}>
      <H1>House</H1>
      <div style={flexCol(0)}>
        <div style={row(8, { fontSize: 13, color: 'var(--mut-3)', minWidth: 0 })}>
          <StatusDot status={h.haUp == null ? 'unknown' : h.haUp ? 'up' : 'down'} />
          <span style={{ fontWeight: 600, color: 'var(--text-2)', flex: 'none' }}>Home Assistant</span>
          <span style={{ minWidth: 0, ...ellipsis }}>{h.haUp == null ? 'not answering (Prometheus)' : h.haUp ? 'up' : 'down'}{h.updates?.length ? ` · ${plural(h.updates.length, 'update')}` : ''}</span>
        </div>
        <a href={h.haUrl} {...EXT} style={row(0, { minHeight: 44, alignSelf: 'flex-start', fontSize: 13, fontWeight: 600, color: 'var(--accent)', whiteSpace: 'nowrap' })}>Open in Home Assistant ↗</a>
      </div>

      <div role="status" style={flexCol(4, { paddingTop: 12, borderTop: `2px solid ${t.rule}` })}>
        <span style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', lineHeight: 1.15, color: sm.tier === 'ok' ? 'var(--text)' : t.c, overflowWrap: 'anywhere' }}>{sm.headline}</span>
        <span style={{ fontSize: 13, color: sm.tier === 'ok' || sm.tier === 'none' ? 'var(--mut-2)' : t.sub, lineHeight: 1.4 }}>{sm.since != null && <><span style={mono(13)}>{agoText(secSince(sm.since))}</span> · </>}{sm.sub}</span>
      </div>

      <section id="home-locks" aria-label="Doors, garage and detectors" style={flexCol(0, { scrollMarginTop: 16 })}>
        {h.locks.map((l, i) => { const [col, word] = lockLook(l.state); const low = l.battery != null && l.battery < LOCK_BATTERY_LOW, notes = lockNotes(l); return (
          <div key={`${l.name}-${i}`} style={r}>
            <Dot size={8} color={col} pulse={l.state === 'jammed' ? 'danger' : undefined} />
            <div style={{ flex: 1, minWidth: 0, ...flexCol(2) }}>
              <span style={{ fontSize: 15, fontWeight: 600, ...ellipsis }}>{l.name}</span>
              <span style={{ fontSize: 12, color: 'var(--mut-3)', ...ellipsis }}>
                {[notes.door && <span key="d" style={{ color: l.door === 'open' ? 'var(--warn)' : undefined }}>{notes.door}</span>,
                  l.battery != null && <span key="b" style={{ color: low ? 'var(--warn)' : undefined }}>battery {Math.round(l.battery)}%</span>,
                  l.since != null && <span key="s">{agoText(secSince(l.since))} ago</span>].filter(Boolean).flatMap((x, k) => (k ? [' · ', x] : [x]))}
              </span>
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: col, flex: 'none' }}>{word}</span>
          </div>
        ); })}
        {h.garage ? (
          <div style={r}>
            <Dot size={8} color={c.gOpen == null ? 'var(--mut-5)' : c.gOpen ? 'var(--warn)' : 'var(--ok)'} />
            <div style={{ flex: 1, minWidth: 0, ...flexCol(2) }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Garage door</span>
              <span style={{ fontSize: 12, color: 'var(--mut-3)', ...ellipsis }}>{c.garageSub}{h.garage.obstruction && <span style={{ color: 'var(--warn)' }}> · obstruction detected</span>}</span>
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: c.gOpen == null ? 'var(--mut-3)' : c.gOpen ? 'var(--warn)' : 'var(--ok)', flex: 'none' }}>{c.garageWord}</span>
          </div>
        ) : null}
        {h.smoke.map((s, i) => { const [col, word] = smokeLook(s.state); return (
          <div key={`${s.name}-${i}`} style={r}>
            <Dot size={8} color={col} pulse={s.state === 'alarm' ? 'danger' : undefined} />
            <div style={{ flex: 1, minWidth: 0, ...flexCol(1) }}>
              <span style={{ fontSize: 15, fontWeight: 600, ...ellipsis }}>{s.name}</span>
              {s.detail && <span style={{ fontSize: 12, color: 'var(--mut-3)', ...ellipsis }}>{s.detail}</span>}
            </div>
            <span style={{ fontSize: 13, color: col, fontWeight: 700, flex: 'none' }}>{word}</span>
          </div>
        ); })}
        {snap.health.ops?.power && <UpsHomeRow p={snap.health.ops.power} minHeight={52} />}
        {p && (
          <div style={r}>
            <span title={!p.available ? 'unavailable' : tonerLow ? 'toner low' : 'available'} style={{ display: 'flex' }}><Dot size={8} color={!p.available ? 'var(--mut-5)' : tonerLow ? 'var(--warn)' : 'var(--ok)'} /></span>
            <div style={{ flex: 1, minWidth: 0, ...flexCol() }}>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Printer</span>
              <span style={{ fontSize: 12, color: 'var(--mut-3)', ...ellipsis }}>{p.model} · {!p.available ? 'unavailable' : tonerLow ? 'toner low' : 'available'}</span>
            </div>
            <Toner t={p.available ? p.toner : null} />
          </div>
        )}
        {!h.locks.length && !h.garage && !h.smoke.length && (h.configured.locks || h.configured.garage || h.configured.safety) && haDown}
      </section>

      <section aria-label="Climate, appliances and lights" style={flexCol(0)}>
        {!h.configured.climate ? null : cl ? (
          <div style={r}>
            {name('Climate')}
            {cl.available ? <><span style={mono(15, undefined, { fontWeight: 500, flex: 'none' })}>{cl.indoor.toFixed(1)}°</span><span style={{ fontSize: 12, color: climateTarget(cl).color, flex: 'none' }}>{climateTarget(cl).text}</span></>
              : <span style={{ fontSize: 12, color: 'var(--mut-3)' }}>unavailable</span>}
          </div>
        ) : haDown}
        {h.moreClimates.map((m, i) => { const ml = climateLine(m); return (
          <div key={`${m.name}-${i}`} title={ml.title} style={r}>
            {name(m.name)}
            {ml.temp && <span style={mono(15, undefined, { fontWeight: 500, flex: 'none' })}>{ml.temp}</span>}
            <span style={{ fontSize: 12, color: ml.heating ? 'var(--heat)' : 'var(--mut-3)', flex: 'none' }}>{ml.word}</span>
          </div>
        ); })}
        {h.appliances.length > 0 && (
          <div id="home-appliances" style={{ ...r, alignItems: 'flex-start', padding: '14px 0', boxSizing: 'border-box', scrollMarginTop: 16 }}>
            {name(ap.rows.length ? ap.rows[0].a.name : 'Appliances')}
            <div style={flexCol(3, { alignItems: 'flex-end', minWidth: 0, maxWidth: '62%', textAlign: 'right' })}>
              {ap.rows.length ? <span style={{ fontSize: 12, color: ap.rows[0].color }}>{[ap.rows[0].word.toLowerCase(), ap.rows[0].right].filter(Boolean).join(' · ')}{ap.rows.length > 1 ? ` · +${ap.rows.length - 1} running` : ''}</span>
                : <span style={{ fontSize: 12, color: 'var(--mut-3)' }}>{ap.idleText}</span>}
              {ap.rows.length > 0 && ap.idleText && <span style={{ fontSize: 11.5, color: 'var(--mut-3)' }}>{ap.idleText}</span>}
              {ap.warnings.map((w, i) => <span key={i} style={{ fontSize: 11.5, color: 'var(--warn)' }}>{w}</span>)}
            </div>
          </div>
        )}
        {h.lights.length > 0 && <>
          <button id="home-lights" aria-expanded={rooms} onClick={() => setRooms(o => !o)} style={{ ...r, width: '100%', boxSizing: 'border-box', textAlign: 'left', scrollMarginTop: 16 }}>
            {name('Lights')}
            <span style={{ fontSize: 12, color: 'var(--mut-3)', flex: 'none' }}>{lsub ?? 'no data'}</span>
            <span aria-hidden="true" style={{ color: 'var(--mut-3)', fontSize: 12, flex: 'none' }}>{rooms ? '▴' : '▾'}</span>
          </button>
          {rooms && [...lr.lit, ...lr.dark].map(x => (
            <div key={x.room} style={row(10, { minHeight: 40, paddingLeft: 4, borderBottom: RULE3 })}>
              <Dot size={7} color={x.on ? 'var(--accent)' : 'var(--mut-5)'} />
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, ...ellipsis }}>{x.room}</span>
              <span style={{ fontSize: 12, color: 'var(--mut-3)', flex: 'none' }}>{x.on ? `${x.on} of ${x.total} on` : x.known < x.total ? 'no data' : 'all off'}</span>
            </div>
          ))}
        </>}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------- Devices (the router's list, read-only)

/** Two lines; while filtering, line 2 is the field that matched, highlighted (review finding 21). */
const MDevRow = ({ r, id, q }: { r: DeviceRow; id: DevicesView['groups'][number]['id']; q: string }) => {
  const sub = matchedLine(r, q);
  return (
    <div id={`dev-${r.key}`} style={row(12, { minHeight: 52, borderBottom: RULE3, scrollMarginTop: 16 })}>
      <DevDot s={r.status} id={id} />
      <div style={{ flex: 1, minWidth: 0, ...flexCol(1) }}>
        <span style={{ fontSize: 14, fontWeight: 600, ...ellipsis }}><Hl text={r.name} q={q} /></span>
        {sub && <span style={{ fontSize: 12, color: 'var(--mut-3)', ...ellipsis }}><Hl text={sub} q={q} /></span>}
      </div>
      <span style={mono(11, 'var(--mut-3)', { flex: 'none' })}>{devIp(r.ip)}</span>
    </div>
  );
};

function MDevices() {
  const { snap, ui, set } = useApp();
  const d = snap.devices, counts = devCounts(d);
  const { q, groups, label } = useDeviceGroups();
  return (
    <div style={{ ...PAGE, gap: 20 }}>
      <button onClick={() => { set({ mTab: 'Health' }); scrollTo(0, 0); }} style={row(6, { minHeight: 44, margin: '-6px 0 -12px', color: 'var(--accent)', fontSize: 15, fontWeight: 600, alignSelf: 'flex-start' })}>
        <span style={{ fontSize: 22 }} aria-hidden="true">‹</span>Health
      </button>
      <H1 right={<span style={{ fontSize: 12, color: 'var(--mut-3)' }}>{label}</span>}>Devices</H1>
      <span style={{ fontSize: 13, color: 'var(--mut-3)', lineHeight: 1.4 }}>
        {counts ? <><span style={{ color: 'var(--text-2)', fontWeight: 600 }}>{counts}</span> · {d.counts!.older} not seen for 30 days · list {ago(d.at)}</>
          : <>Infra and smart home from homelab.json · {whyMissing(snap, 'devices', 'device list')}</>}
      </span>
      <SearchField value={ui.deviceQuery} onChange={v => set({ deviceQuery: v })} placeholder="Filter devices" />
      {groups.map(g => g.id.startsWith('seg:') && !q ? (
        <section key={g.id} id={`devices-${g.id}`} style={flexCol(0, { borderTop: '1px solid var(--rule)', scrollMarginTop: 16 })}>
          <More open={ui.segOpen.includes(g.id)} onClick={() => set(s => ({ segOpen: s.segOpen.includes(g.id) ? s.segOpen.filter(x => x !== g.id) : [...s.segOpen, g.id] }))}><span style={{ ...eb(), flex: 1, textAlign: 'left' }}>{g.title} · {groupSub(g)}</span></More>
          {ui.segOpen.includes(g.id) && g.rows.map(r => <MDevRow key={r.key} r={r} id={g.id} q={q} />)}
        </section>
      ) : (
        <Section key={g.id} id={`devices-${g.id}`} title={g.title} sub={groupSub(g)}>
          {/* Other LAN: its offline rows, then 'Show all N' (as on desktop) */}
          {(() => {
            const rows = lanFolded(g, q, ui.lanOpen) ? lanRows(g.rows) : g.rows, more = g.id === 'lan' && !q && g.rows.length > lanRows(g.rows).length;
            return <>
              {rows.length ? rows.map(r => <MDevRow key={r.key} r={r} id={g.id} q={q} />) : <Empty>{g.rows.length ? 'Nothing offline' : 'None in the last 30 days'}</Empty>}
              {more && <More open={ui.lanOpen} onClick={() => set(s => ({ lanOpen: !s.lanOpen }))}>{ui.lanOpen ? 'Show offline only' : `Show all ${g.rows.length}`}</More>}
            </>;
          })()}
        </Section>
      ))}
      {!groups.length && <Empty>Nothing matches “{ui.deviceQuery}”</Empty>}
    </div>
  );
}

// ---------------------------------------------------------------- incident hero (review Phase 5, 1c)

/** Anything red: the Overview's hero becomes the incident. Headline, the path as chips, the sentence, the next steps
 *  (links that open elsewhere), the monitor's last 24 h, the notes and the everyday Open grid. */
function MIncidentHero({ band, openSearch }: { band: Band; openSearch: () => void }) {
  const { snap } = useApp();
  const [open, setOpen] = useState(false);
  const { item, hops, monitor: m, notes } = band;
  const where = band.url ? shortUrl(band.url) : item.source;
  const all = openItems(snap), byName = (n: string) => all.find(u => u.key === `ui-${n}`);
  // the everyday eight (1c); the failing service takes the last place when it isn't one of them
  const subject = item.id.startsWith('down-') ? item.id.slice(5) : null;
  const pins = phonePins().filter(n => byName(n)).slice(0, 8);
  if (subject && byName(subject) && !pins.includes(subject)) pins.splice(Math.min(pins.length, 7), 1, subject);
  return (
    <div data-hero="incident" style={flexCol(18)}>
      <div style={row(12, { alignItems: 'flex-start' })}>
        <div style={{ flex: 1, minWidth: 0, ...flexCol(4) }}>
          <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-.02em', lineHeight: 1.15, color: 'var(--danger)', overflowWrap: 'anywhere' }}>{item.title}</span>
          <span style={{ fontSize: 13, color: 'var(--danger-sub)', ...ellipsis }}>
            {item.since != null && <><span style={mono(13)}>{agoText(secSince(item.since))}</span> · </>}{where}
          </span>
          <LinkLine />
        </div>
        <button onClick={openSearch} aria-label="Search and launch" style={{ width: 44, height: 44, borderRadius: 12, border: '1px solid var(--rule)', display: 'grid', placeItems: 'center', color: 'var(--mut-1)', flex: 'none' }}><SearchIcon size={18} /></button>
      </div>
      {hops ? <>
        <div role="list" aria-label={`Path to ${hops[hops.length - 1].name}`} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 4px', fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>
          {hops.slice(1).map((h, i, a) => { const bad = i === a.length - 1; return (
            <Fragment key={i}>
              <span role="listitem" title={STATUS_WORD[h.status]} style={row(5, { padding: '4px 9px', borderRadius: 99, border: `1px solid ${bad ? 'var(--danger-rule)' : 'var(--pill-bd)'}`, color: bad ? 'var(--danger)' : undefined })}>
                <StatusDot status={h.status} size={6} />{h.chip ?? h.name}
              </span>
              {!bad && <span aria-hidden="true" style={{ color: 'var(--mut-3)' }}>›</span>}
            </Fragment>
          ); })}
        </div>
        {band.sentence && <span style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-2)' }}>{band.sentence}</span>}
      </> : <span style={{ fontSize: 13, lineHeight: 1.5, color: 'var(--text-2)' }}>{item.detail}</span>}
      {band.actions.length > 0 && (
        <div style={flexCol(8)}>
          {band.actions.slice(0, 2).map(a => (
            <a key={a.href} href={a.href} {...EXT} style={row(8, { height: 44, padding: '0 16px', borderRadius: 12, border: `1px solid ${a.primary ? 'var(--danger-rule)' : 'var(--rule)'}`, color: a.primary ? 'var(--danger)' : 'var(--text-2)', fontSize: 14, fontWeight: a.primary ? 700 : 600 })}>
              <span style={{ minWidth: 0, ...ellipsis }}>{a.label}</span><span style={{ flex: 1 }} /><span aria-hidden="true">↗</span>
            </a>
          ))}
        </div>
      )}
      {m && (
        <div style={flexCol(8)}>
          <span style={eb()}>Last 24 h</span>
          <UptimeCells cells={m.cells} radius={1.5} title={`Last 24 h${m.uptime1 != null ? `: ${m.uptime1.toFixed(2)}% up` : ''}, down now`} />
        </div>
      )}
      {notes.length > 0 && (
        <div style={flexCol()}>
          <button aria-expanded={open} onClick={() => setOpen(o => !o)} style={row(10, { height: 52, padding: '0 4px', width: '100%', boxSizing: 'border-box', borderTop: RULE3, borderBottom: RULE3, color: 'var(--text)', textAlign: 'left' })}>
            <Dot size={7} color="var(--info)" />
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-2)', flex: 'none' }}>{plural(notes.length, 'note')}</span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--mut-3)', textAlign: 'right', ...ellipsis }}>{notes.slice(0, 2).map(a => a.title).join(' · ')}</span>
            <span aria-hidden="true" style={{ color: 'var(--mut-3)', flex: 'none' }}>{open ? '▴' : '▾'}</span>
          </button>
          {open && notes.map(a => <MAttnRow key={a.id} a={a} />)}
        </div>
      )}
      <div style={flexCol(12)}>
        <span style={eb()}>Open</span>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: '16px 8px' }}>
          {pins.map(n => { const u = byName(n)!; return <MTile key={u.key} u={u} label={u.label} />; })}
        </div>
      </div>
    </div>
  );
}
