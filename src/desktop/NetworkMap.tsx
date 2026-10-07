import { useEffect, useMemo, useRef } from 'react';
import { useApp } from '../state.tsx';
import { CHAIN_Y, chainSegments, layoutMap, MAP } from '../map/layout.ts';
import { GUEST_HUE, STATUS_WORD, last, scaleMax, statusColor, tint, worst } from '../lib/util.ts';
import { Dot, Spark, StatusDot, ellipsis, flexCol, mono, row, useFrozen } from '../lib/ui.tsx';
import type { LeafView, Snapshot } from '../../shared/types.ts';

export const leafHue = (l: LeafView) => (l.kind === 'app' ? 25 : l.kind === 'role' ? 270 : GUEST_HUE[l.kind]);
/** A failing leaf's tier: red when down, amber when degraded. */
export const failTier = (l: LeafView): 'danger' | 'warn' | null => (l.status === 'down' ? 'danger' : l.status === 'degraded' ? 'warn' : null);
export const TIER = { danger: { c: 'var(--danger)', rule: 'var(--danger-rule)' }, warn: { c: 'var(--warn)', rule: 'var(--warn-rule)' } } as const;
export { worst };

/** the guest's web UIs in this state ('git', 'git +1'): what the leaf's red is about */
export function failingUisOf(snap: Snapshot, l: LeafView) {
  const names = l.guestId ? snap.uis.filter(u => u.owner?.kind === 'guest' && u.owner.id === l.guestId && u.status === l.status).map(u => u.name) : [];
  return names.length ? `${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ''}` : '';
}

