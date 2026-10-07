// The Links tab's editor (desktop and phone): the site's only write. It loads the saved list (GET /api/links), edits a
// draft in the page (nothing is sent until Save), and replaces the whole list with PUT /api/links (server/links.ts).
// A 409 means another device saved meanwhile: the latest list is loaded instead.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '../state.tsx';
import { hueOf, monoSet, tint } from '../lib/util.ts';
import { SR, ellipsis, eyebrow, flexCol, row, ruled } from '../lib/ui.tsx';
import { LINK_LIMITS, groupNameProblem, itemNameProblem, linkView, urlProblem, validateLinks } from '../../shared/links.ts';
import { withoutServices } from '../lib/groups.ts';
import { openItems } from './Overview.tsx';
import type { LinkGroup, LinksDoc, Snapshot } from '../../shared/types.ts';

type DItem = { k: number; name: string; url: string };
type DGroup = { k: number; name: string; items: DItem[] };
type Msg = { tone: 'danger' | 'warn' | 'ok'; text: string };
let seq = 0;
const toDraft = (gs: LinkGroup[]): DGroup[] => gs.map(g => ({ k: ++seq, name: g.name, items: g.items.map(l => ({ k: ++seq, name: l.name, url: l.url })) }));
const fromDraft = (d: DGroup[]): LinkGroup[] => d.map(g => ({ name: g.name.trim(), items: g.items.map(l => ({ name: l.name.trim(), url: l.url.trim() })) }));
const swap = <T,>(a: T[], i: number, j: number) => { const b = [...a]; [b[i], b[j]] = [b[j], b[i]]; return b; };
/** A link's place: its category and its index there. As a drop target, `ii` counts the category's links without the
 *  one being moved (so dropping it where it was is the same index). */
type At = { gi: number; ii: number };
const placeItem = (d: DGroup[], from: At, to: At): DGroup[] => {
  const l = d[from.gi].items[from.ii];
  const out = d.map((g, i) => (i === from.gi ? { ...g, items: g.items.filter((_, j) => j !== from.ii) } : g));
  return out.map((g, i) => (i === to.gi ? { ...g, items: [...g.items.slice(0, to.ii), l, ...g.items.slice(to.ii)] } : g));
};
/** `to` counts the categories without the one being moved */
const placeGroup = (d: DGroup[], from: number, to: number): DGroup[] => { const rest = d.filter((_, i) => i !== from); return [...rest.slice(0, to), d[from], ...rest.slice(to)]; };
const whereItem = (d: DGroup[], k: number): At | null => { for (let gi = 0; gi < d.length; gi++) { const ii = d[gi].items.findIndex(l => l.k === k); if (ii >= 0) return { gi, ii }; } return null; };
/** the arrow to keep focus on after a move: the same one, or the other when the row reached an end (its own is disabled) */
const arrow = (to: number, n: number, by: number) => ((by < 0 ? to > 0 : to < n - 1) ? (by < 0 ? 'u' : 'd') : by < 0 ? 'd' : 'u');
const TONE = { danger: 'var(--danger)', warn: 'var(--warn)', ok: 'var(--ok)' };
export const CONFLICT = 'Links were changed on another device — reloaded the latest';

