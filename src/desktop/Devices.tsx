import { Fragment, useEffect, useRef, useState } from 'react';
import { useApp } from '../state.tsx';
import { ago, scrollToId } from '../lib/util.ts';
import { Dot, NotConnected, SectionTitle, ellipsis, eyebrow, flexCol, mono, row, ruled } from '../lib/ui.tsx';
import { lanOctet, matches } from '../lib/search.ts';
import type { DeviceRow, DevicesView, Status } from '../../shared/types.ts';

type Group = DevicesView['groups'][number];
/** offline reads red only for infra, amber for smart home, grey for the rest (phones come and go) */
const offColor = (id: Group['id']) => (id === 'infra' ? 'var(--danger)' : id === 'home' ? 'var(--warn)' : 'var(--mut-5)');
const WORD: Record<Status, string> = { up: 'online', down: 'offline', degraded: 'degraded', unknown: 'no data' };
/** '.61' on the main LAN, the full address elsewhere */
export const devIp = (ip: string) => ip.split(' · ').map(x => { const o = lanOctet(x); return o ? `.${o}` : x; }).join(' · ') || '—';
/** a row's second line: what it is, and when it was last seen when it's not online */
export const devSub = (r: DeviceRow) => [r.sub, r.status === 'down' && r.lastActive != null ? `last seen ${ago(r.lastActive)}` : r.status === 'unknown' ? 'no data' : ''].filter(Boolean).join(' · ');
const hay = (r: DeviceRow) => `${r.name} ${r.ip} ${r.vendor} ${r.mac} ${r.sub}`.toLowerCase();
/** The groups with the filter applied (empty groups dropped while filtering). */
export function useDeviceGroups() {
  const { snap, ui } = useApp();
  const q = ui.deviceQuery.trim().toLowerCase();
  const groups = snap.devices.groups.map(g => ({ ...g, rows: q ? g.rows.filter(r => matches(hay(r), q)) : g.rows })).filter(g => !q || g.rows.length);
  const all = snap.devices.groups.reduce((a, g) => a + g.rows.length, 0), shown = groups.reduce((a, g) => a + g.rows.length, 0);
  return { q, groups, label: q ? `${shown} of ${all}` : '' };
}
/** '38 online on the LAN · 4 on Guest Wi-Fi', or null while the device list isn't arriving */
export function devCounts(d: DevicesView) {
  const c = d.counts;
  return c ? [`${c.lanOnline} online on the LAN`, ...c.segments.map(x => `${x.online} on ${x.name}`)].join(' · ') : null;
}
export const groupSub = (g: Group) => {
  const on = g.rows.filter(r => r.status === 'up').length;
  return g.id === 'infra' || g.id === 'home' ? `${on} of ${g.rows.length} up` : `${on} online · ${g.rows.length} seen in 30 days`;
};

/** The query's words, as matches() uses them */
export const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARK = { background: 'var(--accent-a22)', color: 'var(--text)', borderRadius: 3, padding: '1px 3px' } as const;
/** Text with the filter's words highlighted (review finding 21), so a row shows what matched. */
export function Hl({ text, q }: { text: string; q: string }) {
  const ws = words(q);
  if (!ws.length || !text) return <>{text}</>;
  const parts = text.split(new RegExp(`(${ws.map(esc).sort((a, b) => b.length - a.length).join('|')})`, 'gi'));
  return <>{parts.map((x, i) => (i % 2 ? <mark key={i} style={MARK}>{x}</mark> : x))}</>;
}
const hits = (text: string, q: string) => words(q).some(w => text.toLowerCase().includes(w));
/** what a device is: its sub-line without the vendor (that has its own column) */
export const kindOf = (r: DeviceRow) => r.sub.split(' · ').filter(x => x && x !== r.vendor).join(' · ');
/** the short IP ('.61'), or the full address when only the full one matches the filter */
export const ipShown = (r: DeviceRow, q: string) => (q && hits(r.ip, q) && !hits(devIp(r.ip), q) ? r.ip : devIp(r.ip));
/** The phone's second line (finding 21): what it is, or while filtering the field that matched. */
export function matchedLine(r: DeviceRow, q: string) {
  if (!q) return devSub(r);
  return [devSub(r), r.vendor, r.mac, r.ip].find(t => t && hits(t, q)) ?? devSub(r);
}

/** Other LAN folds like Basement (Oct 6): its offline and problem rows, then 'Show all N'; open while filtering. */
export const lanFolded = (g: Group, q: string, open: boolean) => g.id === 'lan' && !q && !open;
export const lanRows = (rows: DeviceRow[]) => rows.filter(r => r.status !== 'up');

