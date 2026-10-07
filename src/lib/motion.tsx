// Review Phase 4 (motion, 3a-3f): the pieces more than one view uses. Every one moves only while its data does, pauses
// under the frozen banner (.frozen [data-motion]) and stops for reduced motion (app.css); keys stay stable across ticks.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '../state.tsx';
import { toServer } from './live.ts';
import { ellipsis, useFrozen } from './ui.tsx';
import { agoText } from './util.ts';
import type { SourceView } from '../../shared/types.ts';

const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** 3e: a count whose digits roll when it changes. Each digit is a 0-9 column in a 1.1em window, keyed by its place from
 *  the right so only the digits that change move; anything else ('/', ',', '—', units) is plain text. The window sits
 *  where the line's own text would (.11em down in JetBrains Mono's 1.32em line), so nothing around it moves. */
export function Roll({ v }: { v: ReactNode }) {
  if (typeof v !== 'string' && typeof v !== 'number') return <>{v}</>;
  const s = String(v), chars = [...s];
  return (
    <span style={{ position: 'relative' }}>
      <span style={SR_ONLY}>{s}</span>
      <span aria-hidden="true" style={{ display: 'inline-flex', verticalAlign: 'top', marginTop: '.11em', height: '1.1em', lineHeight: 1.1 }}>
        {chars.map((ch, i) => {
          const place = chars.length - i;
          return /\d/.test(ch)
            ? <span key={`d${place}`} style={{ height: '1.1em', overflow: 'hidden' }}>
              <span data-motion="" style={{ display: 'flex', flexDirection: 'column', transform: `translateY(${-Number(ch) * 1.1}em)`, transition: 'transform .7s cubic-bezier(.2,.8,.2,1)' }}>
                {DIGITS.map(d => <span key={d} style={{ height: '1.1em' }}>{d}</span>)}
              </span>
            </span>
            : <span key={`c${place}`} style={{ whiteSpace: 'pre' }}>{ch}</span>;
        })}
      </span>
    </span>
  );
}

/** 3e: a 2px warm glint under a count each time it grows (a new Plex item); none on the first value or after a gap */
export function Glint({ n }: { n: number | null | undefined }) {
  const prev = useRef(n), [k, setK] = useState(0);
  useEffect(() => { if (n != null && prev.current != null && n > prev.current) setK(x => x + 1); prev.current = n; }, [n]);
  return k > 0 ? <span key={k} aria-hidden="true" data-motion="" style={{ position: 'absolute', left: 0, right: 0, bottom: -3, height: 2, borderRadius: 1, background: 'var(--warn)', opacity: 0, animation: 'cc-glint 1.6s ease-out' }} /> : null;
}

/** 3c: one trace width is the last 2 minutes on every row (BEAT_W px on desktop), so rows share the time axis. The
 *  right edge runs BEAT_LAG behind the tick: the page hears of a poll with the next snapshot (up to 10 s later), and
 *  the lag lets its blip enter from the right instead of appearing part-way in. */
const BEAT_W = 280, BEAT_SPAN = 120_000, BEAT_LAG = 11_000, BEAT_K = BEAT_W / BEAT_SPAN;
const REDUCED = '(prefers-reduced-motion: reduce)';
export function useReducedMotion() {
  const [rm, setRm] = useState(() => typeof matchMedia === 'function' && matchMedia(REDUCED).matches);
  useEffect(() => { const q = matchMedia(REDUCED), f = () => setRm(q.matches); q.addEventListener('change', f); return () => q.removeEventListener('change', f); }, []);
  return rm;
}
/** The traces' clock: the server time of the latest tick, held while the page is frozen (so nothing scrolls then).
 *  0 for reduced motion: every trace is then a still line, without blips (a still picture of them would go out of
 *  date, and nothing old is shown as current). */