export type LinksEditor = ReturnType<typeof useLinksEditor>;
/** Editor state. `links` is what read mode shows: the snapshot's, or the list just saved until the snapshot carrying it arrives. */
export function useLinksEditor() {
  const { snap } = useApp();
  const [draft, setDraft] = useState<DGroup[] | null>(null);
  const [base, setBase] = useState<number | null>(null);
  const [busy, setBusy] = useState<'' | 'load' | 'save'>('');
  const [msg, setMsg] = useState<Msg | null>(null);
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState<{ at: number; links: Snapshot['links'] } | null>(null);
  const focus = useRef<string | null>(null);
  const els = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const el = focus.current && els.current.get(focus.current);
    if (el) { el.focus(); el.scrollIntoView({ block: 'nearest' }); focus.current = null; }
  });
  useEffect(() => { if (msg?.tone !== 'ok') return; const t = setTimeout(() => setMsg(null), 4000); return () => clearTimeout(t); }, [msg]);
  const load = (d: LinksDoc) => { setDraft(toDraft(d.groups)); setBase(d.updatedAt); setTried(false); };
  const shown = saved && (snap.linksMeta?.updatedAt ?? 0) < saved.at ? saved.links : snap.links;

  async function start() {
    setBusy('load'); setMsg(null);
    try {
      const r = await fetch('/api/links', { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 401 ? 'Signed out: reload the page and sign in.' : `The server answered ${r.status}.`);
      load(await r.json());
    } catch (e) { setMsg({ tone: 'danger', text: `Couldn't load the links. ${(e as Error).message}` }); }
    setBusy('');
  }
  async function save() {
    if (!draft) return;
    setTried(true);
    const v = validateLinks(fromDraft(draft));
    if (!v.ok) return; // shown live under the bar (and at each field) from now on
    setBusy('save'); setMsg(null);
    try {
      const r = await fetch('/api/links', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CC-Edit': '1' }, body: JSON.stringify({ groups: v.groups, baseUpdatedAt: base }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        setSaved({ at: j.updatedAt, links: v.groups.map(g => ({ group: g.name, items: g.items.map(l => linkView(l.name, l.url)) })) });
        setDraft(null); setTried(false); setMsg({ tone: 'ok', text: 'Saved' });
      } else if (r.status === 409 && j.current) { load(j.current); setMsg({ tone: 'warn', text: CONFLICT }); }
      else setMsg({ tone: 'danger', text: r.status === 401 ? 'Signed out: sign in again in another tab, then Save.' : j.error ?? `The server answered ${r.status}. Nothing was saved.` });
    } catch { setMsg({ tone: 'danger', text: 'No answer from the server. Nothing was saved; try again.' }); }
    setBusy('');
  }
  const cancel = () => { setDraft(null); setMsg(null); setTried(false); };
  const edit = (f: (d: DGroup[]) => DGroup[], then?: string) => {
    if (then) focus.current = then;
    if (msg?.tone === 'danger') setMsg(null); // a refusal is about the list as it was sent
    setDraft(d => (d ? f(d) : d));
  };
  const ops = {
    addGroup: () => { const k = ++seq; edit(d => [...d, { k, name: '', items: [] }], `g${k}`); },
    nameGroup: (gi: number, name: string) => edit(d => d.map((g, i) => (i === gi ? { ...g, name } : g))),
    moveGroup: (gi: number, by: -1 | 1) => edit(d => swap(d, gi, gi + by), `g${draft![gi].k}${arrow(gi + by, draft!.length, by)}`),
    delGroup: (gi: number) => {
      const g = draft![gi];
      if (g.items.length && !confirm(`Delete the category “${g.name || 'unnamed'}” and its ${g.items.length} link${g.items.length === 1 ? '' : 's'}?`)) return;
      edit(d => d.filter((_, i) => i !== gi), draft!.length > 1 ? `g${draft![gi ? gi - 1 : 1].k}` : 'add');
    },
    addItem: (gi: number) => { const k = ++seq; edit(d => d.map((g, i) => (i === gi ? { ...g, items: [...g.items, { k, name: '', url: '' }] } : g)), `l${k}`); },
    setItem: (gi: number, ii: number, p: Partial<DItem>) => edit(d => d.map((g, i) => (i === gi ? { ...g, items: g.items.map((l, j) => (j === ii ? { ...l, ...p } : l)) } : g))),
    moveItem: (gi: number, ii: number, by: -1 | 1) => edit(d => d.map((g, i) => (i === gi ? { ...g, items: swap(g.items, ii, ii + by) } : g)), `l${draft![gi].items[ii].k}${arrow(ii + by, draft![gi].items.length, by)}`),
    moveItemTo: (gi: number, ii: number, to: number) => {
      const l = draft![gi].items[ii];
      edit(d => d.map((g, i) => (i === gi ? { ...g, items: g.items.filter((_, j) => j !== ii) } : i === to ? { ...g, items: [...g.items, l] } : g)), `l${l.k}`);
    },
    delItem: (gi: number, ii: number) => edit(d => d.map((g, i) => (i === gi ? { ...g, items: g.items.filter((_, j) => j !== ii) } : g)), `a${draft![gi].k}`),
    /** drag to reorder (finding 22): only the draft changes, as with every other edit; `then` keeps focus on the handle */
    placeItem: (from: At, to: At, then: string) => edit(d => placeItem(d, from, to), then),
    placeGroup: (from: number, to: number, then: string) => edit(d => placeGroup(d, from, to), then),
    /** Escape after a keyboard move: the draft as it was when the link was picked up */
    restore: (d: DGroup[], then: string) => edit(() => d, then),
  };
  /** ref for an element focus can be sent to: g<k> group name, l<k> link name, a<k> add-link, `add`; u/d suffix = its
   *  arrows; h<k> / gh<k> a link's / category's drag handle */
  const ref = (id: string) => (el: HTMLElement | null) => { if (el) els.current.set(id, el); else els.current.delete(id); };
  return { draft, busy, msg, tried, shown, start, save, cancel, ops, ref };
}

