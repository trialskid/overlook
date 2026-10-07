import { Fragment, useEffect, type ReactNode } from 'react';
import { classicOverview, useApp } from '../state.tsx';
import { visibleTabs } from '../lib/modules.ts';
import { frozen, linkChip, linkState, useNow } from '../lib/live.ts';
import { agoText, clockSec, clockText, greeting, scrollToId, secSince, toneColor } from '../lib/util.ts';
import { Dot, FrozenBanner, SearchIcon, ellipsis, mono, row, useFrozen } from '../lib/ui.tsx';
import { Roll } from '../lib/motion.tsx';
import { countText, counts, incidentItem, joinAnd, needsYou, restText, shownCounts, type Count } from '../lib/incident.ts';
import { ClassicOverview } from './Overview.tsx';
import { rearm } from './Trace.tsx';
import { OverviewShape } from './Shape.tsx';
import { Health } from './Health.tsx';
import { Media } from './Media.tsx';
import { Home } from './Home.tsx';
import type { Tone } from '../../shared/types.ts';

export const DESK_W = 1440;
/** Big screens scale up to this (a 1920 window is filled; 2560 gets a 1920px composition). */
const MAX_ZOOM = 1.33;
/** the header status dot's 4px halo */
const HALO: Record<Tone, string> = { ok: 'var(--ok-a16)', warn: 'var(--warn-a18)', danger: 'var(--danger-a18)' };

/** The 1440px desktop composition, scaled to the window from MOBILE_MAX (1152, zoom 0.8) up to MAX_ZOOM; narrower
 *  windows get the phone layout rather than unreadable text or a sideways scroll. */
export function Desktop({ width }: { width: number }) {
  const { ui, snap } = useApp();
  const zoom = Math.min(width / DESK_W, MAX_ZOOM);
  const old = useFrozen(), classic = classicOverview();
  // review Phase 5: the Overview glows red while its incident band leads (never over old data)
  // a tab whose modules a config reload turned off falls back to Overview
  const tab = visibleTabs(snap).includes(ui.dTab) ? ui.dTab : 'Overview';
  const red = tab === 'Overview' && !classic && !old && !!incidentItem(snap);
  // here, not in the trace: a recovery (or a new outage) while another tab is open still re-arms it
  useEffect(() => rearm(snap.attention), [snap.attention]);
  return (
    <div style={{ minHeight: '100vh', background: red ? 'var(--page-glow-danger)' : 'var(--page-glow)', color: 'var(--text)' }}>
      <div style={{ width: DESK_W, boxSizing: 'border-box', margin: '0 auto', padding: '28px 36px 44px', display: 'flex', flexDirection: 'column', gap: 20, zoom }}>
        <Header />
        <FrozenBanner />
        <div className={old ? 'frozen' : undefined}>
          {tab === 'Overview' && (classic ? <ClassicOverview /> : <OverviewShape />)}
          {tab === 'Health' && <Health />}
          {tab === 'Media' && <Media />}
          {tab === 'House' && <Home />}
        </div>
      </div>
    </div>
  );
}

