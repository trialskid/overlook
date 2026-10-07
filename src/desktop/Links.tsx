import { useApp } from '../state.tsx';
import { hueOf, monoSet } from '../lib/util.ts';
import { Tile, ellipsis, eyebrow, flexCol, row, ruled } from '../lib/ui.tsx';
import { aliasOf, matches } from '../lib/search.ts';
import { withoutServices } from '../lib/groups.ts';
import { EditButton, LinksEditorView, LinksNote, useLinksEditor } from './LinksEdit.tsx';
import { openItems } from './Overview.tsx';
import type { Snapshot } from '../../shared/types.ts';

/** links: what to show (the editor's just-saved list until the snapshot carrying it arrives), default the snapshot's.
 *  query: Open's one search (desktop and phone). A bookmark on the same host as a service in Open is left out (it's
 *  already there); `hidden` counts them. mono: each bookmark's monogram, unique within the bookmarks shown. */
export function useLinkFilter(links: Snapshot['links'] | undefined, query: string) {
  const { snap } = useApp();
  const { groups: all, hidden } = withoutServices(links ?? snap.links, openItems(snap).map(u => u.url));
  const q = query.trim().toLowerCase();
  const total = all.reduce((a, g) => a + g.items.length, 0);
  const monos = monoSet(all.flatMap(g => g.items.map(l => l.name)));
  const groups = all
    .map(g => ({ ...g, items: g.items.filter(l => !q || matches(`${l.name} ${l.domain} ${l.url} ${g.group} ${aliasOf(l.name)}`.toLowerCase(), q)) }))
    .filter(g => g.items.length);
  const shown = groups.reduce((a, g) => a + g.items.length, 0);
  return { q, groups, total, shown, hidden, mono: (name: string) => monos.get(name) ?? '?', label: q ? `${shown} of ${total}` : `${total} links · ${all.length} groups` };
}

type Link = Snapshot['links'][number]['items'][number];
/** A bookmark as one of Open's rows: a 26px tile and the name; the address is in the tooltip. */
export const BookmarkRow = ({ l, mono }: { l: Link; mono: string }) => (
  <a className="h-row" href={l.url} target="_blank" rel="noopener noreferrer" title={`${l.name} · ${l.url}`} style={row(10, { padding: '5px 6px', borderRadius: 9, color: 'inherit', minWidth: 0 })}>
    <Tile mono={mono} hue={hueOf(l.name, 41)} size={26} fontSize={11} />
    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-2)', ...ellipsis }}>{l.name}</span>
  </a>
);

/** The former Links tab, its own section at the bottom of the Overview, in Open's ruled
 *  columns, with the editor's Edit button (the site's only write; nothing is sent until Save). */
export function Bookmarks() {
  const ed = useLinksEditor();
  const { groups, label, hidden, mono } = useLinkFilter(ed.shown, '');
  return (
    <section id="overview-bookmarks" data-section="bookmarks" aria-label="Bookmarks" style={flexCol(14, { scrollMarginTop: 20 })}>
      <div style={row(14)}>
        <span style={{ fontSize: 17, fontWeight: 700, flex: 'none' }}>Bookmarks</span>
        {/* the editor lists every link; here the ones Open already shows are left out, so say how many */}
        {!ed.draft && <span style={{ fontSize: 13, color: 'var(--mut-3)' }}>{label}{hidden ? ` · ${hidden} more in Open` : ''}</span>}
        <span style={{ flex: 1 }} />
        <EditButton ed={ed} />
      </div>
      <LinksNote ed={ed} />
      {ed.draft ? <LinksEditorView ed={ed} /> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,minmax(0,1fr))', gap: '20px 28px', alignItems: 'start' }}>
          {groups.map(g => (
            <div key={g.group} style={ruled('12px 0 0', 'var(--rule)', flexCol(1, { minWidth: 0 }))}>
              <span style={{ ...eyebrow(), padding: '0 6px 8px', ...ellipsis }}>{g.group}</span>
              {g.items.map((l, i) => <BookmarkRow key={`${l.name}-${i}`} l={l} mono={mono(l.name)} />)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
