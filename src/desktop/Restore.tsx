// The Restore tab (module restore): every copy, how old its newest one is, what proves it restores and what a restore
// costs. Look only: no button, no form. The one link per row opens another app's compose box (homelab.json
// restore.ask), and says nothing more than the config does.
import { useApp } from '../state.tsx';
import { ago, clockText, dayText } from '../lib/util.ts';
import { Ext, SectionTitle, ellipsis, flexCol, mono, row, ruled } from '../lib/ui.tsx';
import type { RestoreItemView } from '../../shared/types.ts';

const RULE3 = '1px solid var(--rule-3)';
/** n · name · newest copy · proof · cost · ask */
const COLS = '28px 220px 290px 250px minmax(0,1fr) 230px';

/** 'Nov 18 4:02 AM' */
export const stamp = (at: number) => `${dayText(at)} ${clockText(new Date(at))}`;
/** proofOn ('2026-10-02', a local date) or proofAt (epoch ms) → 'Oct 2' */
const proofDay = (p: number | string) => (typeof p === 'number' ? dayText(p) : (([y, m, d]) => dayText(new Date(y, m - 1, d).getTime()))(p.split('-').map(Number)));
/** the proof's words and tone: restore-tested green with its date, verified neutral, finished only muted (a fact, not a fault) */
export const proofLook = (it: RestoreItemView) => it.proof === 'restore-tested'
  ? { text: `restore-tested${it.proofAt != null ? ` ${proofDay(it.proofAt)}` : ''}`, color: 'var(--ok)' }
  : it.proof === 'verified' ? { text: 'verified', color: 'var(--text-2)' } : { text: 'finished only', color: 'var(--mut-3)' };
/** 'oldest of 4/4 sources' when the item has several series (or expects them); the count part is amber when short */
export const seriesParts = (it: RestoreItemView) => {
  const { read, expected, unit } = it.series;
  if (it.why || (read <= 1 && (expected ?? 1) <= 1)) return null;
  return { lead: read > 1 ? 'oldest of ' : '', count: expected != null ? `${read}/${expected}` : String(read), unit: unit ?? 'series' };
};
/** the age's colour: amber when stale, muted when it can't be read */
export const ageColor = (it: RestoreItemView) => (it.why ? 'var(--mut-3)' : it.stale ? 'var(--warn)' : 'var(--text-2)');

export function Series({ it, size = 12 }: { it: RestoreItemView; size?: number }) {
  const s = seriesParts(it);
  if (!s) return null;
  return <span style={{ fontSize: size, color: 'var(--mut-3)' }}>{s.lead}<span style={mono(size - 0.5, it.short ? 'var(--warn)' : 'var(--mut-2)')}>{s.count}</span> {s.unit}{it.short ? ' read' : ''}</span>;
}

/** The ask: the config's link (only when it has a url) and its plain words. tap (the phone): one line, the link a
 *  44px tap target that overlaps the row's padding instead of adding height. */
export function Ask({ it, align = 'right', tap }: { it: RestoreItemView; align?: 'left' | 'right'; tap?: boolean }) {
  if (!it.ask) return null;
  return (
    <div style={tap ? row(10, { flexWrap: 'wrap', rowGap: 0, margin: it.ask.url ? '-12px 0' : 0, minWidth: 0 }) : flexCol(3, { alignItems: align === 'right' ? 'flex-end' : 'flex-start', textAlign: align, minWidth: 0 })}>
      {it.ask.url && <Ext href={it.ask.url} arrow={false} label={`${it.ask.label} ${it.name} (opens another app)`} style={{ fontSize: 13, fontWeight: 600, ...(tap ? { display: 'inline-flex', alignItems: 'center', minHeight: 44 } : {}) }}>{it.ask.label}</Ext>}
      {it.ask.text && <span style={{ fontSize: 11, color: 'var(--mut-3)', lineHeight: 1.35 }}>{it.ask.text}</span>}
    </div>
  );
}

function Row({ it }: { it: RestoreItemView }) {
  const p = proofLook(it);
  const name = it.link ? <Ext href={it.link} arrow={false} label={`${it.name}: its runbook`} style={{ color: 'inherit' }}>{it.name}</Ext> : it.name;
  return (
    <div id={`restore-${it.id}`} data-restore={it.id} style={{ display: 'grid', gridTemplateColumns: COLS, gap: 16, alignItems: 'start', padding: '11px 0', borderBottom: RULE3, scrollMarginTop: 80 }}>
      <span style={mono(12, 'var(--mut-3)', { lineHeight: '20px' })}>{it.n}</span>
      <span style={{ fontSize: 14, fontWeight: 600, lineHeight: '20px', minWidth: 0, ...ellipsis }}>{name}</span>
      <div style={flexCol(2, { minWidth: 0 })}>
        {it.newest != null
          ? <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--text-2)', whiteSpace: 'nowrap' }}><span style={mono(12.5)}>{stamp(it.newest)}</span> · <span style={{ color: ageColor(it) }}>{ago(it.newest)}</span></span>
          : <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--mut-3)' }}>{it.why}</span>}
        <Series it={it} />
      </div>
      <div style={flexCol(2, { minWidth: 0 })}>
        <span style={{ fontSize: 13, lineHeight: '20px', color: p.color, fontWeight: it.proof === 'restore-tested' ? 600 : 400 }}>{p.text}</span>
        {it.proofNote && <span style={{ fontSize: 12, color: 'var(--mut-3)', ...ellipsis }} title={it.proofNote}>{it.proofNote}</span>}
      </div>
      <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--mut-2)', minWidth: 0 }}>{it.cost ?? ''}</span>
      <Ask it={it} />
    </div>
  );
}

export function Restore() {
  const { snap } = useApp();
  const r = snap.restore;
  if (!r) return null;
  return (
    <div style={ruled('16px 0 0', 'var(--rule)', flexCol())}>
      <SectionTitle id="restore" title="Restore" sub={r.note}
        right={<><span style={{ flex: 1 }} /><span style={{ fontSize: 12, color: 'var(--mut-3)', flex: 'none' }}>read at <span style={mono(12, 'var(--text-2)')}>{r.readAt != null ? clockText(new Date(r.readAt)) : '—'}</span></span></>} />
      <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 16, padding: '6px 0', borderBottom: RULE3, fontSize: 11, letterSpacing: '.08em', fontWeight: 700, color: 'var(--mut-3)', textTransform: 'uppercase' }}>
        <span>#</span><span>Copy</span><span>Newest copy</span><span>Proof</span><span>What a restore costs</span><span style={{ textAlign: 'right' }}>Ask</span>
      </div>
      {r.items.map(it => <Row key={it.id} it={it} />)}
      {r.runbook && <div style={{ paddingTop: 14, fontSize: 12, color: 'var(--mut-3)' }}><Ext href={r.runbook} style={{ fontSize: 12, fontWeight: 600 }}>Paper runbook</Ext></div>}
    </div>
  );
}