// ---- look: the site's pill buttons and underlined inputs (no boxes)
const btn = (phone: boolean, extra: CSSProperties = {}): CSSProperties => ({
  minHeight: phone ? 44 : 30, boxSizing: 'border-box', padding: '0 12px', borderRadius: phone ? 12 : 8, border: '1px solid var(--pill-bd)', color: 'var(--mut-1)',
  fontSize: phone ? 13 : 12, fontWeight: 600, whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', ...extra,
});
const icon = (phone: boolean, extra: CSSProperties = {}) => btn(phone, { width: phone ? 44 : 30, padding: 0, fontSize: phone ? 16 : 13, ...extra });
const input = (phone: boolean, extra: CSSProperties = {}): CSSProperties => ({
  width: '100%', minWidth: 0, boxSizing: 'border-box', background: 'transparent', border: 0, borderBottom: '1px solid var(--rule)', borderRadius: 0, outline: 'none',
  color: 'var(--text)', font: `500 ${phone ? 16 : 14}px var(--font-ui)`, padding: phone ? '10px 0' : '6px 0', ...extra,
});
const off = (on: boolean): CSSProperties => (on ? {} : { opacity: 0.35, cursor: 'default' });
const Err = ({ id, children }: { id: string; children: ReactNode }) => <span id={id} role="alert" style={{ fontSize: 12, color: 'var(--danger)' }}>{children}</span>;

export function EditButton({ ed, phone = false }: { ed: LinksEditor; phone?: boolean }) {
  return ed.draft ? null : (
    <button type="button" className="h-ghost" onClick={ed.start} disabled={!!ed.busy} aria-label="Edit links" style={btn(phone, { color: 'var(--accent)', ...off(!ed.busy) })}>
      {ed.busy === 'load' ? 'Loading…' : 'Edit links'}
    </button>
  );
}
/** The line under the header: the last result (saved / couldn't load) and the quiet note when links.json was unreadable. */
export function LinksNote({ ed }: { ed: LinksEditor }) {
  const { snap } = useApp();
  const err = snap.linksMeta?.error;
  if (ed.draft || (!ed.msg && !err)) return null;
  return (
    <div style={flexCol(4, { fontSize: 12, lineHeight: 1.4 })}>
      {ed.msg && <span role="status" style={{ color: TONE[ed.msg.tone] }}>{ed.msg.text}</span>}
      {err && <span style={{ color: 'var(--mut-3)' }}>{err}</span>}
    </div>
  );
}

// ---- drag to reorder (review finding 22): pointer events (mouse and touch, no dependency) on a 6-dot handle, or the
// keyboard on a focused handle (Space picks up, ↑/↓ move, Space drops, Escape cancels). Nothing is sent until Save.
type Drag = { kind: 'item' | 'group'; k: number } & (
  | { how: 'pointer'; y0: number; s0: number; y: number; to: At | number | null; line: { top: number; left: number; width: number } | null }
  | { how: 'keys'; orig: DGroup[] });
const gName = (g: DGroup, gi: number) => g.name.trim() || `category ${gi + 1}`;
const lName = (l: DItem, ii: number) => l.name.trim() || `link ${ii + 1}`;