export function NetworkMap() {
  const { snap, live, ui, toggleSelect } = useApp();
  const n = snap.network, gw = n.gateway, sw = n.switch, chain = { gateway: !!gw, switch: !!sw };
  const L = useMemo(() => layoutMap(snap.hosts, chain), [snap.hosts, chain.gateway, chain.switch]); // eslint-disable-line react-hooks/exhaustive-deps
  // the packets are SMIL, which .frozen's animation-play-state can't reach: pause them while the page is frozen
  const svg = useRef<SVGSVGElement>(null), old = useFrozen();
  useEffect(() => { if (old) svg.current?.pauseAnimations(); else svg.current?.unpauseAnimations(); }, [old]);
  const sel = ui.selection;
  const selHost = sel ? (sel.kind === 'host' ? sel.id : snap.guests.find(g => g.id === sel.id)?.host ?? null) : null;
  const wanIn = last(live.history.wanIn), wanOut = last(live.history.wanOut);
  const fw = gw ? worst(gw.status, gw.wan) : 'unknown';
  const fwSub = !gw ? '' : gw.wan === 'down' ? 'WAN down' : gw.status === 'down' ? 'not answering' : wanIn == null && wanOut == null ? '' : `↓${wanIn != null ? Math.round(wanIn) : '—'} ↑${wanOut != null ? Math.round(wanOut) : '—'} Mb/s`;
  const segs = chainSegments(chain);
  const packets: [string, number, boolean, number, boolean][] = [
    ...segs.map((d): [string, number, boolean, number, boolean] => [d, 1.1, false, 3.5, false]),
    ...L.hosts.map((h, i): [string, number, boolean, number, boolean] => [h.curve, [1.5, 2.1, 1.8, 2.6][i % 4] * (i >= MAP.PER_ROW ? 1.6 : 1), i % 2 === 1, i % 4 === 3 ? 3 : 3.5, i === 1]),
  ];
  // no packets on a path that isn't carrying anything right now
  const flowing = n.internet !== 'down' && gw?.wan !== 'down';
  const pill = { background: 'var(--pill)', border: '1px solid var(--pill-bd)', borderRadius: 99, fontSize: 11, color: 'var(--mut-1)', padding: '5px 11px' } as const;
  // where it broke: each failing leaf's host trunk, its spine down to the leaf and its tick, solid in the tier colour
  // (amber first, so red wins where two share a spine)
  const failing = L.leaves.flatMap(p => {
    const tier = failTier(p.leaf), h = L.hosts.find(x => x.host.id === p.hostId);
    if (!tier || !h) return [];
    const sx = h.left + 18;
    return [{ tier, hostId: p.hostId, curve: h.curve, d: `M${sx},${h.spineTop} L${sx},${p.y} L${p.x},${p.y}` }];
  }).sort((a, b) => (a.tier === b.tier ? 0 : a.tier === 'warn' ? -1 : 1));
  /** the '1 down' tag on a host node (amber '1 degraded' when nothing under it is down) */
  const hostFail = (id: string) => {
    const f = L.leaves.filter(p => p.hostId === id), down = f.filter(p => p.leaf.status === 'down').length, deg = f.filter(p => p.leaf.status === 'degraded').length;
    return down ? { n: down, tier: 'danger' as const, word: 'down' } : deg ? { n: deg, tier: 'warn' as const, word: 'degraded' } : null;
  };
  const failingUis = (l: LeafView) => failingUisOf(snap, l);

  return (
    <div style={flexCol(6)}>
    <div style={{ position: 'relative', width: MAP.W, height: L.H, WebkitMaskImage: 'radial-gradient(ellipse 80% 85% at 50% 45%,#000 65%,transparent 100%)', maskImage: 'radial-gradient(ellipse 80% 85% at 50% 45%,#000 65%,transparent 100%)', backgroundImage: 'radial-gradient(var(--grid-dot) 1px,transparent 1px)', backgroundSize: '22px 22px', overflow: 'hidden' }}>
      <svg ref={svg} style={{ position: 'absolute', inset: 0 }} width={MAP.W} height={L.H} viewBox={`0 0 ${MAP.W} ${L.H}`} aria-hidden="true">
        <path d={L.trunkD} stroke="var(--line)" strokeWidth="2" fill="none" />
        {n.tunnelName && <path d="M536,28 L690,28" stroke={n.internet === 'down' ? 'var(--danger)' : 'var(--pub)'} strokeWidth="1.5" fill="none" strokeDasharray="4 4" opacity=".7" />}
        {gw && n.segments.length > 0 && <path d="M381,106 L300,106" stroke="var(--dash)" strokeWidth="1.5" fill="none" strokeDasharray="3 4" />}
        {sw && n.aps.length > 0 && <path d={`M591,200 L${n.aps.length > 1 ? 780 : 640},200`} stroke="var(--line)" strokeWidth="1.5" fill="none" />}
        <path d={L.leafD} stroke="var(--line-2)" strokeWidth="1" fill="none" />
        {selHost && L.spines[selHost] && <path className="flow" d={L.spines[selHost]} stroke="var(--accent)" strokeWidth="1.5" fill="none" strokeDasharray="3 5" />}
        {failing.map((f, i) => <g key={`fail-${i}`} stroke={TIER[f.tier].c} fill="none"><path d={f.curve} strokeWidth="2" /><path d={f.d} strokeWidth="1.5" /></g>)}
        {packets.filter((_, i) => flowing || i >= segs.length).map(([p, dur, alt, r, rev], i) => (
          <circle key={i} className="packet" r={r} fill={alt ? 'var(--accent-2)' : 'var(--accent)'}>
            <animateMotion dur={`${dur}s`} repeatCount="indefinite" path={p} {...(rev ? { keyPoints: '1;0', keyTimes: '0;1', calcMode: 'linear' } : {})} />
          </circle>
        ))}
      </svg>
      <div style={{ position: 'absolute', left: 16, top: 14, fontSize: 11, letterSpacing: '.14em', fontWeight: 700, color: 'var(--mut-3)' }}>{n.subnet}</div>
      <div title={`Reachability from outside: ${STATUS_WORD[n.internet]}`} style={row(7, { position: 'absolute', left: 436, top: 14, width: 100, boxSizing: 'border-box', justifyContent: 'center', padding: '6px 0', borderRadius: 99, background: 'var(--inset)', border: `1px solid ${n.internet === 'down' ? 'var(--danger-rule)' : 'var(--rule)'}`, fontSize: 12, fontWeight: 600, color: 'var(--mut-1)' })}>
        <StatusDot status={n.internet} size={6} />Internet
      </div>
      {/* the tunnel's pill (network.tunnel); with its metrics (module edge) it also counts the tunnel's connections, and a weak tunnel turns its dot amber */}
      {n.tunnelName && <div title={`${n.tunnelName} · public checks: ${STATUS_WORD[n.internet]}${n.tunnel ? ` · ${n.tunnel.text} connections` : ''}`} style={row(8, { position: 'absolute', left: 690, top: 12, padding: '6px 12px', borderRadius: 99, background: 'var(--pub-bg)', border: '1px solid var(--pub-bd)', fontSize: 12, fontWeight: 600, color: 'var(--pub-fg)' })}>
        <Dot size={7} color={n.internet !== 'up' ? statusColor(n.internet) : n.tunnel?.status === 'degraded' ? 'var(--warn)' : 'var(--pub)'} />{n.tunnelName}{n.tunnel ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}>{n.tunnel.text}</span> : null} · {n.publicCount} public
      </div>}
      {gw && <div style={row(10, { position: 'absolute', left: 381, top: CHAIN_Y.gateway[0], width: 210, boxSizing: 'border-box', padding: '10px 14px', borderRadius: 14, background: 'var(--surface)', border: `1px solid ${fw === 'down' ? 'var(--danger-rule)' : 'var(--line)'}`, boxShadow: 'var(--fw-glow)' })}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--text)', color: 'var(--on-accent)', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, flex: 'none' }}>{snap.ui.gatewayMonogram ?? 'GW'}</div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 13, fontWeight: 700, ...ellipsis }}>{gw.name}</span>
          <span style={mono(10, fw === 'down' ? 'var(--danger)' : 'var(--mut-3)', ellipsis)}>{gw.ipShort}{fwSub ? ` · ${fwSub}` : ''}</span>
        </div>
        <span title={`${gw.name} ${STATUS_WORD[gw.status]} · WAN ${STATUS_WORD[gw.wan]}`} style={{ display: 'flex' }}><Dot size={8} color={statusColor(fw)} pulse={fw === 'up' ? 'ok' : fw === 'down' ? 'danger' : undefined} /></span>
      </div>}
      {/* other networks behind the gateway, stacked to its left */}
      {n.segments.map((g, i) => (
        <div key={g.id} title={`${g.label} · ${STATUS_WORD[g.status]}`} style={row(6, { position: 'absolute', right: MAP.W - 300, top: 92 + i * 30, maxWidth: 280, boxSizing: 'border-box', ...pill, border: '1px dashed var(--dash)', color: 'var(--mut-2)', ...ellipsis })}>
          <StatusDot status={g.status} size={5} />{g.label}
        </div>
      ))}
      {sw && <div style={row(10, { position: 'absolute', left: 381, top: CHAIN_Y.switch[0], width: 210, boxSizing: 'border-box', padding: '10px 14px', borderRadius: 14, background: 'var(--surface)', border: `1px solid ${sw.status === 'down' ? 'var(--danger-rule)' : 'var(--rule)'}` })}>
        <div style={{ position: 'relative', width: 30, height: 30, borderRadius: 8, ...tint(230), display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, flex: 'none' }}>
          SW<StatusDot status={sw.status} size={9} style={{ position: 'absolute', right: -3, top: -3, boxSizing: 'content-box', border: '2px solid var(--surface)' }} />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', ...ellipsis }}>{sw.name}</span>
          <span style={mono(10, 'var(--mut-3)', { whiteSpace: 'nowrap' })}>{sw.ipShort}{sw.mirror ? ` · mirror ${sw.mirror}` : ''}</span>
        </div>
        {sw.eol && <span title={`Firmware ${sw.firmware ?? ''} is end of life`} style={{ padding: '2px 6px', borderRadius: 5, background: 'var(--warn-bg)', color: 'var(--warn)', fontSize: 10, fontWeight: 700 }}>EOL</span>}
      </div>}
      {/* access points on switch ports, two to a line right of the switch */}
      {sw && n.aps.map((a, i) => (
        <div key={`${a.name}-${i}`} title={`${a.name} · ${STATUS_WORD[a.status]}`} style={row(6, { position: 'absolute', left: 640 + (i % 2) * 140, top: 188 + Math.floor(i / 2) * 30, maxWidth: 132, boxSizing: 'border-box', ...pill, ...ellipsis })}>
          <StatusDot status={a.status} size={5} />{a.name} · {a.port}
        </div>
      ))}

      {L.hosts.map(({ host: h, left, top }) => {
        const on = sel?.kind === 'host' && sel.id === h.id, hf = hostFail(h.id);
        const series = live.history.cpu[h.id] ?? [], cpu = last(series), hasCpu = series.some(v => v != null);
        return (
          <button key={h.id} className="h-node" onClick={() => toggleSelect({ kind: 'host', id: h.id })} aria-pressed={on} aria-label={`${h.name} details`} title={`${h.name} · ${STATUS_WORD[h.status]}`}
            style={{ position: 'absolute', left, top, width: MAP.HOST_W, boxSizing: 'border-box', padding: '11px 13px', borderRadius: 16, background: on ? 'var(--surface-sel)' : 'var(--surface)', border: `1px solid ${on ? 'var(--accent)' : h.status === 'down' ? 'var(--danger-rule)' : hf ? TIER[hf.tier].rule : 'var(--rule)'}`, boxShadow: on ? 'var(--select-glow)' : 'none', display: 'flex', flexDirection: 'column', gap: 7, transition: 'all .2s' }}>
            {hf && <span style={{ position: 'absolute', right: 10, top: -10, padding: '1px 7px', borderRadius: 99, background: 'var(--bg)', border: `1px solid ${TIER[hf.tier].rule}`, color: TIER[hf.tier].c, fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' }}>{hf.n} {hf.word}</span>}
            <div style={row(9)}>
              <div style={{ width: 28, height: 28, borderRadius: 8, ...tint(h.hue), display: 'grid', placeItems: 'center', fontSize: 10, fontWeight: 800, flex: 'none' }}>{h.mono}</div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{h.name}</span>
                <span style={mono(10, 'var(--mut-3)', { whiteSpace: 'nowrap' })}>{h.ipS}</span>
              </div>
              <Dot size={8} color={statusColor(h.status)} pulse={h.status === 'up' ? 'ok' : h.status === 'down' ? 'danger' : undefined} />
            </div>
            <div style={row(8)}>
              {hasCpu
                ? <><Spark data={series} max={scaleMax(series, h.cpuScale)} height={22} width="auto" style={{ flex: 1 }} /><span style={mono(12, cpu == null ? 'var(--mut-3)' : undefined)}>{cpu != null ? `${Math.round(cpu)}%` : '—'}</span></>
                : <span style={mono(10, 'var(--mut-3)', { height: 22, lineHeight: '22px' })}>no CPU feed</span>}
            </div>
          </button>
        );
      })}

      {L.leaves.map(({ leaf: l, hostId, key, x, y, maxW, compact }) => {
        const on = !!sel && !!l.guestId && sel.id === l.guestId, tier = failTier(l), why = tier ? failingUis(l) : '';
        // the selection fade never hides a failing leaf
        const dim = !!selHost && selHost !== hostId && !tier;
        const style = row(6, {
          position: 'absolute', left: x, top: y, transform: 'translate(0,-50%)', maxWidth: maxW ?? undefined, boxSizing: 'border-box', opacity: dim ? 0.3 : 1,
          padding: compact ? '2px 8px 2px 3px' : '4px 8px 4px 4px', borderRadius: 99, background: on ? 'var(--surface-sel)' : 'var(--pill)',
          border: `1px solid ${on ? 'var(--accent)' : tier ? TIER[tier].rule : l.public ? 'var(--pub-bd)' : 'var(--pill-bd)'}`, whiteSpace: 'nowrap', color: 'inherit',
          // the selection fade and state colours ease; position never does, so a re-layout (7 → 8 leaves switches to the
          // compact pitch) moves pills at once instead of sliding them across each other under the canvas mask
          transition: 'opacity var(--sel-fade), background-color var(--sel-fade), border-color var(--sel-fade)',
        });
        const inner = <>
          <span style={{ minWidth: compact ? 20 : 22, height: compact ? 16 : 18, padding: '0 4px', boxSizing: 'border-box', borderRadius: l.kind === 'vm' ? 3 : 9, ...tint(leafHue(l)), display: 'grid', placeItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 9, fontWeight: 600, flex: 'none' }}>{l.tag}</span>
          <span style={{ fontSize: compact ? 10.5 : 11, fontWeight: 600, color: 'var(--text-2)', minWidth: 0, ...ellipsis }}>{l.name}</span>
          {l.count && <span style={mono(10, 'var(--mut-3)', { flex: 'none' })}>{l.count}</span>}
          <StatusDot status={l.status} monitored={l.monitored !== false} size={5} />
          {why && <span style={{ fontSize: 10, fontWeight: 700, color: TIER[tier!].c, flex: 'none' }}>{why}</span>}
        </>;
        // an app with a URL opens it; guests and the rest select on the map
        if (!l.guestId && l.url) return (
          <a key={key} href={l.url} target="_blank" rel="noopener noreferrer" title={`${l.name} · ${l.url}`} aria-label={`Open ${l.name}`} className="h-node" style={style}>{inner}</a>
        );
        const target = l.guestId ? { kind: 'guest' as const, id: l.guestId } : { kind: 'host' as const, id: hostId };
        return <button key={key} onClick={() => toggleSelect(target)} aria-label={l.name} title={`${l.name} · ${STATUS_WORD[l.status]}`} className="h-node" style={style}>{inner}</button>;
      })}

    </div>
    {/* outside the canvas: its radial fade would wash the legend out */}
    <div style={row(14, { paddingLeft: 16, fontSize: 11, whiteSpace: 'nowrap', color: 'var(--mut-3)' })}>
      <span style={row(5)}><span style={{ width: 14, height: 10, borderRadius: 2, ...tint(GUEST_HUE.vm) }} />VM</span>
      <span style={row(5)}><span style={{ width: 14, height: 10, borderRadius: 5, ...tint(GUEST_HUE.lxc) }} />LXC · container count</span>
      <span style={row(5)}><span style={{ width: 10, height: 10, borderRadius: '50%', border: '1px solid var(--pub)' }} />Public{n.tunnelName ? ` via ${n.tunnelName}` : ''}</span>
      <span style={row(5)}><StatusDot status="unknown" monitored={false} size={7} />No monitor</span>
    </div>
    </div>
  );
}
