// Review 3d: the failure path drawn top to bottom. Classic Overview draws it under Needs attention (26px rows); Phase 5
// draws it in the incident band's "Where it breaks" (36px rows, a halo on the failing dot).
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { STATUS_WORD, statusColor } from '../lib/util.ts';
import { ellipsis, mono, row } from '../lib/ui.tsx';
import { failPath, type Hop, type Rich } from '../lib/incident.ts';
import type { Attention, Snapshot } from '../../shared/types.ts';

/** The path to the first danger item's subject while it's down. When that item goes because its subject answers again
 *  (not because a source went quiet), the path replays in green for BACK_MS. rich: the band's hop lines. */
export const BACK_MS = 6_000;
export function useTrace(snap: Snapshot, main: Attention[], wanIn: number | null, rich?: Rich) {
  const first = main.find(a => a.severity === 'danger');
  const hops = first ? failPath(snap, first.id, wanIn, rich) : null, downId = first && hops ? first.id : null;
  const prev = useRef<string | null>(null), [back, setBack] = useState<string | null>(null);
  useEffect(() => {
    const was = prev.current; prev.current = downId;
    if (downId) { setBack(null); return; }
    const now = was ? failPath(snap, was, null) : null; // the snapshot that cleared it
    if (was && now && now[now.length - 1].status === 'up') setBack(was);
  }, [downId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!back) return; const t = setTimeout(() => setBack(null), BACK_MS); return () => clearTimeout(t); }, [back]);
  const backHops = back ? failPath(snap, back, wanIn, rich) : null;
  return { down: downId && hops ? { id: downId, hops } : null, back: back && backHops ? { id: back, hops: backHops } : null };
}

/** traces already played on this page (id and state): a remount (deselecting a host brings classic's list back, a tab
 *  switch the band) shows the drawn path instead of playing it again */
const played = new Set<string>();
/** A trace plays once per id and state, so a new outage of the same service (or a second recovery) must play again:
 *  forget the drawn path of every item that is no longer red, and the green replay of every one that is. Called from
 *  the always-mounted desktop shell on each snapshot (keying on `since` instead would replay the simulated incident,
 *  whose start is recomputed every rebuild). */
export function rearm(items: Attention[]) {
  const red = new Set(items.filter(a => a.severity === 'danger').map(a => a.id));
  for (const k of [...played]) {
    const [id, st] = [k.slice(0, k.lastIndexOf(':')), k.slice(k.lastIndexOf(':') + 1)];
    if (st === 'down' ? !red.has(id) : red.has(id)) played.delete(k);
  }
}
const HOP_STEP = 0.18;
/** The path drawn top to bottom, .18 s a hop; each hop's dot fills as the trace passes (its own status colour), the last
 *  segment and dot turn red with a ring bursting twice from the dot. ok: the same in green (recovered). Plays once per
 *  id and state and never loops. rowH / gap / margin: 26 / 12 / classic's indent by default, 36 / 14 / 0 in the band.
 *  halo: the band's 4px ring round the failing dot (1c), fading in as the trace reaches it. */
export function FailTrace({ id, hops, ok, rowH = 26, gap = 12, margin = '0 0 8px 17px', halo = false }:
  { id: string; hops: Hop[]; ok?: boolean; rowH?: number; gap?: number; margin?: string; halo?: boolean }) {
  const k = `${id}:${ok ? 'up' : 'down'}`, [play] = useState(() => !played.has(k));
  useEffect(() => { played.add(k); }, [k]);
  const anim = (a: string): CSSProperties => (play ? { animation: a } : {});
  const end = hops.length - 1, tail = ok ? 'var(--ok)' : 'var(--danger)';
  const line: CSSProperties = { position: 'absolute', left: 3.25, top: rowH / 2, width: 1.5, transformOrigin: 'top' };
  return (
    <div role="list" aria-label={`Path to ${hops[end].name}`} style={{ position: 'relative', height: hops.length * rowH, margin }}>
      <div style={{ ...line, height: end * rowH, background: 'var(--line)' }} />
      {end > 1 && <div data-motion="" style={{ ...line, height: (end - 1) * rowH, background: ok ? 'var(--ok)' : 'var(--accent)', ...anim(`cc-grow ${((end - 1) * HOP_STEP).toFixed(2)}s linear both`) }} />}
      <div data-motion="" style={{ ...line, top: rowH / 2 + (end - 1) * rowH, height: rowH, background: tail, ...anim(`cc-grow .2s linear ${((end - 1) * HOP_STEP).toFixed(2)}s both`) }} />
      {hops.map((hop, i) => {
        const last = i === end, to = last ? tail : hop.status === 'up' ? 'var(--ok)' : statusColor(hop.status), bad = last && !ok;
        return (
          <div key={i} role="listitem" title={last ? undefined : STATUS_WORD[hop.status]} style={row(gap, { position: 'absolute', left: 0, right: 0, top: i * rowH, height: rowH })}>
            <span style={{ position: 'relative', width: 8, height: 8, flex: 'none' }}>
              {last && halo && <span data-motion="" style={{ position: 'absolute', inset: 0, borderRadius: '50%', boxShadow: `0 0 0 4px ${ok ? 'var(--ok-a16)' : 'var(--danger-a18)'}`, ...anim(`cc-fade .2s ease-out ${(i * HOP_STEP).toFixed(2)}s both`) }} />}
              <span data-motion="" style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: to, '--to': to, ...anim(`cc-dot .2s ease-out ${(i * HOP_STEP).toFixed(2)}s both`) } as CSSProperties} />
              {last && play && <span data-motion="" style={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${tail}`, opacity: 0, animation: `cc-burst 1.1s ease-out ${(i * HOP_STEP + 0.1).toFixed(2)}s 2` }} />}
            </span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: last ? 700 : 600, color: bad ? 'var(--danger)' : 'var(--text)', ...ellipsis }}>{hop.name}</span>
            <span style={mono(11, bad ? 'var(--danger-sub)' : 'var(--mut-3)', { flex: 'none' })}>{hop.meta}</span>
          </div>
        );
      })}
    </div>
  );
}