function useReorder(ed: LinksEditor, phone: boolean) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [say, setSay] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const live = useRef(drag);
  live.current = drag;
  const d = ed.draft!;
  /** the editor's zoom (the desktop layout is scaled with CSS zoom; the phone's is 1) */
  const scale = () => { const b = box.current!; return b.getBoundingClientRect().height / b.offsetHeight || 1; };
  /** where a drop at y lands, and the insertion line for it (in the editor's own coordinates) */
  const hit = (kind: Drag['kind'], k: number, y: number): Pick<Extract<Drag, { how: 'pointer' }>, 'to' | 'line'> => {
    const b = box.current!.getBoundingClientRect(), sc = scale();
    const line = (at: number, el: Element) => { const r = el.getBoundingClientRect(); return { top: (at - b.top) / sc - 1, left: (r.left - b.left) / sc, width: r.width / sc }; };
    const secs = [...box.current!.querySelectorAll<HTMLElement>('[data-drag-sec]')];
    const mid = (el: Element) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2; };
    if (kind === 'group') {
      const others = secs.filter(el => el.dataset.dragSec !== String(k));
      if (!others.length) return { to: null, line: null };
      const to = others.filter(el => mid(el) < y).length, R = (i: number) => others[i].getBoundingClientRect();
      const at = to === 0 ? R(0).top - 4 : to === others.length ? R(to - 1).bottom + 4 : (R(to - 1).bottom + R(to).top) / 2;
      return { to, line: line(at, others[Math.min(to, others.length - 1)]) };
    }
    if (!secs.length) return { to: null, line: null };
    let si = secs.findIndex(el => y < el.getBoundingClientRect().bottom);
    if (si < 0) si = secs.length - 1;
    const sec = secs[si], gi = d.findIndex(g => String(g.k) === sec.dataset.dragSec);
    const rows = [...sec.querySelectorAll<HTMLElement>('[data-drag-row]')].filter(el => el.dataset.dragRow !== String(k));
    const ii = rows.filter(el => mid(el) < y).length, R = (i: number) => rows[i].getBoundingClientRect();
    const empty = sec.querySelector('[data-drag-empty]');
    const at = !rows.length ? (empty ? mid(empty) : sec.getBoundingClientRect().bottom - 4) : ii === 0 ? R(0).top - 2 : ii === rows.length ? R(ii - 1).bottom + 2 : (R(ii - 1).bottom + R(ii).top) / 2;
    return { to: { gi, ii }, line: line(at, sec) };
  };
  const end = (msg?: string) => { setDrag(null); if (msg) setSay(msg); };
  const where = (kind: Drag['kind'], k: number, dd = d) => {
    if (kind === 'group') { const gi = dd.findIndex(g => g.k === k); return { name: gName(dd[gi], gi), text: `position ${gi + 1}` }; }
    const at = whereItem(dd, k)!;
    return { name: lName(dd[at.gi].items[at.ii], at.ii), text: `position ${at.ii + 1} in ${gName(dd[at.gi], at.gi)}` };
  };
  const then = (kind: Drag['kind'], k: number) => (kind === 'group' ? `gh${k}` : `h${k}`);
  /** the move from the current draft to `to`, announced; false when it lands where it was */
  const commit = (kind: Drag['kind'], k: number, to: At | number | null) => {
    if (to == null) return false;
    if (kind === 'group') {
      const from = d.findIndex(g => g.k === k);
      if (from < 0 || to === from) return false;
      ed.ops.placeGroup(from, to as number, then(kind, k));
      setSay(`Moved ${gName(d[from], from)} to position ${(to as number) + 1}`);
    } else {
      const from = whereItem(d, k), t = to as At;
      if (!from || (from.gi === t.gi && from.ii === t.ii)) return false;
      ed.ops.placeItem(from, t, then(kind, k));
      setSay(`Moved ${lName(d[from.gi].items[from.ii], from.ii)} to position ${t.ii + 1} in ${gName(d[t.gi], t.gi)}`);
    }
    return true;
  };

  // pointer drags: Escape cancels; near the window's edges the page scrolls (the phone's edges clear the tab bar)
  useEffect(() => {
    if (drag?.how !== 'pointer') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); end('Move cancelled'); } };
    let raf = 0;
    const tick = () => {
      const c = live.current;
      if (c?.how === 'pointer') {
        const top = phone ? 110 : 100, bottom = innerHeight - (phone ? 140 : 60);
        const v = c.y < top ? (c.y - top) / 5 : c.y > bottom ? (c.y - bottom) / 5 : 0;
        if (v) { scrollBy(0, Math.max(-20, Math.min(20, v))); setDrag(x => (x?.how === 'pointer' ? { ...x, ...hit(x.kind, x.k, x.y) } : x)); }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    addEventListener('keydown', onKey);
    return () => { cancelAnimationFrame(raf); removeEventListener('keydown', onKey); };
  }, [drag?.how, phone]);

  /** props for a handle: pointer and keyboard */
  const handle = (kind: Drag['kind'], k: number, label: string) => ({
    'aria-label': `Reorder ${label}`, 'aria-roledescription': 'drag handle', 'aria-pressed': drag?.how === 'keys' && drag.k === k && drag.kind === kind,
    title: 'Drag to reorder, or press Space, then ↑ / ↓, then Space',
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0 || ed.busy) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus({ preventScroll: true });
      setDrag({ kind, k, how: 'pointer', y0: e.clientY, s0: scrollY, y: e.clientY, to: null, line: null });
    },
    onPointerMove: (e: React.PointerEvent<HTMLButtonElement>) => {
      const y = e.clientY;
      setDrag(x => (x?.how === 'pointer' && x.k === k ? { ...x, y, ...hit(kind, k, y) } : x));
    },
    onPointerUp: () => { const c = live.current; if (c?.how !== 'pointer' || c.k !== k) return; end(); commit(kind, k, c.to); },
    onPointerCancel: () => { if (live.current?.how === 'pointer') end('Move cancelled'); },
    onKeyDown: (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const c = live.current, mine = c?.how === 'keys' && c.k === k && c.kind === kind;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (mine) { const w = where(kind, k); end(`Dropped ${w.name} at ${w.text}`); }
        else { const w = where(kind, k); setDrag({ kind, k, how: 'keys', orig: d }); setSay(`Picked up ${w.name}, ${w.text}. Arrow keys move it, Space drops it, Escape cancels.`); }
      } else if (mine && e.key === 'Escape') {
        e.preventDefault();
        const orig = (c as Extract<Drag, { how: 'keys' }>).orig;
        ed.ops.restore(orig, then(kind, k));
        const w = where(kind, k, orig); end(`Move cancelled. ${w.name} is back at ${w.text}`);
      } else if (mine && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const up = e.key === 'ArrowUp';
        if (kind === 'group') {
          const gi = d.findIndex(g => g.k === k), to = up ? gi - 1 : gi + 1;
          if (to >= 0 && to < d.length) commit(kind, k, to);
        } else {
          // past the ends of its category it moves into the next one (the end of the one above, the top of the one below)
          const at = whereItem(d, k)!, n = d[at.gi].items.length;
          const to = up ? (at.ii > 0 ? { gi: at.gi, ii: at.ii - 1 } : at.gi > 0 ? { gi: at.gi - 1, ii: d[at.gi - 1].items.length } : null)
            : at.ii < n - 1 ? { gi: at.gi, ii: at.ii + 1 } : at.gi < d.length - 1 ? { gi: at.gi + 1, ii: 0 } : null;
          if (to) commit(kind, k, to);
        }
      }
    },
    // focus leaving the handle drops the link where it is; a move re-mounts the handle and refocuses it, so wait a tick
    'data-handle': `${kind}${k}`,
    onBlur: () => setTimeout(() => {
      const c = live.current;
      if (c?.how === 'keys' && c.k === k && c.kind === kind && (document.activeElement as HTMLElement | null)?.dataset?.handle !== `${kind}${k}`) end();
    }),
  });
  /** the lifted look for the row or category being moved; a pointer drag also follows the pointer */
  const lifted = (kind: Drag['kind'], k: number): CSSProperties => {
    if (!drag || drag.kind !== kind || drag.k !== k) return {};
    const dy = drag.how === 'pointer' ? (drag.y - drag.y0 + scrollY - drag.s0) / scale() : 0;
    // the tint bleeds 8px past the row (margin and padding cancel out, so nothing moves)
    return { position: 'relative', zIndex: 6, background: 'var(--hover)', boxShadow: 'var(--lift-shadow)', borderRadius: 8, margin: '0 -8px', paddingLeft: 8, paddingRight: 8, transform: dy ? `translateY(${dy}px)` : undefined };
  };
  const line = drag?.how === 'pointer' ? drag.line : null;
  return { box, say, handle, lifted, line, dragging: drag?.how === 'pointer' ? drag.k : null };
}

