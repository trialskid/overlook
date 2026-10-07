// Review Phase 5 (1c): Open, the launcher promoted and grouped by what each app is for (src/lib/groups.ts), in six
// columns (Home and Projects share the last), under one search that covers services and bookmarks. While searching,
// the matching bookmarks show under the services; all of them sit in their own section at the bottom of the page
// ('Bookmarks · N →'), less the ones Open already shows.
import { useEffect, useRef } from 'react';
import { useApp } from '../state.tsx';
import { STATUS_WORD, hueOf, monoClashes, monoOf, scrollToId } from '../lib/util.ts';
import { StatusDot, Tile, ellipsis, eyebrow, flexCol, mono, row, ruled } from '../lib/ui.tsx';
import { matches } from '../lib/search.ts';
import { columnsOf, groupItems } from '../lib/groups.ts';
import { openItems, type LaunchItem } from './Overview.tsx';
import { BookmarkRow, useLinkFilter } from './Links.tsx';

const COL_GAP = '0 28px';

export function Open() {
  const { snap, ui, set } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const q = ui.launcherQuery.trim().toLowerCase();
  const all = openItems(snap), list = all.filter(u => !q || matches(u.hay, q));
  // the columns keep their width while searching: as many as the full list has (six, seven with Other)
  const cols = columnsOf(groupItems(all)).length, columns = columnsOf(groupItems(list));
  const bm = useLinkFilter(undefined, ui.launcherQuery), links = bm.groups.flatMap(g => g.items);
  useEffect(() => {
    // '/' opens ⌘K (App.tsx); this field works when clicked, and Escape clears it
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && document.activeElement === input.current) { set({ launcherQuery: '' }); input.current?.blur(); } };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [set]);
  // two tiles with one monogram can't be told apart: say so while developing (tests/server/monograms.test.ts checks the config)
  const names = all.map(u => u.name).join('\n');
  useEffect(() => {
    const c = import.meta.env.DEV ? monoClashes(names.split('\n')) : [];
    if (c.length) console.warn(`Open monograms clash: ${c.join(' · ')}`);
  }, [names]);
  return (
    <section data-section="open" aria-label="Open" style={flexCol(14)}>
      <div style={row(18)}>
        <span style={{ fontSize: 17, fontWeight: 700, flex: 'none' }}>Open</span>
        <label style={row(10, { width: 440, padding: '8px 0', borderBottom: '1px solid var(--rule)', flex: 'none' })}>
          <span style={mono(14, 'var(--accent)')}>/</span>
          <input ref={input} value={ui.launcherQuery} onChange={e => set({ launcherQuery: e.target.value })} aria-label="Search services and bookmarks"
            placeholder={`Search ${all.length} services and ${bm.total} bookmarks…`}
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 0, outline: 'none', color: 'var(--text)', font: '400 14px var(--font-ui)' }} />
        </label>
        {q && <span style={{ fontSize: 12, color: 'var(--mut-3)', flex: 'none' }}>{list.length + links.length} of {all.length + bm.total}</span>}
        <span style={{ flex: 1 }} />
        <button type="button" className="h-link" onClick={() => scrollToId('overview-bookmarks')} style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', flex: 'none' }}>Bookmarks · {bm.total} →</button>
      </div>
      {columns.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},minmax(0,1fr))`, gap: COL_GAP, alignItems: 'start' }}>
          {/* a column holds one group, or two stacked (Home, then Projects), each under its own rule */}
          {columns.map(col => (
            <div key={col[0].title} style={flexCol(14, { minWidth: 0 })}>
              {col.map(g => (
                <div key={g.title} style={ruled('12px 0 0', 'var(--rule)', flexCol(1, { minWidth: 0 }))}>
                  <span style={{ ...eyebrow(), padding: '0 6px 8px', ...ellipsis }}>{g.title}</span>
                  {g.items.map(u => <OpenRow key={u.key} u={u} />)}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {q && links.length > 0 && (
        <div style={ruled('12px 0 0', 'var(--rule)', flexCol(1))}>
          <span style={{ ...eyebrow(), padding: '0 6px 8px' }}>Bookmarks · {links.length} {links.length === 1 ? 'match' : 'matches'}</span>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols},minmax(0,1fr))`, gap: COL_GAP }}>
            {bm.groups.flatMap(g => g.items.map((l, i) => <BookmarkRow key={`${g.group}-${l.name}-${i}`} l={l} mono={bm.mono(l.name)} />))}
          </div>
        </div>
      )}
      {q && !list.length && !links.length && <span style={{ fontSize: 13, color: 'var(--mut-3)' }}>Nothing matches “{ui.launcherQuery}”</span>}
    </section>
  );
}

/** A service: a 26px monogram tile (round for an app, ringed when public), its name, its status dot. */
function OpenRow({ u }: { u: LaunchItem }) {
  const state = u.monitored ? STATUS_WORD[u.status].toLowerCase() : 'no monitor';
  return (
    <a className="h-row" href={u.url} target="_blank" rel="noopener noreferrer" title={`${u.url} · ${state}`} aria-label={`Open ${u.label} · ${state}`}
      style={row(10, { padding: '5px 6px', borderRadius: 9, color: 'inherit', minWidth: 0 })}>
      <Tile mono={monoOf(u.name)} hue={hueOf(u.name)} size={26} radius={u.app ? 13 : 8} fontSize={11} style={{ boxShadow: u.public ? '0 0 0 1.5px var(--pub)' : 'none' }} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: u.status === 'down' ? 'var(--danger)' : u.status === 'degraded' ? 'var(--warn)' : 'var(--text-2)', ...ellipsis }}>{u.label}</span>
      <StatusDot status={u.status} monitored={u.monitored} size={7} />
    </a>
  );
}