/** problems first in infra and smart home (offline is red / amber there), the server's order otherwise */
const RANK: Record<Status, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };
type Sort = { key: 'ip' | 'seen'; dir: 1 | -1 } | null;
const ipNum = (ip: string) => { const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(ip.split(' · ')[0]); return m ? ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4] : Infinity; };
const seenAge = (r: DeviceRow) => (r.status === 'up' ? 0 : r.lastActive == null ? Infinity : Date.now() - r.lastActive);
function sortRows(g: Group, sort: Sort) {
  const rows = g.rows.map((r, i) => ({ r, i }));
  const k = (x: DeviceRow) => (sort?.key === 'ip' ? ipNum(x.ip) : seenAge(x));
  rows.sort((a, b) => (sort ? (k(a.r) === k(b.r) ? 0 : k(a.r) === Infinity ? 1 : k(b.r) === Infinity ? -1 : (k(a.r) - k(b.r)) * sort.dir)
    : g.id === 'infra' || g.id === 'home' ? RANK[a.r.status] - RANK[b.r.status] : 0) || a.i - b.i);
  return rows.map(x => x.r);
}
// the review's columns, with IP at 112px (not 90) so a full address fits when the filter shows one
const COLS = '20px 220px 220px 112px 200px 200px minmax(0,1fr)';
const cell = { minWidth: 0, ...ellipsis } as const;

export function DevDot({ s, id, size = 7 }: { s: Status; id: Group['id']; size?: number }) {
  return (
    <span role="img" aria-label={WORD[s]} title={WORD[s]} style={{ display: 'flex', flex: 'none' }}>
      {s === 'unknown' ? <span style={{ width: size, height: size, boxSizing: 'border-box', borderRadius: '50%', border: '1.5px solid var(--mut-5)' }} />
        : <Dot size={size} color={s === 'up' ? 'var(--ok)' : s === 'degraded' ? 'var(--warn)' : offColor(id)} />}
    </span>
  );
}

/** Health's last section (review Phase 5; the Devices tab before). sm: its anchors' scroll margin, under Health's
 *  sticky index. */