/** the 6-dot handle at the left of every link row and category heading (44px hit area on the phone) */
const Handle = ({ phone, grabbing, ...p }: { phone: boolean; grabbing: boolean; disabled: boolean } & ReturnType<ReturnType<typeof useReorder>['handle']> & { ref?: (el: HTMLElement | null) => void }) => (
  <button type="button" {...p} style={{ width: phone ? 44 : 22, height: phone ? 44 : 30, flex: 'none', display: 'grid', placeItems: 'center', borderRadius: 8, fontSize: 16, lineHeight: 1, color: 'var(--mut-3)', cursor: grabbing ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none', ...off(!p.disabled) }}>⠿</button>
);

export function LinksEditorView({ ed, phone = false }: { ed: LinksEditor; phone?: boolean }) {
  const { snap } = useApp();
  const d = ed.draft!, o = ed.ops, saving = ed.busy === 'save', s = !saving;
  const rd = useReorder(ed, phone);
  const names = d.map(g => g.name.trim().toLowerCase());
  const total = d.reduce((a, g) => a + g.items.length, 0);
  // the same unique monograms as the Bookmarks section: the links it shows claim theirs first, then the rest of the
  // draft (the ones Open already shows, new ones) take what's left, still unique
  const visible = withoutServices(ed.shown, openItems(snap).map(u => u.url)).groups.flatMap(g => g.items.map(l => l.name));
  const monos = monoSet([...visible, ...d.flatMap(g => g.items.map(l => l.name))]);
  const label = (g: DGroup, gi: number) => g.name.trim() || `category ${gi + 1}`;
  const gErr = (g: DGroup, gi: number) => ed.tried && (groupNameProblem(g.name.trim()) ?? (names.indexOf(g.name.trim().toLowerCase()) !== gi ? 'another category already has this name' : null));
  // after a Save attempt the first problem stays in the bar, live, until it's fixed; the limits always show
  const check = ed.tried ? validateLinks(fromDraft(d)) : null;
  const over = check && !check.ok ? check.error
    : total > LINK_LIMITS.items ? `${total} links: at most ${LINK_LIMITS.items}` : d.length > LINK_LIMITS.groups ? `${d.length} categories: at most ${LINK_LIMITS.groups}` : null;
  return (
    <div ref={rd.box} style={flexCol(phone ? 18 : 22, { position: 'relative' })}>
      <div aria-live="assertive" style={SR}>{rd.say}</div>
      {rd.line && <div aria-hidden="true" style={{ position: 'absolute', zIndex: 7, height: 2, borderRadius: 1, background: 'var(--accent)', pointerEvents: 'none', ...rd.line }} />}
      <div style={{
        position: 'sticky', top: 0, zIndex: 5, margin: phone ? '0 -20px' : '0 -12px', padding: phone ? '10px 20px' : '10px 12px', background: 'var(--bg)',
        borderBottom: '1px solid var(--rule)', ...flexCol(8),
      }}>
        <div style={row(10, { flexWrap: 'wrap' })}>
          <span style={{ ...eyebrow('var(--accent)'), flex: 'none' }}>Editing links</span>
          <span style={{ fontSize: 12, color: 'var(--mut-3)', flex: 1, minWidth: 0, ...ellipsis }}>{total} links · {d.length} categories · nothing is saved until Save</span>
          <div style={row(8, { marginLeft: 'auto' })}>
            <button type="button" className="h-ghost" onClick={ed.cancel} disabled={saving} style={btn(phone, off(s))}>Cancel</button>
            <button type="button" onClick={ed.save} disabled={saving} style={btn(phone, { background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--on-accent)', fontWeight: 700, minWidth: 64, ...off(s) })}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
        {ed.msg && <span role="alert" style={{ fontSize: 12, lineHeight: 1.4, color: TONE[ed.msg.tone] }}>{ed.msg.text}</span>}
        {over && <span role="alert" style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--danger)' }}>{over}</span>}
        {snap.linksMeta?.error && <span style={{ fontSize: 12, color: 'var(--mut-3)' }}>{snap.linksMeta.error}</span>}
      </div>
      {d.map((g, gi) => {
        const ge = gErr(g, gi), gl = label(g, gi);
        return (
          <section key={g.k} data-drag-sec={g.k} aria-label={`Category ${gl}`} style={{ ...ruled(phone ? '12px 0 4px' : '14px 0 6px', 'var(--rule)', flexCol(phone ? 8 : 6)), ...rd.lifted('group', g.k) }}>
            <div style={row(8, { flexWrap: phone ? 'wrap' : undefined })}>
              <Handle ref={ed.ref(`gh${g.k}`)} phone={phone} grabbing={rd.dragging === g.k} disabled={saving} {...rd.handle('group', g.k, `category ${gl}`)} />
              <div style={flexCol(2, { flex: phone ? '1 1 calc(100% - 52px)' : '0 1 360px', minWidth: 0 })}>
                <input ref={ed.ref(`g${g.k}`)} value={g.name} onChange={e => o.nameGroup(gi, e.target.value)} disabled={saving} placeholder="Category name" maxLength={LINK_LIMITS.groupName + 20}
                  aria-label={`Name of category ${gi + 1}`} aria-invalid={!!ge} aria-describedby={ge ? `ge${g.k}` : undefined}
                  style={input(phone, { fontWeight: 700, letterSpacing: '.02em', ...(ge ? { borderBottomColor: 'var(--danger)' } : {}) })} />
                {ge && <Err id={`ge${g.k}`}>{ge}</Err>}
              </div>
              <button type="button" ref={ed.ref(`g${g.k}u`)} className="h-ghost" onClick={() => o.moveGroup(gi, -1)} disabled={saving || gi === 0} aria-label={`Move category ${gl} up`} title="Move category up" style={icon(phone, off(s && gi > 0))}>↑</button>
              <button type="button" ref={ed.ref(`g${g.k}d`)} className="h-ghost" onClick={() => o.moveGroup(gi, 1)} disabled={saving || gi === d.length - 1} aria-label={`Move category ${gl} down`} title="Move category down" style={icon(phone, off(s && gi < d.length - 1))}>↓</button>
              {!phone && <span style={{ flex: 1 }} />}
              <button type="button" ref={ed.ref(`a${g.k}`)} className="h-ghost" onClick={() => o.addItem(gi)} disabled={saving} aria-label={`Add a link to ${gl}`} style={btn(phone, { color: 'var(--accent)', ...off(s) })}>+ Add link</button>
              <button type="button" className="h-ghost" onClick={() => o.delGroup(gi)} disabled={saving} aria-label={`Delete category ${gl}`} style={btn(phone, { color: 'var(--danger)', ...off(s) })}>Delete category</button>
            </div>
            {!g.items.length && <span data-drag-empty style={{ fontSize: 12, color: 'var(--mut-3)', padding: '4px 0' }}>No links yet</span>}
            {g.items.map((l, ii) => {
              const ne = ed.tried && itemNameProblem(l.name.trim()), ue = ed.tried && urlProblem(l.url.trim()), ll = l.name.trim() || `link ${ii + 1}`;
              const name = (
                <div style={flexCol(2, { flex: phone ? undefined : '1 1 0', minWidth: 0 })}>
                  <input ref={ed.ref(`l${l.k}`)} value={l.name} onChange={e => o.setItem(gi, ii, { name: e.target.value })} disabled={saving} placeholder="Name" maxLength={LINK_LIMITS.itemName + 20}
                    aria-label={`Name of link ${ii + 1} in ${gl}`} aria-invalid={!!ne} aria-describedby={ne ? `ne${l.k}` : undefined} style={input(phone, ne ? { borderBottomColor: 'var(--danger)' } : {})} />
                  {ne && <Err id={`ne${l.k}`}>{ne}</Err>}
                </div>
              );
              const url = (
                <div style={flexCol(2, { flex: phone ? undefined : '1.6 1 0', minWidth: 0 })}>
                  <input value={l.url} onChange={e => o.setItem(gi, ii, { url: e.target.value })} disabled={saving} placeholder="example.com or https://…" maxLength={LINK_LIMITS.url + 20}
                    type="url" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
                    aria-label={`URL of ${ll} in ${gl}`} aria-invalid={!!ue} aria-describedby={ue ? `ue${l.k}` : undefined}
                    style={input(phone, { fontFamily: 'var(--font-mono)', fontSize: phone ? 16 : 13, ...(ue ? { borderBottomColor: 'var(--danger)' } : {}) })} />
                  {ue && <Err id={`ue${l.k}`}>{ue}</Err>}
                </div>
              );
              const tools = (
                <div style={row(phone ? 8 : 6, { flex: 'none', ...(phone ? { width: '100%' } : {}) })}>
                  <button type="button" ref={ed.ref(`l${l.k}u`)} className="h-ghost" onClick={() => o.moveItem(gi, ii, -1)} disabled={saving || ii === 0} aria-label={`Move ${ll} up`} title="Move up" style={icon(phone, off(s && ii > 0))}>↑</button>
                  <button type="button" ref={ed.ref(`l${l.k}d`)} className="h-ghost" onClick={() => o.moveItem(gi, ii, 1)} disabled={saving || ii === g.items.length - 1} aria-label={`Move ${ll} down`} title="Move down" style={icon(phone, off(s && ii < g.items.length - 1))}>↓</button>
                  <select value="" onChange={e => e.target.value !== '' && o.moveItemTo(gi, ii, Number(e.target.value))} disabled={saving || d.length < 2} aria-label={`Move ${ll} to another category`}
                    style={{ ...btn(phone, { padding: '0 8px', background: 'var(--inset)', color: 'var(--text-2)', font: `500 ${phone ? 14 : 12}px var(--font-ui)`, cursor: 'pointer' }), ...(phone ? { flex: '1 1 0', minWidth: 0 } : { width: 150 }), ...off(s && d.length > 1) }}>
                    <option value="">Move to…</option>
                    {d.map((t, ti) => (ti === gi ? null : <option key={t.k} value={ti}>{label(t, ti)}</option>))}
                  </select>
                  <button type="button" className="h-ghost" onClick={() => o.delItem(gi, ii)} disabled={saving} aria-label={`Delete ${ll}`} title="Delete link" style={icon(phone, { color: 'var(--danger)', fontSize: phone ? 20 : 17, ...off(s) })}>×</button>
                </div>
              );
              const grip = <Handle ref={ed.ref(`h${l.k}`)} phone={phone} grabbing={rd.dragging === l.k} disabled={saving} {...rd.handle('item', l.k, `${ll} in ${gl}`)} />;
              return phone ? (
                <div key={l.k} data-drag-row={l.k} role="group" aria-label={ll} style={row(8, { alignItems: 'flex-start', padding: '8px 0 12px', borderBottom: '1px solid var(--rule-3)', ...rd.lifted('item', l.k) })}>
                  {grip}<div style={flexCol(6, { flex: 1, minWidth: 0 })}>{name}{url}{tools}</div>
                </div>
              ) : (
                <div key={l.k} data-drag-row={l.k} role="group" aria-label={ll} style={row(14, { alignItems: 'flex-start', padding: '4px 0', ...rd.lifted('item', l.k) })}>
                  {grip}
                  <span aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 9, ...tint(hueOf(l.name, 41)), display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, flex: 'none' }}>{monos.get(l.name) ?? '?'}</span>
                  {name}{url}{tools}
                </div>
              );
            })}
          </section>
        );
      })}
      <button type="button" ref={ed.ref('add')} className="h-ghost" onClick={o.addGroup} disabled={saving} style={btn(phone, { alignSelf: 'flex-start', color: 'var(--accent)', ...off(s) })}>+ Add category</button>
    </div>
  );
}
