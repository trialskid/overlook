// Plans H5-H13 on the page (Snapshot.health.ops): the server UPS, Unraid disk health, the edge (tunnels, Caddy, ntfy),
// apt updates. Shared by Health (desktop and phone), Overview and Home. No cards: rows under rules, like
// every other list. An area whose metrics don't exist yet shows as one quiet 'not monitored yet' chip, never an error.
import type { CSSProperties, ReactNode } from 'react';
import { ago } from '../lib/util.ts';
import { Bar, Dot, ellipsis, eyebrow, flexCol, mono, row } from '../lib/ui.tsx';
import type { DisksView, OpsLine, OpsTone, OpsView, PowerView, UpdatesView } from '../../shared/types.ts';

const RULE3 = '1px solid var(--rule-3)';
/** dot colour per tone: grey for no data */
export const opsDot = (t: OpsTone) => (t === 'danger' ? 'var(--danger)' : t === 'warn' ? 'var(--warn)' : t === 'ok' ? 'var(--ok)' : t === 'info' ? 'var(--info)' : 'var(--mut-5)');
/** value text: its tier's colour when something's wrong, muted otherwise */
export const opsValue = (t: OpsTone) => (t === 'danger' ? 'var(--danger)' : t === 'warn' ? 'var(--warn)' : t === 'info' ? 'var(--info)' : t === 'ok' ? 'var(--mut-1)' : 'var(--mut-3)');
const opsSub = (t: OpsTone) => (t === 'danger' ? 'var(--danger-sub)' : t === 'warn' ? 'var(--warn-sub)' : 'var(--mut-3)');

/** The areas a column stands for (the Edge column covers H12). */
export const OPS_COLS = { power: ['power'], disks: ['disks'], edge: ['edge'] } as const;
export const opsMissing = (ops: OpsView | undefined, ids: readonly string[]) => (ops?.missing ?? []).filter(m => ids.includes(m.id));

/** One row: dot, name over a sub-line, value right. `tall`: the phone's 44px+ rows. */
export function OpsRow({ l, tall, style }: { l: OpsLine; tall?: boolean; style?: CSSProperties }) {
  return (
    <div data-ops={l.id} title={l.title} style={row(12, { minHeight: tall ? 52 : 46, padding: '4px 0', boxSizing: 'border-box', borderBottom: RULE3, ...style })}>
      <Dot size={7} color={opsDot(l.tone)} />
      <div style={{ flex: 1, minWidth: 0, ...flexCol(1) }}>
        <span style={{ fontSize: tall ? 14 : 13, fontWeight: 600, ...ellipsis }}>{l.name}</span>
        {/* the phone has no hover: its sub-line may take two lines */}
        <span style={{ fontSize: tall ? 11.5 : 12, color: opsSub(l.tone), ...(tall ? { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.35 } : ellipsis) }} title={l.sub}>{l.sub}</span>
      </div>
      <span style={mono(12, opsValue(l.tone), { flex: 'none', textAlign: 'right', maxWidth: '45%', ...ellipsis })}>{l.value}</span>
    </div>
  );
}

/** 'not monitored yet' for a column whose plan isn't applied (or 'Prometheus not answering'). */
export function OpsEmpty({ missing }: { missing: OpsView['missing'] }) {
  return (
    <div style={flexCol(4, { padding: '12px 0' })}>
      {missing.map(m => <span key={m.id} style={{ fontSize: 12, color: 'var(--mut-3)' }} title={m.needs}>{m.name} · {m.why}<span style={{ color: 'var(--mut-3)' }}> · {m.needs}</span></span>)}
    </div>
  );
}