export function useBeatClock() {
  const { live } = useApp();
  const old = useFrozen(), rm = useReducedMotion(), held = useRef(0);
  if (!old && live.lastTick) held.current = toServer(live.lastTick) - BEAT_LAG;
  return rm ? 0 : held.current;
}
/** An answering source that polls less often than one trace width (2 min) would show no blip most of the time: it
 *  gets its interval as text instead, 'every 5 min' (the age column beside it says when it last answered). null for
 *  the rest. */
export function slowPoll(s: SourceView): string | null {
  if ((s.conn !== 'ok' && s.conn !== 'mock') || s.everySec * 1000 <= BEAT_SPAN) return null;
  return `every ${agoText(s.everySec)}`;
}
const BEAT_LINE: Partial<Record<SourceView['conn'], string>> = { stale: 'var(--warn)', error: 'var(--danger)', 'not-connected': 'var(--mut-5)' };
/** A source's heartbeat: answering, a flat --ok line with one ECG blip per answered poll (Live.beats), scrolled left by
 *  the 1/s tick (t 0, before the first tick or for reduced motion: the line alone, still), or slowPoll's text when it
 *  polls less often than the trace spans; stale or error, a still dashed line in its pill's colour; not connected,
 *  dashed --mut-5. fill: the phone's full-width line (2 minutes stretched to its width) instead of desktop's BEAT_W px
 *  anchored right. */
export function Heartbeat({ s, t, fill }: { s: SourceView; t: number; fill?: boolean }) {
  const { live } = useApp();
  const anchor = useRef(0);
  // the path is drawn in time from `anchor` and the group slides with the clock; re-anchored now and then (a remount
  // via its key, so the jump isn't animated) so the numbers stay small on a page left open for days
  if (!anchor.current || t - anchor.current > 600_000 || t < anchor.current) anchor.current = t;
  const box: CSSProperties = { position: 'relative', height: 24, minWidth: 48, ...(fill ? {} : { flex: '1 1 0' }) };
  const still = BEAT_LINE[s.conn], slow = slowPoll(s);
  if (slow) return <div title={`polled every ${s.everySec} s`} style={{ ...box, display: 'flex', alignItems: 'center', fontSize: 11, color: 'var(--mut-3)' }}><span style={ellipsis}>{slow}</span></div>;
  if (still || !t) return <div aria-hidden="true" style={box}><div style={{ position: 'absolute', left: 0, right: 0, top: 11, borderTop: `1.5px ${still ? 'dashed' : 'solid'} ${still ?? 'var(--ok)'}` }} /></div>;
  const a = anchor.current, x = (at: number) => (at - a) * BEAT_K + BEAT_W;
  let d = `M${x(t - BEAT_SPAN - 5_000).toFixed(1)},12`;
  for (const b of live.beats[s.name] ?? []) {
    if (b < t - BEAT_SPAN - 5_000 || b > t + 20_000) continue;
    const c = x(b);
    d += ` L${(c - 6).toFixed(1)},12 L${(c - 3).toFixed(1)},4 L${c.toFixed(1)},20 L${(c + 3).toFixed(1)},9 L${(c + 5).toFixed(1)},12`;
  }
  d += ` L${x(t + 25_000).toFixed(1)},12`;
  return (
    <div aria-hidden="true" style={{ ...box, overflow: 'hidden', WebkitMaskImage: 'linear-gradient(90deg,transparent,#000 22%)', maskImage: 'linear-gradient(90deg,transparent,#000 22%)' }}>
      <svg width={fill ? '100%' : BEAT_W} height="24" viewBox={`0 0 ${BEAT_W} 24`} preserveAspectRatio="none" style={{ position: 'absolute', right: 0, top: 0, overflow: 'visible' }}>
        <g key={a} data-motion="" style={{ transform: `translateX(${(-(t - a) * BEAT_K).toFixed(2)}px)`, transition: 'transform 1s linear' }}>
          <path d={d} fill="none" stroke="var(--ok)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </g>
      </svg>
    </div>
  );
}
