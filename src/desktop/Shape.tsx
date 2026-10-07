// Review Phase 5 (1c): the Overview has two shapes. Calm (green or amber): Open first, then the network band, the
// glanceables and the bookmarks; amber adds one line under the header. Incident (anything red): the incident band
// leads, then the same sections, the network band dimmed off the failing path. Today's Overview is ?overview=classic.
import { on } from '../lib/modules.ts';
import { useState } from 'react';
import { useApp } from '../state.tsx';
import { last, secSince } from '../lib/util.ts';
import { Dot, ellipsis, eyebrow, flexCol, mono, row, ruled } from '../lib/ui.tsx';
import { amberSummary, bandModel, needsYou, notesOf } from '../lib/incident.ts';
import type { Attention } from '../../shared/types.ts';
import { Activity, AttnLine, PlexBlock, Spotlight } from './Overview.tsx';
import { FailTrace, useTrace } from './Trace.tsx';
import { IncidentBand, NotesFold } from './Band.tsx';
import { Open } from './Open.tsx';
import { NetworkBand } from './NetBand.tsx';
import { Bookmarks } from './Links.tsx';

export function OverviewShape() {
  const { snap, live } = useApp();
  const wanIn = last(live.history.wanIn), rich = { cpu: live.history.cpu };
  const band = bandModel(snap, wanIn, rich);
  // above the switch, so the green replay still plays once the band has gone
  const trace = useTrace(snap, needsYou(snap.attention), wanIn, rich);
  const amber = band ? null : amberSummary(snap, secSince), notes = notesOf(snap.attention);
  // every section keeps its place in this list whatever leads, so Open's field and the bookmarks editor never remount
  return (
    <div data-shape={band ? 'incident' : 'calm'} style={flexCol(28, { paddingTop: 8 })}>
      {band ? <IncidentBand band={band} />
        : trace.back ? <Recovered id={trace.back.id} hops={trace.back.hops} />
          : amber ? <AmberLine key={amber.n === 1 ? 'one' : 'many'} n={amber.n} items={amber.items} age={amber.age} notes={notes} /> : null}
      <Open />
      <NetworkBand band={band} />
      <Glanceables />
      {!band && !amber && notes.length > 0 ? <NotesFold notes={notes} /> : null}
      <Bookmarks />
    </div>
  );
}

/** Amber keeps the calm shape: one line under the header, '3 to look at · Docker configs failed · 6 d ·
 *  +2 ▾', that unfolds in place to the compact rows (worst first, each with its action); notes stay folded. With one
 *  item the headline already names it, so the line gives its detail and action instead ('CT 104 → Unraid: last run
 *  failed · Open in Grafana ↗'), and folds only the notes. */
function AmberLine({ n, items, age, notes }: { n: number; items: Attention[]; age: string | null; notes: Attention[] }) {
  const [open, setOpen] = useState(false);
  const sep = <span aria-hidden="true" style={{ color: 'var(--warn-sub)', flex: 'none' }}>·</span>;
  if (n === 1) {
    const a = items[0];
    return (
      <section aria-label="Needs a look" data-section="amber" style={ruled('12px 0 0', 'var(--warn-rule)', flexCol())}>
        <div style={row(8, { minWidth: 0, fontSize: 13 })}>
          <Dot size={7} color="var(--warn)" style={{ marginRight: 2 }} />
          <span title={a.detail} style={{ fontWeight: 600, color: 'var(--text-2)', minWidth: 0, ...ellipsis }}>{a.detail || a.title}</span>
          {a.action && <>{sep}<a className="h-link" href={a.action.href} target="_blank" rel="noopener noreferrer" style={{ flex: 'none', fontWeight: 600, color: 'var(--warn)', whiteSpace: 'nowrap' }}>{a.action.label} ↗</a></>}
          {notes.length > 0 && <>
            <span style={{ flex: 1 }} />
            <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className="h-link" style={{ flex: 'none', fontSize: 12, fontWeight: 600, color: 'var(--info)', whiteSpace: 'nowrap' }}>
              {open ? 'Hide notes' : `+${notes.length} note${notes.length === 1 ? '' : 's'}`} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
            </button>
          </>}
        </div>
        {open && <div style={flexCol(0, { paddingTop: 2 })}>{notes.map(x => <AttnLine key={x.id} a={x} />)}</div>}
      </section>
    );
  }
  return (
    <section aria-label="Needs a look" data-section="amber" style={ruled('12px 0 0', 'var(--warn-rule)', flexCol())}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} title={items[0].detail}
        style={row(8, { width: '100%', minWidth: 0, fontSize: 13, color: 'var(--warn)', textAlign: 'left' })}>
        <Dot size={7} color="var(--warn)" style={{ marginRight: 2 }} />
        <span style={{ fontWeight: 700, flex: 'none' }}>{n} to look at</span>{sep}
        <span style={{ fontWeight: 600, color: 'var(--text-2)', minWidth: 0, ...ellipsis }}>{items[0].title}</span>
        {age && <>{sep}<span style={mono(12, 'var(--warn-sub)', { flex: 'none' })}>{age}</span></>}
        {sep}<span style={{ fontSize: 12, fontWeight: 600, flex: 'none' }}>{n > 1 ? `+${n - 1} ` : ''}<span aria-hidden="true">{open ? '▴' : '▾'}</span></span>
      </button>
      {open && <div style={flexCol(0, { paddingTop: 2 })}>
        {items.map(a => <AttnLine key={a.id} a={a} action />)}
        <NotesFold notes={notes} style={{ paddingTop: 8 }} />
      </div>}
    </section>
  );
}

/** After the red item clears because its subject answers again: the path replays in green for a few seconds, where the
 *  band was (3d), then the calm shape takes the top. */
function Recovered({ id, hops }: { id: string; hops: Parameters<typeof FailTrace>[0]['hops'] }) {
  return (
    <section aria-label={`${hops[hops.length - 1].name} is back`} data-section="recovered" style={{ borderTop: '2px solid var(--ok)', paddingTop: 18 }}>
      <div style={flexCol(12, { width: 400 })}>
        <span style={eyebrow('var(--ok)')}>{hops[hops.length - 1].name} is back</span>
        <FailTrace key={`${id}:up`} id={id} hops={hops} ok rowH={36} gap={14} margin="0" halo />
      </div>
    </section>
  );
}

/** Plex, the spotlight app and Recent activity side by side (1c): as many columns as the lab has of them. */
function Glanceables() {
  const { snap } = useApp();
  const pad = '16px 0 4px', n = [on(snap, 'plex'), on(snap, 'spotlight'), on(snap, 'ntfy')].filter(Boolean).length;
  if (!n) return null;
  return (
    <div data-section="glance" style={{ display: 'grid', gridTemplateColumns: `repeat(${n},minmax(0,1fr))`, gap: 48, alignItems: 'start' }}>
      <PlexBlock pad={pad} idleLine />
      <Spotlight pad={pad} gap={10} />
      <Activity pad={pad} limit={3} />
    </div>
  );
}
