// Review Phase 5 (1c): the incident band. Anything red takes the top of the Overview, under a 2px --danger rule: where
// it breaks (the 3d trace), the evidence, and the next step. The band is about the worst red item; the rest follow as
// '+N more'. Every button-shaped thing in it is a link that opens elsewhere (↗); nothing here changes the homelab.
import { useState, type CSSProperties } from 'react';
import { useApp } from '../state.tsx';
import { agoText, clockText, secSince, whyMissing } from '../lib/util.ts';
import { Chip, StatusDot, UptimeCells, ellipsis, eyebrow, flexCol, mono, row } from '../lib/ui.tsx';
import type { Band } from '../lib/incident.ts';
import type { Attention } from '../../shared/types.ts';
import { AttnLine } from './Overview.tsx';
import { FailTrace } from './Trace.tsx';

const TEXT: CSSProperties = { fontSize: 13, lineHeight: 1.5, color: 'var(--text-2)' };

export function IncidentBand({ band }: { band: Band }) {
  const { item, hops } = band, next = band.actions.length > 0 || band.notes.length > 0;
  return (
    <section data-section="band" aria-label={`Incident: ${item.title}`} style={flexCol(16, { borderTop: '2px solid var(--danger)', paddingTop: 18 })}>
      {/* an item with no action and no notes has no next step: that column goes (README: empty columns are hidden) */}
      <div style={{ display: 'grid', gridTemplateColumns: next ? '400px minmax(0,1fr) 300px' : '400px minmax(0,1fr)', gap: 48, alignItems: 'start' }}>
        <div style={flexCol(12, { minWidth: 0 })}>
          {hops ? <>
            <span style={eyebrow()}>Where it breaks</span>
            {/* keyed by the item and its state, so a snapshot rebuild never replays it */}
            <FailTrace key={`${item.id}:down`} id={item.id} hops={hops} rowH={36} gap={14} margin="0" halo />
            {band.sentence && <span style={{ ...TEXT, paddingTop: 4 }}>{band.sentence}</span>}
          </> : <>
            {/* an item that maps to no host, guest or web UI: its own words */}
            <span style={eyebrow()}>What's wrong</span>
            <span style={TEXT}>{item.detail}</span>
          </>}
        </div>
        <Evidence band={band} />
        {next && <NextStep band={band} />}
      </div>
      {band.more.length > 0 && (
        <div style={flexCol(0, { borderTop: '1px solid var(--rule-3)', paddingTop: 12 })}>
          <span style={eyebrow()}>+{band.more.length} more</span>
          {band.more.map(a => <AttnLine key={a.id} a={a} action />)}
        </div>
      )}
    </section>
  );
}

/** The monitor's 24 h strip with down since, latency and 30-day uptime; for an item without a monitor, its source and
 *  age. Then the subject's other web UIs. */
function Evidence({ band }: { band: Band }) {
  const { snap } = useApp();
  const { item, monitor: m, alsoOn } = band;
  const since = item.since ?? null, ui = item.id.startsWith('down-');
  const fact = (k: string, v: string, c = 'var(--text-2)') => <span style={{ flex: 'none' }}>{k} <span style={mono(12, c)}>{v}</span></span>;
  const facts: CSSProperties = row(28, { fontSize: 12, color: 'var(--mut-3)', flexWrap: 'wrap', rowGap: 6 });
  return (
    <div style={flexCol(12, { minWidth: 0 })}>
      {m ? <>
        <span style={eyebrow()}>{m.label.replace(/\.+$/, '') || m.name} · last 24 h</span>
        <UptimeCells cells={m.cells} title={m.uptime1 != null ? `24 h: ${m.uptime1.toFixed(2)}%` : undefined} />
        <div style={facts}>
          {/* with its age: a bare clock time misreads once the outage runs past midnight */}
          {fact('Down since', since != null ? `${clockText(new Date(since))} · ${agoText(secSince(since))}` : '—', 'var(--danger-sub)')}
          {fact('Latency', m.ms == null ? '—' : `${m.ms} ms`)}
          {fact('30-day', m.uptime30 == null ? '—' : `${m.uptime30.toFixed(2)}%`)}
          <span style={{ flex: 1 }} />
          <span style={{ flex: 'none' }}>Source: {item.source}</span>
        </div>
      </> : <>
        <span style={eyebrow()}>Evidence</span>
        {ui && <span style={{ fontSize: 12, color: 'var(--mut-3)' }}>{whyMissing(snap, 'kuma', 'Uptime Kuma')}</span>}
        <div style={facts}>
          {since != null && fact('Since', `${clockText(new Date(since))} · ${agoText(secSince(since))}`, 'var(--danger-sub)')}
          <span style={{ flex: 'none' }}>Source: {item.source}</span>
        </div>
      </>}
      {alsoOn && <>
        <span style={{ ...eyebrow(), paddingTop: 12 }}>{alsoOn.title}{alsoOn.watched ? ` · ${alsoOn.up} of ${alsoOn.watched} up` : ''}</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {alsoOn.chips.map(c => (
            <Chip key={c.name} size={12} pad="4px 10px" border={c.public ? 'var(--pub-bd)' : undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <StatusDot status={c.status} monitored={c.monitored} size={6} />{c.label}
            </Chip>
          ))}
        </div>
      </>}
    </div>
  );
}

/** The item's own action first (in red), then the guest in Proxmox and the service itself; then the folded notes. */
function NextStep({ band }: { band: Band }) {
  const { actions, notes } = band;
  const titles = notes.slice(0, 2).map(a => a.title).join(' · ');
  return (
    <div style={flexCol(10, { minWidth: 0 })}>
      {actions.length > 0 && <span style={eyebrow()}>Next step</span>}
      {actions.map(a => (
        <a key={a.href} href={a.href} target="_blank" rel="noopener noreferrer" className="h-ghost" title={a.href}
          style={row(8, { height: 38, padding: '0 14px', borderRadius: 10, border: `1px solid ${a.primary ? 'var(--danger-rule)' : 'var(--rule)'}`, color: a.primary ? 'var(--danger)' : 'var(--text-2)', fontSize: 13, fontWeight: a.primary ? 700 : 600 })}>
          <span style={{ minWidth: 0, ...ellipsis }}>{a.label}</span><span style={{ flex: 1 }} /><span aria-hidden="true" style={{ flex: 'none' }}>↗</span>
        </a>
      ))}
      <NotesFold notes={notes} label={`${notes.length} note${notes.length === 1 ? '' : 's'} · ${titles}`} style={{ paddingTop: actions.length ? 8 : 0 }} />
    </div>
  );
}

/** '+6 notes ▾' (info items, which never change the shape): unfolds to one line each. label: the band's
 *  '2 notes · switch firmware EOL · orphan route'. */
export function NotesFold({ notes, label, style }: { notes: Attention[]; label?: string; style?: CSSProperties }) {
  const [open, setOpen] = useState(false);
  if (!notes.length) return null;
  return (
    <div style={flexCol(0, { minWidth: 0, ...style })}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className="h-link"
        style={{ alignSelf: 'flex-start', maxWidth: '100%', display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--info)', ...ellipsis }}>
        {open ? 'Hide notes' : label ?? `+${notes.length} note${notes.length === 1 ? '' : 's'}`} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && notes.map(a => <AttnLine key={a.id} a={a} />)}
    </div>
  );
}