export function DevicesSection({ sm = 20 }: { sm?: number }) {
  const { snap, ui, set } = useApp();
  const d = snap.devices, counts = devCounts(d);
  const { q, groups, label } = useDeviceGroups();
  const input = useRef<HTMLInputElement>(null);
  /** IP or Last seen, ascending then descending; a third click goes back to problems first */
  const [sort, setSort] = useState<Sort>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // '/' opens ⌘K (App.tsx); the filter still works when clicked
      if (e.key === 'Escape' && document.activeElement === input.current) { set({ deviceQuery: '' }); input.current?.blur(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [set]);
  return (
    <div style={flexCol(20)}>
      <SectionTitle sm={sm} id="health-devices" title="Devices" pad={0} />
      <div style={row(14)}>
        <span style={{ fontSize: 12, color: 'var(--mut-3)', minWidth: 0, ...ellipsis }}>
          {d.counts ? <span style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 600 }}>
            <button type="button" className="h-link" onClick={() => { set({ lanOpen: true }); scrollToId('devices-lan', 60); }} aria-label={`${d.counts.lanOnline} online on the LAN: show the Other LAN list`}>{d.counts.lanOnline} online on the LAN</button>
            {d.counts.segments.map(x => <Fragment key={x.id}>{' · '}<button type="button" className="h-link" onClick={() => { set(st => ({ segOpen: [...new Set([...st.segOpen, `seg:${x.id}`])] })); scrollToId(`devices-seg:${x.id}`, 60); }} aria-label={`${x.online} on ${x.name}: show the ${x.name} list`}>{x.online} on {x.name}</button></Fragment>)}
          </span> : <span style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 600 }}>{counts ?? 'Infra and smart home from homelab.json'}</span>}
          {d.counts ? ` · ${d.counts.older} not seen for 30 days (not listed) · list ${ago(d.at)}` : <> · <NotConnected what="Device list" src="devices" /></>}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--mut-3)' }}>{label}</span>
        <label style={row(8, { width: 300, padding: '6px 0', borderBottom: '1px solid var(--rule)', flex: 'none' })}>
          <span style={mono(12, 'var(--accent)')}>/</span>
          <input ref={input} value={ui.deviceQuery} onChange={e => set({ deviceQuery: e.target.value })} placeholder="Filter by name, IP, vendor or MAC…" aria-label="Filter devices"
            style={{ flex: 1, background: 'transparent', border: 0, outline: 'none', color: 'var(--text)', font: '500 13px var(--font-ui)' }} />
        </label>
      </div>
      {groups.map(g => {
        const fold = g.id.startsWith('seg:') && !q, open = !fold || ui.segOpen.includes(g.id);
        const lanFold = g.id === 'lan' && !q, sorted = sortRows(g, sort), rows = lanFolded(g, q, ui.lanOpen) ? lanRows(sorted) : sorted;
        return (
          <div key={g.id} style={ruled('14px 0 0', 'var(--rule-2)', flexCol())}>
            {/* a group inside Health's section: an eyebrow, not a 17px title */}
            <div id={`devices-${g.id}`} style={row(10, { paddingBottom: 8, scrollMarginTop: sm, alignItems: 'baseline' })}>
              <span style={{ ...eyebrow(), flex: 'none' }}>{g.title}</span>
              <span style={{ fontSize: 12, color: 'var(--mut-3)', minWidth: 0, ...ellipsis }}>{groupSub(g)}</span>
              {fold && <><span style={{ flex: 1 }} />
              <button aria-expanded={open} onClick={() => set(s => ({ segOpen: s.segOpen.includes(g.id) ? s.segOpen.filter(x => x !== g.id) : [...s.segOpen, g.id] }))} className="h-link" style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', flex: 'none' }}>
                {open ? 'Hide ▴' : `Show ${g.rows.length} ▾`}
              </button></>}
            </div>
            {open && (rows.length ? (
              <div role="table" aria-label={g.title} style={flexCol()}>
                <div role="row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: '0 16px', alignItems: 'center', paddingBottom: 8, borderBottom: '1px solid var(--rule)', ...eyebrow() }}>
                  <span role="columnheader" aria-label="Status" />
                  {(['Name', 'Kind', 'IP', 'Vendor', 'MAC', 'Last seen'] as const).map(h => {
                    const key = h === 'IP' ? 'ip' : h === 'Last seen' ? 'seen' : null, on = !!key && sort?.key === key;
                    return (
                      <span key={h} role="columnheader" aria-sort={on ? (sort!.dir === 1 ? 'ascending' : 'descending') : key ? 'none' : undefined} style={cell}>
                        {key ? <button type="button" onClick={() => setSort(cur => (cur?.key !== key ? { key, dir: 1 } : cur.dir === 1 ? { key, dir: -1 } : null))} className="h-link"
                          title={on && sort!.dir === -1 ? 'Back to problems first' : `Sort by ${h.toLowerCase()}`} style={{ color: on ? 'var(--text-2)' : undefined, letterSpacing: 'inherit', textTransform: 'inherit' }}>
                          {h}{on && <span aria-hidden="true"> {sort!.dir === 1 ? '▴' : '▾'}</span>}</button> : h}
                      </span>
                    );
                  })}
                </div>
                {rows.map(r => (
                  <div key={r.key} id={`dev-${r.key}`} role="row" style={{ display: 'grid', gridTemplateColumns: COLS, gap: '0 16px', alignItems: 'center', height: 44, borderBottom: '1px solid var(--rule-3)', scrollMarginTop: sm, fontSize: 13 }}>
                    <span role="cell" style={{ display: 'flex' }}><DevDot s={r.status} id={g.id} /></span>
                    <span role="cell" title={r.name} style={{ fontWeight: 600, ...cell }}><Hl text={r.name} q={q} /></span>
                    <span role="cell" title={kindOf(r) || undefined} style={{ fontSize: 12, color: 'var(--mut-1)', ...cell }}><Hl text={kindOf(r)} q={q} /></span>
                    <span role="cell" title={r.ip || undefined} style={mono(12, 'var(--text-2)', cell)}><Hl text={ipShown(r, q)} q={q} /></span>
                    <span role="cell" title={r.vendor || undefined} style={{ fontSize: 12, color: 'var(--mut-1)', ...cell }}><Hl text={r.vendor} q={q} /></span>
                    <span role="cell" title={r.mac || undefined} style={mono(11.5, 'var(--mut-1)', cell)}><Hl text={r.mac} q={q} /></span>
                    <span role="cell" style={{ fontSize: 12, color: r.status === 'up' ? 'var(--ok)' : r.status === 'degraded' ? 'var(--warn)' : r.status === 'unknown' ? 'var(--mut-3)' : 'var(--mut-1)', ...cell }}>
                      {r.status === 'up' ? 'online' : r.status === 'degraded' ? 'degraded' : r.lastActive != null ? ago(r.lastActive) : 'no data'}
                    </span>
                  </div>
                ))}
              </div>
            ) : <span style={{ padding: '12px 0', fontSize: 12, color: 'var(--mut-3)' }}>{g.rows.length ? 'Nothing offline' : 'None in the last 30 days'}</span>)}
            {lanFold && g.rows.length > lanRows(g.rows).length && (
              <button type="button" aria-expanded={ui.lanOpen} onClick={() => set(s => ({ lanOpen: !s.lanOpen }))} className="h-link"
                style={{ alignSelf: 'flex-start', padding: '10px 0 0', fontSize: 12, fontWeight: 600, color: 'var(--accent)' }}>
                {ui.lanOpen ? 'Show offline only ▴' : `Show all ${g.rows.length} ▾`}
              </button>
            )}
          </div>
        );
      })}
      {!groups.length && <span style={{ fontSize: 13, color: 'var(--mut-3)' }}>Nothing matches “{ui.deviceQuery}”</span>}
    </div>
  );
}