/** One line of chips for areas without data: 'Not monitored yet · 3  ○ Server UPS  ○ Updates …' (hover: what adds it). */
export function NotYetLine({ missing, style }: { missing: OpsView['missing']; style?: CSSProperties }) {
  if (!missing.length) return null;
  const notYet = missing.every(m => m.why === 'not monitored yet');
  return (
    <div data-notyet style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, ...style }}>
      <span style={{ ...eyebrow('var(--mut-3)', 11), marginRight: 2 }}>{notYet ? 'Not monitored yet' : 'No data'} · {missing.length}</span>
      {missing.map(m => (
        <span key={m.id} data-chip-ops title={`${m.why} · needs ${m.needs}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 99, border: '1px solid var(--pill-bd)', fontSize: 11, color: 'var(--mut-3)', whiteSpace: 'nowrap' }}>
          <span style={{ width: 6, height: 6, boxSizing: 'border-box', borderRadius: '50%', border: '1.5px solid var(--mut-5)' }} />{m.name}{m.why !== 'not monitored yet' ? ` · ${m.why}` : ''}
        </span>
      ))}
    </div>
  );
}

const fmtMin = (m: number | null) => (m == null ? '—' : m >= 90 ? `${Math.floor(m / 60)} h ${Math.floor(m % 60)} min` : `${Math.floor(m)} min`);
export const powerWord = (p: PowerView) => (p.fresh ? p.state : 'Stale');
export const toneVar = (t: PowerView['tone']) => (t === 'danger' ? 'var(--danger)' : t === 'warn' ? 'var(--warn)' : 'var(--ok)');
/** The four readings, each '—' when the data isn't fresh. */
export const powerFigures = (p: PowerView): [string, string][] => [
  [p.chargePct == null ? '—' : `${Math.round(p.chargePct)}%`, 'charge'],
  [fmtMin(p.runtimeMin), p.onBatterySec != null ? 'runtime now' : 'avg runtime'],
  [p.loadW == null ? '—' : `${Math.round(p.loadW)} W`, p.loadPct == null ? 'load' : `load · ${Math.round(p.loadPct)}%`],
  [p.lineV == null ? '—' : `${Math.round(p.lineV)} V`, 'line'],
];

/** Health's Power column: state, the four readings, the charge bar, history and thresholds. */
export function PowerBlock({ p, compact }: { p: PowerView; compact?: boolean }) {
  const c = toneVar(p.tone), size = compact ? 18 : 20;
  return (
    <div data-power style={flexCol(10, { paddingTop: 4 })}>
      <div style={row(10)}>
        <Dot size={8} color={c} pulse={p.tone === 'danger' ? 'danger' : undefined} />
        <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, ...ellipsis }}>{p.name}{p.model && <span style={{ color: 'var(--mut-3)', fontWeight: 500 }}> · {p.model}</span>}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: c, flex: 'none' }}>{powerWord(p)}</span>
      </div>
      <span style={{ fontSize: 12, color: p.tone === 'ok' ? 'var(--mut-3)' : p.tone === 'danger' ? 'var(--danger-sub)' : 'var(--warn-sub)', lineHeight: 1.4 }}>
        {p.sub}{p.readAt != null && p.fresh ? <span style={{ color: 'var(--mut-3)' }}> · read {ago(p.readAt)}</span> : null}
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 8 }}>
        {powerFigures(p).map(([v, k]) => (
          <div key={k} style={flexCol(1)}>
            <span style={mono(size, v === '—' ? 'var(--mut-3)' : undefined, { fontWeight: 500, whiteSpace: 'nowrap' })}>{v}</span>
            <span style={{ fontSize: 11, color: 'var(--mut-3)', ...ellipsis }}>{k}</span>
          </div>
        ))}
      </div>
      <Bar pct={p.chargePct} height={5} color={p.tone === 'danger' ? 'var(--danger)' : 'var(--accent)'} />
      <div style={flexCol(0, { borderTop: RULE3 })}>
        {p.lines.map(l => (
          <div key={l.id} title={l.sub} style={row(10, { minHeight: compact ? 44 : 40, padding: '3px 0', boxSizing: 'border-box', borderBottom: RULE3 })}>
            <div style={{ flex: 1, minWidth: 0, ...flexCol(0) }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>{l.name}</span>
              <span style={{ fontSize: 11.5, color: 'var(--mut-3)', ...ellipsis }}>{l.sub}</span>
            </div>
            <span style={mono(11.5, 'var(--mut-1)', { flex: 'none', maxWidth: '50%', ...ellipsis })}>{l.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const years = (h: number | null) => (h == null ? '' : `${(h / 8766).toFixed(1)} y`);
/** Health's Unraid disks column: array and parity lines (a running check with its progress), then one line per disk,
 *  problems first. Temperatures stay neutral: there is no temperature rule, on purpose. */
export function DisksBlock({ d, tall }: { d: DisksView; tall?: boolean }) {
  if (d.stale) return <div style={{ padding: '12px 0', fontSize: 12, color: 'var(--warn)' }}>Not read: {d.stale} · disk, array and parity figures hidden</div>;
  return <>
    {d.lines.map(l => (
      <div key={l.id} style={flexCol(0)}>
        <OpsRow l={l} tall={tall} style={l.id === 'parity' && d.parityProgress != null ? { borderBottom: 0 } : undefined} />
        {l.id === 'parity' && d.parityProgress != null && <div style={{ padding: '0 0 10px 19px', borderBottom: RULE3 }}><Bar pct={d.parityProgress * 100} height={4} color="var(--info)" /></div>}
      </div>
    ))}
    {d.rows.length > 0 && <div data-diskhealth style={flexCol(0, { padding: '6px 0', borderBottom: RULE3 })}>
      {d.rows.map(r => (
        <div key={r.disk} title={`${r.type} · ${r.status}${r.hours != null ? ` · ${Math.round(r.hours).toLocaleString('en-US')} h powered on` : ''}`} style={row(10, { minHeight: tall ? 32 : 26 })}>
          <Dot size={6} color={opsDot(r.tone)} />
          <span style={{ width: 48, flex: 'none', fontSize: 12, fontWeight: 600 }}>{r.disk}</span>
          <span style={mono(11.5, r.tempC == null ? 'var(--mut-3)' : 'var(--mut-1)', { width: 34, flex: 'none', textAlign: 'right' })}>{r.spundown ? 'idle' : r.tempC == null ? '—' : `${Math.round(r.tempC)}°`}</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: r.tone === 'danger' ? 'var(--danger)' : r.tone === 'warn' ? 'var(--warn)' : 'var(--mut-3)', ...ellipsis }}>{r.status !== 'OK' && r.status !== '—' ? `${r.status} · ` : ''}{r.smart}</span>
          <span style={mono(11.5, 'var(--mut-3)', { width: 40, flex: 'none', textAlign: 'right' })}>{years(r.hours)}</span>
        </div>
      ))}
    </div>}
  </>;
}

/** An Updates sub-line for a host or guest: '18 updates · 9 security · reboot needed'. */
export function updatesText(u: UpdatesView) {
  if (u.value === '—') return u.sub;
  const p = u.pending ?? 0, s = u.security ?? 0;
  return [!p && !s ? 'up to date' : `${p} update${p === 1 ? '' : 's'}`, s ? `${s} security` : '', u.reboot ? 'reboot needed' : ''].filter(Boolean).join(' · ');
}
/** The same, as a line with the tier's colour (host and guest panels on Overview, the phone's guest screen). */
export function UpdatesLine({ u, size = 12, prefix = '' }: { u: UpdatesView; size?: number; prefix?: string }): ReactNode {
  return (
    <span data-updates title={u.sub} style={{ fontSize: size, color: u.tone === 'warn' ? 'var(--warn)' : u.tone === 'info' ? 'var(--info)' : 'var(--mut-3)', minWidth: 0, ...ellipsis }}>
      {prefix}{updatesText(u)}
    </span>
  );
}

/** Home → Safety & power: the server UPS in one row (state, charge · runtime · load), like the detectors above it. */
export function UpsHomeRow({ p, minHeight = 48, nameSize = 14 }: { p: PowerView; minHeight?: number; nameSize?: number }) {
  const c = toneVar(p.tone), [charge, runtime, load] = powerFigures(p);
  return (
    <div data-ups style={row(12, { minHeight, borderBottom: RULE3 })}>
      <Dot size={7} color={c} pulse={p.tone === 'danger' ? 'danger' : undefined} />
      <div style={{ flex: 1, minWidth: 0, ...flexCol(1) }}>
        <span style={{ fontSize: nameSize, fontWeight: 600, ...ellipsis }}>{p.name}{p.model && <span style={{ color: 'var(--mut-3)', fontWeight: 500 }}> · {p.model}</span>}</span>
        <span style={{ fontSize: 11.5, color: p.tone === 'ok' ? 'var(--mut-3)' : p.tone === 'danger' ? 'var(--danger-sub)' : 'var(--warn-sub)', ...ellipsis }} title={p.sub}>
          {p.fresh ? [`${charge[0]} charge`, `${runtime[0]} runtime`, load[0], p.onBatterySec != null ? p.sub : ''].filter(x => x && !x.startsWith('—')).join(' · ') : p.sub}
        </span>
      </div>
      <span style={{ fontSize: 12, color: c, fontWeight: 700, flex: 'none' }}>{powerWord(p)}</span>
    </div>
  );
}
