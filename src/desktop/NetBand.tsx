// Review Phase 5 (1c): the network band. Calm: the upstream chain on one line (Internet → gateway → switch, whichever
// the lab names, and the tunnel) and the hosts in up to four columns with their guests as chips. During an incident everything off the
// failing path dims (other hosts .32, the failing host's other leaves .45; a failing chip never dims). "Full map ↘"
// opens today's NetworkMap in place, with the host / guest details beside it.
import { useMemo, type ReactNode } from 'react';
import { useApp, type Selection } from '../state.tsx';
import { STATUS_WORD, fmt1, last, scaleMax, scrollToId, statusColor, tint, worst } from '../lib/util.ts';
import { Badge, Dot, Spark, StatusDot, Tile, ellipsis, flexCol, mono, row, ruled } from '../lib/ui.tsx';
import { layoutMap, type PlacedLeaf } from '../map/layout.ts';
import type { Band } from '../lib/incident.ts';
import type { HostView } from '../../shared/types.ts';
import { NetworkMap, TIER, failTier, failingUisOf, leafHue } from './NetworkMap.tsx';
import { GuestPanel, HostPanel } from './Overview.tsx';

type Path = Band['path'];
type Show = (s: NonNullable<Selection>) => void;

export function NetworkBand({ band }: { band: Band | null }) {
  const { snap, ui, set } = useApp();
  const L = useMemo(() => layoutMap(snap.hosts), [snap.hosts]);
  const path = band?.path ?? null, subject = band?.hops ? band.hops[band.hops.length - 1].name : null;
  // a chip or a host opens the full map with it selected; focus follows, since the chip itself goes away
  const show: Show = s => {
    set({ selection: s, mapOpen: true });
    scrollToId('overview-map', 60);
    setTimeout(() => document.getElementById('overview-map')?.focus({ preventScroll: true }), 80);
  };
  return (
    <section data-section="network" aria-label="Network" style={ruled('14px 0 0', 'var(--rule)', flexCol(16))}>
      <div style={row(14, { minWidth: 0 })}>
        <span style={{ fontSize: 17, fontWeight: 700, flex: 'none' }}>Network</span>
        {/* the full map draws the chain and the tunnel itself */}
        {subject ? <span style={{ fontSize: 12, color: 'var(--mut-3)', minWidth: 0, ...ellipsis }}>{ui.mapOpen ? `Path to ${subject} in red` : `Path to ${subject} highlighted, everything else dimmed`}</span> : !ui.mapOpen && <Chain />}
        <span style={{ flex: 1 }} />
        {!subject && !ui.mapOpen && snap.network.tunnelName && <TunnelPill />}
        <button type="button" className="h-link" aria-expanded={ui.mapOpen} aria-controls="overview-map" onClick={() => set(ui.mapOpen ? { mapOpen: false, selection: null } : { mapOpen: true })}
          style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', flex: 'none' }}>{ui.mapOpen ? 'Hide map ↖' : 'Full map ↘'}</button>
      </div>
      {ui.mapOpen ? (
        <div id="overview-map" tabIndex={-1} aria-label="Network map" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 40, scrollMarginTop: 20 }}>
          <NetworkMap />
          <MapDetail />
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(4, Math.max(1, L.hosts.length))},minmax(0,1fr))`, gap: '24px 28px', borderTop: '1.5px solid var(--line)', paddingTop: 14 }}>
          {L.hosts.map(({ host: h }) => <HostColumn key={h.id} h={h} leaves={L.leaves.filter(p => p.hostId === h.id)} path={path} show={show} />)}
        </div>
      )}
    </section>
  );
}

/** Internet → gateway (WAN ↓↑) → switch (EOL), each with its own status, whichever the lab names; boxes like the
 *  map's nodes. */
function Chain() {
  const { snap, live } = useApp();
  const n = snap.network, gw = n.gateway, sw = n.switch, gws = gw ? worst(gw.status, gw.wan) : 'unknown';
  const wanIn = last(live.history.wanIn), wanOut = last(live.history.wanOut);
  const gwSub = !gw ? '' : gw.wan === 'down' ? 'WAN down' : gw.status === 'down' ? 'not answering' : wanIn == null && wanOut == null ? '' : `↓ ${fmt1(wanIn)} ↑ ${fmt1(wanOut)} Mb/s`;
  const link = <span aria-hidden="true" style={{ width: 28, height: 1.5, background: 'var(--line)', flex: 'none' }} />;
  const node = (down: boolean, title: string, children: ReactNode) => (
    <span title={title} style={row(8, { padding: '6px 12px', borderRadius: 12, border: `1px solid ${down ? 'var(--danger-rule)' : 'var(--rule)'}`, background: 'var(--surface)', whiteSpace: 'nowrap', flex: 'none' })}>{children}</span>
  );
  return (
    <div style={row(0, { flex: 'none' })}>
      <span title={`Reachability from outside: ${STATUS_WORD[n.internet]}`} style={row(6, { padding: '5px 12px', borderRadius: 99, border: `1px solid ${n.internet === 'down' ? 'var(--danger-rule)' : 'var(--pill-bd)'}`, background: 'var(--pill)', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', flex: 'none' })}>
        {n.internet !== 'up' && <StatusDot status={n.internet} size={6} />}Internet
      </span>
      {gw && <>{link}{node(gws === 'down', `${gw.name} ${STATUS_WORD[gw.status]} · WAN ${STATUS_WORD[gw.wan]}`, <>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{gw.name}</span>
        <span style={mono(11, gws === 'down' ? 'var(--danger)' : 'var(--mut-3)')}>{gw.ipShort}{gwSub ? ` · ${gwSub}` : ''}</span>
        <StatusDot status={gws} size={7} />
      </>)}</>}
      {sw && <>{link}{node(sw.status === 'down', `${sw.name} · ${STATUS_WORD[sw.status]}`, <>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>{sw.name}</span>
        <span style={mono(11, 'var(--mut-3)')}>{sw.ipShort}</span>
        {sw.eol && <span title={`Firmware ${sw.firmware ?? ''} is end of life`}><Badge kind="eol">EOL</Badge></span>}
        <StatusDot status={sw.status} size={7} />
      </>)}</>}
    </div>
  );
}

/** '<tunnel> · 10 public'; a dot only when the tunnel or the internet isn't fine (as on the map). */
function TunnelPill() {
  const { snap } = useApp();
  const n = snap.network, bad = n.internet !== 'up' || n.tunnel?.status === 'degraded' || n.tunnel?.status === 'down';
  return (
    <span title={`${n.tunnelName} · public checks: ${STATUS_WORD[n.internet]}${n.tunnel ? ` · ${n.tunnel.text} connections` : ''}`}
      style={row(8, { padding: '5px 12px', borderRadius: 99, border: `1px solid ${n.internet === 'down' ? 'var(--danger-rule)' : 'var(--pub-bd)'}`, background: 'var(--pub-bg)', fontSize: 12, fontWeight: 600, color: 'var(--pub-fg)', whiteSpace: 'nowrap', flex: 'none' })}>
      {bad && <Dot size={7} color={n.internet !== 'up' ? statusColor(n.internet) : n.tunnel?.status === 'down' ? 'var(--danger)' : 'var(--warn)'} />}
      {n.tunnelName} · {n.publicCount} public
    </span>
  );
}

/** A host: tile, name, IP, a 64×18 CPU sparkline and its %, its status; under it, its leaves as wrapping chips. */
function HostColumn({ h, leaves, path, show }: { h: HostView; leaves: PlacedLeaf[]; path: Path; show: Show }) {
  const { live } = useApp();
  const series = live.history.cpu[h.id] ?? [], cpu = last(series), hasCpu = series.some(v => v != null);
  const off = !!path && path.hostId !== h.id;
  return (
    <div data-host={h.id} data-off={off ? '' : undefined} style={flexCol(10, { minWidth: 0 })}>
      <button type="button" className="h-inset" onClick={() => show({ kind: 'host', id: h.id })} aria-label={`Show ${h.name} on the map`} title={`${h.name} · ${STATUS_WORD[h.status]}`}
        style={row(10, { width: 'calc(100% + 12px)', boxSizing: 'border-box', margin: '-4px -6px', padding: '4px 6px', borderRadius: 8, color: 'inherit', opacity: off ? 0.32 : 1, transition: 'opacity var(--sel-fade)' })}>
        <Tile mono={h.mono} hue={h.hue} size={28} radius={8} fontSize={11} />
        <span style={flexCol(0, { minWidth: 0 })}>
          <span style={{ fontSize: 13, fontWeight: 700, ...ellipsis }}>{h.name}</span>
          <span style={mono(11, 'var(--mut-3)', ellipsis)}>{h.ipS}</span>
        </span>
        <span style={{ flex: 1 }} />
        {hasCpu
          ? <Spark data={series} w={64} h={18} width={64} height={18} max={scaleMax(series, h.cpuScale)} fill={null} sw={1.5} style={{ flex: 'none' }} />
          : <span title="No live CPU feed for this host" style={{ width: 64, flex: 'none' }} />}
        <span style={mono(12, cpu == null ? 'var(--mut-3)' : 'var(--text-2)', { width: 30, textAlign: 'right', flex: 'none' })}>{cpu != null ? `${Math.round(cpu)}%` : '—'}</span>
        <StatusDot status={h.status} size={7} />
      </button>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {leaves.map(p => {
          // a failing leaf never dims; on the failing host its siblings fade a little, elsewhere everything does
          // (a host's own web UI has no guest on the path: all its leaves are siblings; a host that's down keeps them lit)
          const tier = failTier(p.leaf), sib = !!path && path.hostId === h.id && path.kind !== 'host' && (p.leaf.guestId ?? null) !== path.guestId;
          return <LeafChip key={p.key} p={p} show={show} opacity={tier ? 1 : off ? 0.32 : sib ? 0.45 : 1} />;
        })}
      </div>
    </div>
  );
}

function LeafChip({ p, show, opacity }: { p: PlacedLeaf; show: Show; opacity: number }) {
  const { snap } = useApp();
  const l = p.leaf, tier = failTier(l), why = tier ? failingUisOf(snap, l) : '', tag = l.kind === 'vm' || l.kind === 'lxc';
  const style = row(6, {
    height: 24, boxSizing: 'border-box', padding: tag ? '0 9px 0 4px' : '0 9px', borderRadius: 99, background: 'var(--pill)', maxWidth: '100%',
    border: `1px solid ${tier ? TIER[tier].rule : l.public ? 'var(--pub-bd)' : 'var(--pill-bd)'}`, whiteSpace: 'nowrap', color: 'inherit', flex: 'none', opacity,
    transition: 'opacity var(--sel-fade), border-color var(--sel-fade)',
  });
  const inner = <>
    {tag && <span style={{ minWidth: 24, height: 18, padding: '0 3px', boxSizing: 'border-box', borderRadius: l.kind === 'vm' ? 3 : 9, ...tint(leafHue(l)), display: 'grid', placeItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, flex: 'none' }}>{l.tag}</span>}
    <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-2)', minWidth: 0, ...ellipsis }}>{l.name}</span>
    {l.count && <span style={mono(11, 'var(--mut-3)', { flex: 'none' })}>{l.count}</span>}
    {l.kind !== 'role' && <StatusDot status={l.status} monitored={l.monitored !== false} size={6} />}
    {why && <span style={{ fontSize: 11, fontWeight: 700, color: TIER[tier!].c, flex: 'none' }}>{why}</span>}
  </>;
  // an app with a URL opens it (as on the map); a guest, or anything else, shows on the full map
  const state = l.monitored !== false ? STATUS_WORD[l.status].toLowerCase() : 'no monitor';
  if (!l.guestId && l.url) return <a href={l.url} target="_blank" rel="noopener noreferrer" title={`${l.name} · ${state} · ${l.url}`} aria-label={`Open ${l.name} · ${state}`} className="h-node" data-fail={tier ?? undefined} style={style}>{inner}</a>;
  const target = l.guestId ? { kind: 'guest' as const, id: l.guestId } : { kind: 'host' as const, id: p.hostId };
  return <button type="button" onClick={() => show(target)} aria-label={`Show ${l.name} on the map`} title={`${l.name} · ${STATUS_WORD[l.status]}`} className="h-node" data-fail={tier ?? undefined} style={style}>{inner}</button>;
}

/** Beside the full map: the selected host's or guest's details (as classic's side panel), keyed per selection. */
function MapDetail() {
  const { ui, guestById, hostById } = useApp();
  const sel = ui.selection, g = sel?.kind === 'guest' ? guestById(sel.id) : undefined, h = sel?.kind === 'host' ? hostById(sel.id) : undefined;
  if (g) return <GuestPanel key={`g-${g.id}`} g={g} />;
  if (h) return <HostPanel key={`h-${h.id}`} h={h} />;
  return <div style={ruled('20px 0 0', 'var(--rule)')}><span style={{ fontSize: 12, color: 'var(--mut-3)' }}>Select a host or guest on the map for its details.</span></div>;
}