function Header() {
  const { snap, ui, set, live } = useApp();
  const now = useNow();
  const w = snap.weather;
  const st = linkState(live, now.getTime()), chip = linkChip(st, snap), old = frozen(st);
  const stale = snap.fresh.stale.length + snap.fresh.errors.length;
  const linkTitle = st === 'offline' ? 'No data from the Command Center server for over 5 s; reconnecting'
    : st === 'stale' ? 'The server has not sent a new snapshot for over 25 s'
      : snap.mock ? 'Mock data (MOCK=1): sample values, not the homelab'
        : snap.simulated ? 'Simulated incident (?simulateIncident=1): one failure below is made up'
          : st === 'partial' ? `${stale} source${stale === 1 ? '' : 's'} not answering: ${[...snap.fresh.stale, ...snap.fresh.errors].join(', ')}` : 'Live: ticks every second, snapshot rebuilt every 10 s';
  // the status is the headline: the phone hero's text when something is wrong, 'All systems nominal' when not
  const s = snap.status, bad = s.tone === 'danger' || s.tone === 'warn';
  const worst = bad ? needsYou(snap.attention)[0] : undefined;
  const dot = old ? 'var(--mut-3)' : toneColor(s.tone);
  return (
    <header style={row(20)}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
        <div style={row(12, { minWidth: 0 })}>
          <Dot size={10} color={dot} style={{ boxShadow: old ? 'none' : `0 0 0 4px ${HALO[s.tone]}` }} />
          <span role="status" title={s.headline} style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', color: old ? 'var(--mut-3)' : bad ? toneColor(s.tone) : 'var(--text)', minWidth: 0, ...ellipsis }}>
            {bad ? s.headline : s.short}{old ? ` · as of ${clockText(new Date(live.lastSnapshotAt || snap.at))}` : ''}
          </span>
          {worst?.since != null && !old && <span title={`since ${new Date(worst.since).toLocaleString()}`} style={mono(13, s.tone === 'danger' ? 'var(--danger-sub)' : 'var(--warn-sub)', { fontWeight: 500, flex: 'none' })}>{agoText(secSince(worst.since))}</span>}
        </div>
        {/* 4px of room inside the clip for the count links' focus ring; the negative margin keeps the layout */}
        <div style={{ fontSize: 13, color: old ? 'var(--mut-3)' : 'var(--mut-2)', minWidth: 0, padding: 4, margin: -4, ...ellipsis }}>
          {classicOverview()
            ? <>{greeting(now).replace(/\.$/, '')}{snap.ui.brand ? ` · ${snap.ui.brand}` : ''} · {w ? `${w.tempC.toFixed(1)}°C, ${w.text} in ${w.place}` : 'weather not answering'}</>
            : <CountsLine greet={greeting(now)} old={old} />}
        </div>
      </div>
      <div style={{ flex: 1 }} />
      <nav role="tablist" style={{ display: 'flex', gap: 26, fontSize: 14, fontWeight: 600, flex: 'none' }}>
        {visibleTabs(snap).map(t => (
          <button key={t} role="tab" aria-selected={ui.dTab === t} onClick={() => set({ dTab: t })}
            style={{ padding: '6px 0', borderBottom: `2px solid ${ui.dTab === t ? 'var(--accent)' : 'transparent'}`, color: ui.dTab === t ? 'var(--text)' : 'var(--mut-3)', transition: 'all .15s' }}>{t}</button>
        ))}
      </nav>
      <button className="h-search" onClick={() => set({ cmdOpen: true })} aria-label="Search everything"
        style={row(10, { width: 210, flex: 'none', padding: '8px 8px 8px 12px', border: '1px solid var(--rule)', borderRadius: 10, color: 'var(--mut-3)', fontSize: 13, transition: 'all .15s' })}>
        <SearchIcon /><span style={{ flex: 1 }}>Search everything</span>
        <span style={mono(11, 'var(--mut-1)', { padding: '2px 6px', borderRadius: 5, background: 'var(--hover)' })}>⌘K</span>
      </button>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5, flex: 'none' }}>
        <div style={mono(15, 'var(--text-2)', { fontWeight: 500, lineHeight: 1 })}>{clockText(now)}</div>
        <div title={linkTitle} style={row(6, { fontSize: 11, color: 'var(--mut-3)', letterSpacing: '.08em', whiteSpace: 'nowrap' })}>
          <Dot size={6} color={chip.color} pulse={chip.pulse ? 'ok2' : undefined} />
          <span style={{ color: chip.pulse ? undefined : chip.color, fontWeight: chip.pulse ? undefined : 700 }}>{chip.label}</span>
          <span>· updated <span style={mono(11)}>{live.lastSnapshotAt ? clockSec(new Date(live.lastSnapshotAt)) : '—'}</span></span>
        </div>
      </div>
    </header>
  );
}

/** The header's counts line instead of a KPI row. Calm: 'Good afternoon · 36 web UIs, 4 hosts and
 *  8 guests answering · 9.4°C, overcast'. While something is red: the counts short of their total and what else is
 *  open, '35 of 36 web UIs answering · everything else nominal'. Each count opens what explains it (web UIs: Health ›
 *  Service uptime; hosts and guests: the full map) and its digits roll (3e), a short one turning --danger. */
function CountsLine({ greet, old }: { greet: string; old: boolean }) {
  const { snap, set } = useApp();
  const inc = !!incidentItem(snap), cs = shownCounts(counts(snap), inc), w = snap.weather;
  const uis = cs.find(c => c.id === 'uis'), hg = cs.filter(c => c.id !== 'uis');
  // red only when the server's KPI is (and never over old data); a count that's merely short keeps the line's colour
  const num = (c: Count) => (
    <Fragment key={c.id}><span style={{ color: c.danger && !old ? 'var(--danger)' : undefined, transition: 'color .4s' }}><Roll v={String(c.up)} />{c.up < c.total ? ` of ${c.total}` : ''}</span> {c.noun}</Fragment>
  );
  const link = (onClick: () => void, label: string, children: ReactNode) =>
    <button type="button" className="h-link" onClick={onClick} aria-label={label} title={label} style={{ color: 'inherit' }}>{children}</button>;
  const toUptime = () => { set({ dTab: 'Health', mTab: 'Health', selection: null }); scrollToId('health-uptime', 60); };
  const toMap = () => { set({ dTab: 'Overview', mTab: 'Overview', mapOpen: true }); scrollToId('overview-map', 60); };
  const what = cs.length ? <>
    {uis && link(toUptime, `${countText(uis)}: open Service uptime on Health`, num(uis))}
    {uis && hg.length > 0 && (hg.length > 1 ? ', ' : ' and ')}
    {hg.length > 0 && link(toMap, `${joinAnd(hg.map(countText))}: open the full map`, hg.map((c, i) => <Fragment key={c.id}>{i > 0 && ' and '}{num(c)}</Fragment>))}
    {' answering'}
  </> : null;
  // keyed by part, so the counts keep their identity (and their digits roll) when the shape flips
  const parts: [string, ReactNode][] = inc
    ? [['what', what], ['rest', restText(snap)]]
    : [['greet', greet.replace(/\.$/, '')], ['what', what], ['weather', w ? `${w.tempC.toFixed(1)}°C, ${w.text}` : 'weather not answering']];
  return <>{parts.filter(([, p]) => p).map(([k, p], i) => <Fragment key={k}>{i > 0 && ' · '}{p}</Fragment>)}</>;
}
