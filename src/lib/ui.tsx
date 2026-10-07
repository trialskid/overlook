// Small shared atoms. Every colour comes from tokens.css.
import type { CSSProperties, ReactNode } from 'react';
import { useApp } from '../state.tsx';
import { frozen, linkState, useNow } from './live.ts';
import { cellColor, clockSec, paths, statusColor, tint, whyMissing } from './util.ts';
import type { Status } from '../../shared/types.ts';

export const eyebrow = (color = 'var(--mut-3)', size = 11): CSSProperties => ({ fontSize: size, letterSpacing: '.14em', fontWeight: 700, color, textTransform: 'uppercase' });
export const mono = (size: number, color?: string, extra: CSSProperties = {}): CSSProperties => ({ fontFamily: 'var(--font-mono)', fontSize: size, color, ...extra });
export const flexCol = (gap = 0, extra: CSSProperties = {}): CSSProperties => ({ display: 'flex', flexDirection: 'column', gap, ...extra });
export const row = (gap = 0, extra: CSSProperties = {}): CSSProperties => ({ display: 'flex', alignItems: 'center', gap, ...extra });
export const ellipsis: CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
/** visually hidden, still read out (live regions, announcements) */
export const SR: CSSProperties = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };
/** A section under a 1px top rule. No boxes (design principle). */
export const ruled = (pad: string, color = 'var(--rule)', extra: CSSProperties = {}): CSSProperties => ({ padding: pad, borderTop: `1px solid ${color}`, ...extra });

/** A section's 17/700 title with an optional sub-line and something at its right. sm: the anchor's scroll margin
 *  (Health's clears its sticky index). */
export const SectionTitle = ({ title, sub, right, pad = 6, id, sm = 20 }: { title: string; sub?: string; right?: ReactNode; pad?: number; id?: string; sm?: number }) => (
  <div id={id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, paddingBottom: pad, scrollMarginTop: sm }}>
    <span style={{ fontSize: 17, fontWeight: 700, flex: 'none' }}>{title}</span>
    {sub && <span style={{ fontSize: 13, color: 'var(--mut-3)', minWidth: 0, ...ellipsis }} title={sub}>{sub}</span>}
    {right}
  </div>
);

export function Dot({ color, size = 7, pulse, style }: { color: string; size?: number; pulse?: 'ok' | 'ok2' | 'danger'; style?: CSSProperties }) {
  return <span className={pulse === 'ok' ? 'pulse' : pulse === 'ok2' ? 'pulse-2' : pulse === 'danger' ? 'pulse-danger' : undefined}
    style={{ width: size, height: size, borderRadius: '50%', background: color, flex: 'none', display: 'inline-block', ...style }} />;
}
/** Status dot with a text alternative. Unmonitored = hollow grey ring titled 'no monitor'. `color` overrides the
 *  status colour (a job's severity tier). */
export function StatusDot({ status, monitored = true, size = 7, color, style }: { status: Status; monitored?: boolean; size?: number; color?: string; style?: CSSProperties }) {
  const label = monitored ? status : 'no monitor';
  return monitored
    ? <span role="img" aria-label={label} title={label} style={{ width: size, height: size, borderRadius: '50%', background: color ?? statusColor(status), flex: 'none', display: 'inline-block', ...style }} />
    : <span role="img" aria-label={label} title={label} style={{ width: size, height: size, boxSizing: 'border-box', borderRadius: '50%', border: '1.5px solid var(--mut-5)', flex: 'none', display: 'inline-block', ...style }} />;
}

export function Tile({ mono: m, hue, size = 30, radius = 8, fontSize = 11, style, children }: { mono: string; hue: number; size?: number; radius?: number; fontSize?: number; style?: CSSProperties; children?: ReactNode }) {
  return <div style={{ position: 'relative', width: size, height: size, borderRadius: radius, ...tint(hue), display: 'grid', placeItems: 'center', fontWeight: 800, fontSize, flex: 'none', ...style }}>{m}{children}</div>;
}

export const Badge = ({ kind, children }: { kind: 'pub' | 'eol'; children: ReactNode }) => kind === 'pub'
  ? <span style={{ padding: '1px 6px', borderRadius: 5, border: '1px solid var(--pub-bd)', color: 'var(--pub-fg)', fontSize: 11, fontWeight: 700 }}>{children}</span>
  : <span style={{ padding: '2px 6px', borderRadius: 5, background: 'var(--warn-bg)', color: 'var(--warn)', fontSize: 11, fontWeight: 700 }}>{children}</span>;
/** Small muted tag ('undocumented', 'manual', 'no monitor'). */
export const Tag = ({ children, color = 'var(--mut-3)' }: { children: ReactNode; color?: string }) =>
  <span style={{ padding: '1px 6px', borderRadius: 5, border: '1px solid var(--pill-bd)', color, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{children}</span>;

/** border: a public UI's --pub-bd (the incident band's 'Also on' chips) */
export const Chip = ({ children, filled = true, size = 11, pad = '4px 9px', border = 'var(--pill-bd)', style }: { children: ReactNode; filled?: boolean; size?: number; pad?: string; border?: string; style?: CSSProperties }) =>
  <span style={{ padding: pad, borderRadius: 99, background: filled ? 'var(--inset)' : undefined, border: `1px solid ${border}`, fontSize: size, color: filled ? 'var(--text-2)' : 'var(--mut-1)', ...style }}>{children}</span>;

/** A monitor's 48 half-hour cells over the last 24 h (Health's uptime rows, the incident band's evidence). */
export const UptimeCells = ({ cells, height = 14, radius = 2, title, style }: { cells: Status[]; height?: number; radius?: number; title?: string; style?: CSSProperties }) =>
  <div title={title} role={title ? 'img' : undefined} aria-label={title} style={{ display: 'flex', gap: 2, height, ...style }}>{cells.map((c, j) => <span key={j} style={{ flex: 1, borderRadius: radius, background: cellColor(c) }} />)}</div>;

/** A count that opens what explains it (review finding 12): link-styled, keyboard-focusable. The hover tint bleeds
 *  4px/8px past the content through a negative margin, so values and layout don't move. */
export const CountLink = ({ onClick, label, title, gap = 0, children }: { onClick: () => void; label: string; title?: string; gap?: number; children: ReactNode }) => (
  <button type="button" className="h-count" onClick={onClick} aria-label={label} title={title}
    style={{ display: 'flex', flexDirection: 'column', gap, width: '100%', margin: '-4px -8px', padding: '4px 8px', borderRadius: 8, textAlign: 'left', minWidth: 0 }}>{children}</button>
);

/** An external link that opens in a new tab, with a trailing ↗. */
export const Ext = ({ href, children, style, label, arrow = true }: { href: string; children: ReactNode; style?: CSSProperties; label?: string; arrow?: boolean }) =>
  <a className="h-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={label} style={{ color: 'var(--accent)', ...style }}>{children}{arrow && ' ↗'}</a>;
/** Wraps a title in a link to its app when there is one, plain text otherwise. */
export const MaybeLink = ({ href, children, style, label }: { href: string | null | undefined; children: ReactNode; style?: CSSProperties; label?: string }) => href
  ? <a className="h-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title={href} style={{ color: 'inherit', ...style }}>{children}</a>
  : <span style={style}>{children}</span>;

export function Spark({ data, w = 300, h = 52, max, height, width = '100%', fill = 'var(--accent-a14)', stroke = 'var(--accent)', sw = 1.5, style }:
  { data: (number | null)[]; w?: number; h?: number; max: number; height: number; width?: number | string; fill?: string | null; stroke?: string; sw?: number; style?: CSSProperties }) {
  const p = paths(data, w, h, max);
  return (
    <svg width={width === 'auto' ? undefined : width} height={height} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={style} aria-hidden="true">
      {fill && <path d={p.area} fill={fill} />}
      <path d={p.line} fill="none" stroke={stroke} strokeWidth={sw} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A 6px fill bar (resources, storage). pct null = no data. */
export function Bar({ pct, color = 'var(--accent)', height = 6 }: { pct: number | null; color?: string; height?: number }) {
  return (
    <div style={{ height, borderRadius: height / 2, background: 'var(--rule-3)', overflow: 'hidden' }}>
      {pct != null && <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%', borderRadius: height / 2, background: color }} />}
    </div>
  );
}

export const SearchIcon = ({ size = 14, stroke = 'currentColor' }: { size?: number; stroke?: string }) =>
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>;

/** '<what> not connected · needs …' or '<what> not answering · last ok 4 min ago', from Snapshot.sources when src is given. */
export function NotConnected({ what, src }: { what: string; src?: string }) {
  const { snap } = useApp();
  return <span style={{ fontSize: 12, color: 'var(--mut-3)' }}>{src ? whyMissing(snap, src, what) : `${what} not connected`}</span>;
}

/** True while the page shows old data: no ticks for 5 s (OFFLINE) or the server stopped rebuilding (STALE). */
export function useFrozen() {
  const { live } = useApp();
  return frozen(linkState(live, useNow().getTime()));
}
/** Full-width line over a frozen page: since when nothing new has arrived. The content below it is dimmed and greyed
 *  (class 'frozen'), so no green dot or number reads as current. */
export function FrozenBanner({ style }: { style?: CSSProperties }) {
  const { live } = useApp();
  const st = linkState(live, useNow().getTime());
  if (!frozen(st)) return null;
  const since = st === 'offline' ? live.lastTick : live.lastSnapshotAt;
  const when = since ? clockSec(new Date(since)) : '—';
  const c = st === 'offline' ? 'var(--danger)' : 'var(--warn)';
  return (
    <div role="alert" style={{ padding: '10px 14px', borderTop: `2px solid ${c}`, color: 'var(--text-2)', fontSize: 13, lineHeight: 1.4, ...style }}>
      <span style={{ color: c, fontWeight: 700 }}>{st === 'offline' ? 'No connection to Command Center' : 'Command Center stopped refreshing'}</span>
      {` · nothing new since ${when}; everything below is from then${st === 'offline' ? ' · reconnecting…' : ''}`}
    </div>
  );
}
