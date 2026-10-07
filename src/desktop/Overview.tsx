import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useApp, type Selection, type Tab } from '../state.tsx';
import { NetworkMap } from './NetworkMap.tsx';
import { GUEST_HUE, STATUS_WORD, ago, agoText, aged, fmt, fmtBytes, fullIp, hueOf, last, monoClashes, monoOf, pveUrl, scaleMax, scrollToId, secSince, sevColors, statusColor, statusText, tint, uiUrl, whenText, whyMissing } from '../lib/util.ts';
import { diskTone, memTone, ratioPct } from '../../shared/rules.ts';
import { Bar, Chip, CountLink, Dot, Ext, MaybeLink, NotConnected, Spark, StatusDot, Tag, ellipsis, eyebrow, flexCol, mono, row, ruled } from '../lib/ui.tsx';
import { aliasOf, matches, serviceOf, shortUrl } from '../lib/search.ts';
import { SERIES_LEN, type Attention, type GuestView, type HostView, type Kpi, type Res, type Snapshot, type Status } from '../../shared/types.ts';
import { UpdatesLine } from './Ops.tsx';
import { Roll } from '../lib/motion.tsx';
import { needsYou, uiLabel } from '../lib/incident.ts';
import { displayName, groupKey, hiddenInOpen } from '../lib/groups.ts';
import { on } from '../lib/modules.ts';
import { FailTrace, useTrace } from './Trace.tsx';

export { needsYou };

/** Today's Overview before review Phase 5 (KPIs, map + side panel, launcher), kept at ?overview=classic until the owner says
 *  to remove it. */
export function ClassicOverview() {
  return (
    <div style={flexCol(20)}>
      <Kpis />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 380px', gap: 40 }}>
        <NetworkMap />
        <SidePanel />
      </div>
      <Launcher />
    </div>
  );
}

const kpiColor = (t?: Kpi['tone']) => (t === 'pub' ? 'var(--pub-fg)' : t === 'danger' ? 'var(--danger)' : t === 'warn' ? 'var(--warn)' : 'var(--text)');
/** Inventory counts follow the health KPIs, smaller and without a sub-line (it's in the tooltip). */
const INVENTORY = new Set(['containers', 'array', 'lan']);
/** Where a count is explained (review finding 12): Health's section or the Devices tab. */
const KPI_TARGET: Record<string, { tab: Tab; anchor?: string; what: string }> = {
  uis: { tab: 'Health', anchor: 'health-uptime', what: 'Service uptime on Health' },
  public: { tab: 'Health', anchor: 'health-exposure', what: 'Public exposure on Health' },
  lan: { tab: 'Health', anchor: 'health-devices', what: 'Devices on Health' },
};
function Kpis() {
  const { snap, set } = useApp();
  const health = snap.kpis.filter(k => !INVENTORY.has(k.id)), inv = snap.kpis.filter(k => INVENTORY.has(k.id));
  /** the KPI's content, as a link to its target when it has one */
  const body = (k: Kpi, gap: number, children: ReactNode) => {
    const t = KPI_TARGET[k.id];
    if (!t) return children;
    const go = () => { set({ dTab: t.tab, mTab: t.tab, selection: null }); if (t.anchor) scrollToId(t.anchor, 60); else scrollTo(0, 0); };
    return <CountLink onClick={go} gap={gap} label={`${k.label} ${k.value}: open ${t.what}`} title={k.sub || undefined}>{children}</CountLink>;
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${health.length},minmax(0,1.15fr)) repeat(${inv.length},minmax(0,.85fr))`, gap: 24 }}>
      {health.map(k => {
        const red = k.tone === 'danger';
        return (
          <div key={k.id} style={ruled('12px 0 12px', red ? 'var(--danger-rule)' : 'var(--rule)', flexCol(3, { transition: 'border-color .4s' }))}>
            {body(k, 3, <>
              <span style={{ ...eyebrow(red ? 'var(--danger)' : 'var(--mut-3)'), transition: 'color .4s' }}>{k.label}</span>
              <span style={mono(22, kpiColor(k.tone), { fontWeight: 500, transition: 'color .4s' })}><Roll v={k.value} /></span>
              <span style={{ fontSize: 11, color: red ? 'var(--danger-sub)' : 'var(--mut-3)', transition: 'color .4s', ...ellipsis }} title={k.sub || undefined}>{k.sub || '\u00a0'}</span>
            </>)}
          </div>
        );
      })}
      {inv.map(k => (
        <div key={k.id} title={k.sub || undefined} style={ruled('12px 0 12px', 'var(--rule-2)', flexCol(5))}>
          {body(k, 5, <>
            <span style={eyebrow()}>{k.label}</span>
            {/* a toned count (array filling up, containers partly counted) keeps its colour */}
            <span style={mono(16, k.tone ? kpiColor(k.tone) : 'var(--text-2)', { fontWeight: 500, transition: 'color .4s' })}><Roll v={k.value} /></span>
          </>)}
        </div>
      ))}
    </div>
  );
}

/** Header colours for an attention list: red with any danger item, amber with any warn item, neutral when only info notes remain. */
export const attnHeader = (items: Attention[]) => sevColors(items.some(a => a.severity === 'danger') ? 'danger' : items.some(a => a.severity === 'warn') ? 'warn' : 'none');

const Close = ({ onClick }: { onClick: () => void }) => (
  <button onClick={onClick} aria-label="Clear selection" style={{ width: 28, height: 28, borderRadius: 8, border: '1px solid var(--rule)', display: 'grid', placeItems: 'center', color: 'var(--mut-3)', fontSize: 14, flex: 'none' }}>✕</button>
);
const OpenBtn = ({ href, label }: { href: string; label: string }) => (
  <a className="h-accent" href={href} target="_blank" rel="noopener noreferrer" aria-label={label} title={href}
    style={{ height: 28, padding: '0 10px', borderRadius: 8, border: '1px solid var(--rule)', display: 'grid', placeItems: 'center', color: 'var(--text-2)', fontSize: 12, fontWeight: 600, flex: 'none', transition: 'all .15s' }}>Open ↗</a>
);
/** Bar colours follow the Needs attention rules (shared/rules.ts): disk amber/red like the disk items, memory and swap
 *  amber only under memory pressure (or a host at 90 %+), never red; anything else is the neutral accent. */
export const TONE_BAR = { ok: 'var(--accent)', warn: 'var(--warn)', danger: 'var(--danger)' } as const;
export function resRows(res: Res, host: boolean, cpu: boolean) {
  const rows: [string, number | null, string | null, string][] = [];
  if (cpu) rows.push(['CPU', res.cpuPct, res.cpuPct == null ? '—' : null, TONE_BAR.ok]);
  // a metric this host doesn't have at all (e.g. Unraid's root disk; the array is under Health → Storage) is left out
  const add = (k: string, u: number | null, t: number | null, c: string) => { if (u != null || t != null) rows.push([k, ratioPct(u, t), `${fmtBytes(u)} / ${fmtBytes(t)}`, c]); };
  const mem = TONE_BAR[memTone(res, host)];
  add('Memory', res.memUsed, res.memTotal, mem);
  if (res.swapTotal) add('Swap', res.swapUsed, res.swapTotal, mem);
  add('Disk', res.diskUsed, res.diskTotal, TONE_BAR[diskTone(res.diskUsed, res.diskTotal)]);
  return rows;
}

/** CPU / memory / swap / disk bars, uptime and load. Nulls read '—' (never a guess). */
function Resources({ res, cpu = true, host = false }: { res: Res | null; cpu?: boolean; host?: boolean }) {
  if (!res) return <span style={{ fontSize: 12, color: 'var(--mut-3)' }}>No resource data from Proxmox or node_exporter</span>;
  const rows = resRows(res, host, cpu);
  return (
    <div style={flexCol(10)}>
      {rows.map(([k, p, txt, color]) => (
        <div key={k} style={flexCol(5)}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={eyebrow()}>{k}</span><span style={{ flex: 1 }} />
            {txt && <span style={mono(11.5, 'var(--text-2)')}>{txt}</span>}
            {p != null && <span style={mono(11.5, 'var(--mut-3)', { width: 36, textAlign: 'right' })}>{Math.floor(p)}%</span>}
          </div>
          <Bar pct={p} color={color} height={5} />
        </div>
      ))}
      <div style={row(16, { fontSize: 12, color: 'var(--mut-3)' })}>
        <span>Up <span style={mono(12, 'var(--text-2)')}>{agoText(res.uptimeSec)}</span></span>
        {res.load1 != null && <span>Load <span style={mono(12, 'var(--text-2)')}>{res.load1.toFixed(2)}</span></span>}
      </div>
    </div>
  );
}

function SidePanel() {
  const { ui, guestById, hostById } = useApp();
  const sel = ui.selection;
  const g = sel?.kind === 'guest' ? guestById(sel.id) : undefined;
  const h = sel?.kind === 'host' ? hostById(sel.id) : undefined;
  // keyed per selection so React never reuses one panel's rows for another's (a stray row survived that once);
  // the problems stay in view above it
  if (g || h) return (
    <div style={flexCol(12)}>
      <AttentionCompact />
      {g ? <GuestPanel key={`g-${g.id}`} g={g} /> : h && <HostPanel key={`h-${h.id}`} h={h} />}
    </div>
  );
  return (
    <div key="none" style={flexCol(12)}>
      <AttentionList />
      <Spotlight />
      <Activity />
      <PlexBlock />
    </div>
  );
}

/** ' · 7 min' since a web UI went down (its Needs attention item counts on), '' when the start isn't known. */
const downAge = (snap: Snapshot, name: string) => {
  const since = snap.attention.find(a => a.id === `down-${name}`)?.since;
  return since != null ? ` · ${agoText(secSince(since))}` : '';
};

export function GuestPanel({ g }: { g: GuestView }) {
  const { snap, select, hostById } = useApp();
  const host = hostById(g.host);
  const uiOf = (name: string) => snap.uis.find(u => u.name === name);
  // 'n of m up' counts the UIs a monitor watches, like the Web UIs KPI (an unmonitored one has a hollow dot)
  const watched = g.ui.filter(u => uiOf(u.name)?.monitored), uiDown = watched.filter(u => uiOf(u.name)?.status === 'down').length;
  const pve = pveUrl(host?.url, g);
  return (
    <div style={flexCol(12)}>
      <div style={ruled('20px 0 20px', 'var(--rule)', flexCol(16))}>
        <div style={row(12)}>
          <div style={{ minWidth: 38, height: 38, padding: '0 6px', boxSizing: 'border-box', borderRadius: 10, ...tint(GUEST_HUE[g.kind]), display: 'grid', placeItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }}>{g.vmid}</div>
          <div style={{ flex: 1, minWidth: 0, ...flexCol() }}>
            <span style={row(8, { fontSize: 16, fontWeight: 700 })}><span style={ellipsis}>{g.name}</span><StatusDot status={g.status} /></span>
            <span style={mono(11, 'var(--mut-3)', ellipsis)}>{g.ip ? fullIp(g.ip) : 'no IP in inventory'} · on {host?.name ?? g.host}</span>
          </div>
          {pve && <OpenBtn href={pve} label={`Open ${g.name} in Proxmox`} />}
          <Close onClick={() => select(null)} />
        </div>
        {(g.undocumented || g.missing) && (
          <div style={row(8, { flexWrap: 'wrap', fontSize: 12, color: 'var(--mut-3)' })}>
            {g.undocumented && <><Tag color="var(--warn)">undocumented</Tag><span>in Proxmox, not in homelab.json</span></>}
            {g.missing && <><Tag color="var(--warn)">not in Proxmox</Tag><span>in homelab.json, Proxmox doesn't list it</span></>}
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          <div style={flexCol(2)}><span style={mono(18)}>{g.containers ?? '—'}</span><span style={{ fontSize: 11, color: 'var(--mut-3)' }}>{g.containers != null ? 'Containers' : g.kind === 'vm' ? 'VM' : 'No container data'}</span></div>
          <div style={flexCol(2)}><span style={{ fontSize: 13, fontWeight: 600, paddingTop: 3, ...ellipsis }} title={g.type}>{g.type}</span><span style={{ fontSize: 11, color: 'var(--mut-3)' }}>Type</span></div>
          <div style={flexCol(2)}><span style={{ fontSize: 13, fontWeight: 600, paddingTop: 3, color: statusText(g.status) }}>{STATUS_WORD[g.status]}</span><span style={{ fontSize: 11, color: 'var(--mut-3)' }}>Status</span></div>
        </div>
        <Resources res={g.res} />
        {g.updates && <div style={row(10)}><span style={eyebrow()}>Updates</span><UpdatesLine u={g.updates} /></div>}
        {g.services.length > 0 && <div style={flexCol(8)}><span style={eyebrow()}>Services <span style={{ color: 'var(--mut-3)', letterSpacing: '.06em' }}>· from inventory</span></span><div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{g.services.map(s => <Chip key={s}>{s}</Chip>)}</div></div>}
        {g.ui.length > 0 && (
          <div style={flexCol(2)}>
            <span style={{ ...eyebrow(), paddingBottom: 6 }}>Web UIs · {uiDown ? `${watched.length - uiDown} of ${watched.length} up` : g.ui.length}</span>
            {g.ui.map(u => {
              const url = u.url, w = uiOf(u.name), down = w?.status === 'down';
              return (
                <a key={u.name} className="h-inset" href={url} target="_blank" rel="noopener noreferrer" title={url} style={row(8, { padding: '7px 8px', borderRadius: 8, color: 'var(--text)', ...(down ? { background: 'var(--danger-a07)' } : {}) })}>
                  <StatusDot status={w?.status ?? 'unknown'} monitored={!!w?.monitored} />
                  <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, ...ellipsis }}>{shortUrl(url)}</span>
                  {u.public && <span style={{ padding: '1px 6px', borderRadius: 5, border: '1px solid var(--pub-bd)', color: 'var(--pub-fg)', fontSize: 11, fontWeight: 700 }}>PUBLIC</span>}
                  {down ? <span style={mono(11, 'var(--danger)', { whiteSpace: 'nowrap' })}>down{downAge(snap, u.name)}</span> : <span style={mono(11, 'var(--mut-3)')}>{u.port}</span>}
                  <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--accent)' }}>↗</span>
                </a>
              );
            })}
          </div>
        )}
        {g.devices.length > 0 && <div style={flexCol(8)}><span style={eyebrow()}>Connected devices</span><div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>{g.devices.map(s => <Chip key={s}>{s}</Chip>)}</div></div>}
      </div>
    </div>
  );
}

export function HostPanel({ h }: { h: HostView }) {
  const { live, select, toggleSelect, guestById } = useApp();
  const series = live.history.cpu[h.id] ?? [], cpu = last(series), hasCpu = series.some(v => v != null);
  const roles = h.leaves.filter(l => l.kind === 'role');
  return (
    <div style={flexCol(12)}>
      <div style={ruled('20px 0 20px', 'var(--rule)', flexCol(16))}>
        <div style={row(12)}>
          <div style={{ width: 38, height: 38, borderRadius: 10, ...tint(h.hue), display: 'grid', placeItems: 'center', fontSize: 12, fontWeight: 800, flex: 'none' }}>{h.mono}</div>
          <div style={{ flex: 1, minWidth: 0, ...flexCol() }}>
            <span style={row(8, { fontSize: 16, fontWeight: 700 })}><span style={ellipsis}>{h.name}</span><StatusDot status={h.status} /></span>
            <span style={mono(11, 'var(--mut-3)', ellipsis)} title={h.os}>{h.ipS} · {h.os}</span>
          </div>
          {h.url && <OpenBtn href={h.url} label={`Open ${h.name}`} />}
          <Close onClick={() => select(null)} />
        </div>
        <div style={{ fontSize: 13, color: 'var(--mut-1)', lineHeight: 1.5 }}>{h.hw}</div>
        {h.summary && <div style={{ fontSize: 12, color: 'var(--mut-3)', marginTop: -8 }}>{h.summary}</div>}
        {hasCpu ? (
          <div style={flexCol(6)}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}><span style={eyebrow()}>CPU · {SERIES_LEN}s</span><span style={mono(28, cpu == null ? 'var(--mut-3)' : undefined, { fontWeight: 500 })}>{cpu != null ? `${Math.round(cpu)}%` : '—'}</span></div>
            <Spark data={series} max={scaleMax(series, h.cpuScale)} height={70} fill="var(--accent-a16)" sw={2} />
          </div>
        ) : <span style={{ fontSize: 12, color: 'var(--mut-3)' }}>No live CPU feed for this host</span>}
        <Resources res={h.res} cpu={false} host />
        {h.updates && <div style={row(10)}><span style={eyebrow()}>Updates</span><UpdatesLine u={h.updates} /></div>}
        <div style={flexCol(2)}>
          <span style={{ ...eyebrow(), paddingBottom: 6 }}>{h.listLabel}</span>
          {roles.length ? (
            <div style={row(8, { padding: '7px 8px', borderRadius: 8 })}><span style={mono(11, 'var(--mut-3)', { width: 28 })} /><span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{roles.map(r => r.name).join(' / ')}</span></div>
          ) : h.leaves.map((l, i) => {
            const g = l.guestId ? guestById(l.guestId) : undefined;
            const count = g ? (g.containers ? `${g.containers} ctr` : g.kind === 'vm' ? 'VM' : 'LXC') : l.public ? 'public' : '';
            const inner = <>
              <span style={mono(11, 'var(--mut-3)', { width: 28 })}>{g ? g.vmid : ''}</span>
              <span style={{ fontSize: 13, fontWeight: 600, flex: 1, textAlign: 'left', ...ellipsis }}>{g ? g.name : l.name}</span>
              <span style={mono(11, l.public ? 'var(--pub-fg)' : 'var(--mut-3)')}>{count}</span>
              <StatusDot status={l.status} monitored={l.monitored !== false} size={6} />
            </>;
            const st = row(8, { padding: '7px 8px', borderRadius: 8, width: '100%', boxSizing: 'border-box', color: 'var(--text)' });
            if (g) return <button key={`${l.key}-${i}`} className="h-inset" onClick={() => toggleSelect({ kind: 'guest', id: g.id })} aria-label={`${g.name} details`} style={st}>{inner}</button>;
            if (l.url) return <a key={`${l.key}-${i}`} className="h-inset" href={l.url} target="_blank" rel="noopener noreferrer" title={l.url} aria-label={`Open ${l.name}`} style={st}>{inner}<span aria-hidden="true" style={{ fontSize: 12, color: 'var(--accent)' }}>↗</span></a>;
            return <div key={`${l.key}-${i}`} style={st}>{inner}</div>;
          })}
        </div>
      </div>
    </div>
  );
}

export function AttnRow({ a }: { a: Attention }) {
  const c = sevColors(a.severity);
  return (
    <div style={{ display: 'flex', gap: 10, padding: '11px 0', borderTop: '1px solid var(--rule-3)' }}>
      <Dot size={7} color={c.c} style={{ marginTop: 6 }} />
      <div style={{ flex: 1, minWidth: 0, ...flexCol(3) }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: a.severity === 'info' ? 'var(--text-2)' : undefined }}>{a.title}</span>
          {a.since != null && <span title={`since ${new Date(a.since).toLocaleString()}`} style={mono(11, 'var(--mut-3)', { whiteSpace: 'nowrap' })}>{agoText(secSince(a.since))}</span>}
        </div>
        {/* two lines at most (Grafana summaries run to four); the whole text is in the tooltip and behind the link */}
        <span title={a.detail} style={{ fontSize: 12, color: c.sub, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{a.detail}</span>
        {a.action && <a href={a.action.href} target="_blank" rel="noopener noreferrer" style={{ alignSelf: 'flex-start', marginTop: 6, padding: '5px 11px', borderRadius: 8, border: `1px solid ${c.rule}`, color: c.c, fontSize: 12, fontWeight: 600 }}>{a.action.label}</a>}
      </div>
    </div>
  );
}

/** Needs attention while a host or guest is selected: the worst two danger/warn items, one line each, so the
 *  problem stays in view. Nothing when only info notes remain. */
function AttentionCompact() {
  const { snap } = useApp();
  const [open, setOpen] = useState(false);
  const main = needsYou(snap.attention), notes = snap.attention.filter(a => a.severity === 'info');
  if (!main.length) return null;
  const ac = attnHeader(snap.attention);
  return (
    <div style={ruled('14px 0 12px', ac.rule, flexCol())}>
      <span style={{ ...eyebrow(ac.c), paddingBottom: 4 }}>Needs attention · {main.length}</span>
      {main.slice(0, 2).map(a => <AttnLine key={a.id} a={a} />)}
      {notes.length > 0 && <>
        <button aria-expanded={open} onClick={() => setOpen(o => !o)} className="h-link"
          style={{ alignSelf: 'flex-start', marginTop: 4, paddingLeft: 17, fontSize: 12, fontWeight: 600, color: 'var(--info)' }}>
          {open ? 'Hide notes' : `+${notes.length} note${notes.length === 1 ? '' : 's'}`} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
        {open && notes.map(a => <AttnLine key={a.id} a={a} />)}
      </>}
    </div>
  );
}
/** action: the item's link at the end of the line (Phase 5's compact rows: '+N more' and the amber line) */
export function AttnLine({ a, action = false }: { a: Attention; action?: boolean }) {
  const c = sevColors(a.severity);
  return (
    <div title={a.detail} style={{ display: 'flex', gap: 10, padding: '10px 0 4px' }}>
      <Dot size={7} color={c.c} style={{ marginTop: 6 }} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, flex: 'none', maxWidth: '60%', ...ellipsis, color: a.severity === 'info' ? 'var(--text-2)' : undefined }}>{a.title}</span>
        <span style={{ fontSize: 12, color: c.sub, flex: 1, minWidth: 0, ...ellipsis }}>{a.detail}</span>
        {a.since != null && <span style={mono(11, 'var(--mut-3)', { flex: 'none', whiteSpace: 'nowrap' })}>{agoText(secSince(a.since))}</span>}
        {action && a.action && <a className="h-link" href={a.action.href} target="_blank" rel="noopener noreferrer" style={{ flex: 'none', fontSize: 12, fontWeight: 600, color: c.c, whiteSpace: 'nowrap' }}>{a.action.label} ↗</a>}
      </div>
    </div>
  );
}

function AttentionList() {
  const { snap, live } = useApp();
  const [open, setOpen] = useState(false);
  const main = needsYou(snap.attention), notes = snap.attention.filter(a => a.severity === 'info');
  const ac = attnHeader(snap.attention), trace = useTrace(snap, main, last(live.history.wanIn));
  return (
    <div style={ruled('18px 0 14px', ac.rule, flexCol())}>
      <span style={{ ...eyebrow(ac.c), paddingBottom: 6 }}>Needs attention · {main.length}</span>
      {trace.back && (
        <div style={flexCol(8, { padding: '11px 0 0', borderTop: '1px solid var(--rule-3)' })}>
          <div style={row(10)}><Dot size={7} color="var(--ok)" /><span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ok)' }}>{trace.back.hops[trace.back.hops.length - 1].name} recovered</span></div>
          <FailTrace key={`${trace.back.id}:up`} id={trace.back.id} hops={trace.back.hops} ok />
        </div>
      )}
      {/* the trace sits under the first danger item, keyed by its id and state so a tick never replays it */}
      {main.map(a => <Fragment key={a.id}><AttnRow a={a} />{a.id === trace.down?.id && <FailTrace key={`${a.id}:down`} id={a.id} hops={trace.down.hops} />}</Fragment>)}
      {!main.length && <span style={{ fontSize: 12, color: 'var(--mut-3)', padding: '11px 0', borderTop: '1px solid var(--rule-3)' }}>Nothing needs you right now.</span>}
      {notes.length > 0 && <>
        <button aria-expanded={open} onClick={() => setOpen(o => !o)} className="h-link"
          style={{ alignSelf: 'flex-start', marginTop: 8, fontSize: 12, fontWeight: 600, color: 'var(--info)' }}>
          {open ? 'Hide notes' : `+${notes.length} note${notes.length === 1 ? '' : 's'}`} <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
        {open && notes.map(a => <AttnRow key={a.id} a={a} />)}
      </>}
    </div>
  );
}

/** pad / gap: the Phase 5 glanceables row's (1c: 16px 0 4px, 10) */
/** The spotlight app (homelab.json spotlight): its status, its signals, the probe's age, its backup and restore test. */
export function Spotlight({ pad = '16px 0 16px', gap = 9 }: { pad?: string; gap?: number }) {
  const { snap } = useApp();
  if (!on(snap, 'spotlight')) return null;
  const n = snap.spotlight, probe = aged(n?.probeAgeSec, snap);
  const rule = n?.status === 'down' ? 'var(--danger-rule)' : n?.status === 'degraded' ? 'var(--warn-rule)' : 'var(--rule)';
  const jobs = n ? [n.backupJob && <>{n.backupLabel || 'Last backup'} <span style={mono(11.5, 'var(--text-2)')}>{ago(n.backupAt)}</span></>, n.restoreJob && <>restore test <span style={mono(11.5, 'var(--text-2)')}>{ago(n.restoreAt)}</span></>].filter(Boolean) : [];
  return (
    <div style={ruled(pad, rule, flexCol(gap))}>
      <div style={row(8)}>
        <span style={eyebrow()}>{n?.name ?? 'Spotlight'}</span>
        {n && <><StatusDot status={n.status} /><span style={{ fontSize: 12, fontWeight: 600, color: statusText(n.status) }}>{STATUS_WORD[n.status]}</span></>}
        <span style={{ flex: 1 }} />
        {n?.url && <Ext href={n.url} label={`Open ${n.name}`} style={{ fontSize: 12, fontWeight: 600 }}>Open</Ext>}
      </div>
      {n ? <>
        <div style={row(14, { fontSize: 12, color: 'var(--mut-2)', flexWrap: 'wrap', rowGap: 4 })}>
          {n.signals.map(x => <span key={x.name} style={row(5)}><StatusDot status={x.status} size={6} />{x.name}</span>)}
          <span style={{ flex: 1 }} />
          {n.probed ? <span style={mono(11, probe == null || probe > 180 ? 'var(--warn)' : 'var(--mut-3)')}>{probe == null ? 'no probe data' : `probe ${agoText(probe)} ago`}</span> : null}
        </div>
        {(jobs.length > 0 || !!n.autoRecoveries) && <div style={{ fontSize: 12, color: 'var(--mut-3)', lineHeight: 1.5 }}>
          {jobs.flatMap((x, i) => (i ? [' · ', x] : [x]))}
          {n.autoRecoveries ? <>{jobs.length ? ' · ' : ''}<span style={mono(11.5, 'var(--warn)')}>{n.autoRecoveries}</span> auto-recover{n.autoRecoveries === 1 ? 'y' : 'ies'}</> : null}
        </div>}
      </> : <NotConnected what="Readiness probe" src="prom-infra" />}
    </div>
  );
}

const LEVEL_C = { danger: 'var(--danger)', warn: 'var(--warn)', info: 'var(--info)', ok: 'var(--ok)' } as const;
/** limit: rows shown (1c's glanceable shows 3) */
export function Activity({ pad = '16px 0 16px', limit = 6 }: { pad?: string; limit?: number }) {
  const { snap } = useApp();
  if (!on(snap, 'ntfy')) return null;
  const a = snap.activity, ntfy = uiUrl(snap, 'ntfy'), now = new Date();
  return (
    <div style={ruled(pad, 'var(--rule)', flexCol(8))}>
      <div style={row(8)}>
        <span style={eyebrow()}>Recent activity</span><span style={{ fontSize: 11, color: 'var(--mut-3)' }}>ntfy</span><span style={{ flex: 1 }} />
        {ntfy && <Ext href={ntfy} label="Open ntfy" style={{ fontSize: 12, fontWeight: 600 }}>Open</Ext>}
      </div>
      {a == null ? <NotConnected what="ntfy" src="ntfy" />
        : !a.length ? <span style={{ fontSize: 12, color: 'var(--mut-3)' }}>No notifications in the last 7 days</span>
          : a.slice(0, limit).map((m, i) => (
            <div key={`${m.at}-${i}`} title={m.body || undefined} style={row(10, { fontSize: 12, minHeight: 20 })}>
              <span style={mono(11, 'var(--mut-3)', { width: 42, flex: 'none' })}>{whenText(m.at, now)}</span>
              <Dot size={6} color={LEVEL_C[m.level]} />
              <span style={{ flex: 1, minWidth: 0, color: 'var(--text-2)', ...ellipsis }}>{m.title || m.body}</span>
              <span style={mono(11, 'var(--mut-3)', { flex: 'none', maxWidth: 110, ...ellipsis })}>{m.topic}</span>
            </div>
          ))}
    </div>
  );
}

/** idleLine: 1c's 'Nothing playing right now' while nothing plays (and Tautulli answers) */
export function PlexBlock({ pad = '18px 0 18px', idleLine = false }: { pad?: string; idleLine?: boolean }) {
  const { snap } = useApp();
  if (!on(snap, 'plex')) return null;
  const p = snap.plex, href = uiUrl(snap, 'plex'), np = p.nowPlaying;
  return (
    <div style={ruled(pad, 'var(--warn-rule)', flexCol(12))}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <MaybeLink href={href} label="Open Plex" style={{ ...eyebrow('var(--warn)'), flex: 'none' }}>Plex · now playing{href ? ' ↗' : ''}</MaybeLink>
        <span style={{ fontSize: 12, color: 'var(--warn-sub)', minWidth: 0, ...ellipsis }}>{p.streams == null ? whyMissing(snap, 'tautulli', 'Tautulli') : `${p.streams} stream${p.streams === 1 ? '' : 's'}`}</span>
      </div>
      {!np && idleLine && p.streams != null && <span style={{ fontSize: 13, color: 'var(--text-2)' }}>Nothing playing right now</span>}
      {np && (
        <div style={{ fontSize: 12, color: 'var(--text-2)', ...ellipsis }} title={`${np.title} · ${np.sub} · ${np.user}`}>
          {np.state !== 'playing' && <span style={{ color: 'var(--warn)', fontWeight: 700 }}>{np.state[0].toUpperCase() + np.state.slice(1)} · </span>}
          {np.title} <span style={{ color: 'var(--warn-sub)' }}>· {np.user}{p.others > 0 ? ` · +${p.others} more` : ''}</span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
        {([['Movies', p.movies], ['Shows', p.shows], ['Download queue', p.queued]] as const).map(([k, v]) => (
          <div key={k} style={flexCol()}><span style={mono(18, v == null ? 'var(--mut-3)' : undefined)}>{fmt(v)}</span><span style={{ fontSize: 11, color: 'var(--warn-sub)' }}>{k}</span></div>
        ))}
      </div>
    </div>
  );
}

/** label: the name people say (Phase 5's Open rows), e.g. 'Gitea' for git */
export interface LaunchItem { key: string; name: string; label: string; sub: string; url: string; public: boolean; status: Status; monitored: boolean; app: boolean; owner: Selection; hay: string }
/** Web UIs plus the apps that aren't a web UI name (apps on a NAS, the public apps). */
export function launchItems(snap: Snapshot): LaunchItem[] {
  const uis = snap.uis.map((u): LaunchItem => {
    const svc = serviceOf(snap, u), url = u.url, owner = u.owner ? (u.owner.kind === 'guest' ? snap.guests.find(g => g.id === u.owner!.id)?.name : snap.hosts.find(h => h.id === u.owner!.id)?.name) : '';
    const label = uiLabel(snap, u);
    return { key: `ui-${u.name}`, name: u.name, label, sub: u.target, url, public: u.public, status: u.status, monitored: u.monitored, app: false, owner: u.owner, hay: `${u.name} ${label} ${svc} ${u.target} ${shortUrl(url)} ${owner ?? ''} ${aliasOf(u.name)}`.toLowerCase() };
  });
  const host = (url: string) => { try { return new URL(url).hostname; } catch { return url; } };
  const have = new Set(snap.uis.map(u => host(u.url)));
  const apps = snap.apps.flatMap((a): LaunchItem[] => {
    const url = a.url ?? a.publicUrl;
    if (!url || have.has(host(url))) return []; // e.g. Kopia, already a web UI
    return [{ key: `app-${a.name}`, name: a.label, label: displayName(a.name) ?? a.label, sub: `app · ${shortUrl(url)}`, url, public: !!a.publicUrl, status: a.status, monitored: a.monitored, app: true, owner: { kind: 'host', id: a.host },
      hay: `${a.name} ${a.label} ${shortUrl(url)} ${a.publicUrl ? shortUrl(a.publicUrl) : ''} ${a.note} ${aliasOf(a.name)}`.toLowerCase() }];
  });
  return [...uis, ...apps];
}

/** What Open shows (desktop Open, the phone's Open tab and hero pins): the launch items less ui.launcher.hidden (e.g.
 *  the dashboard itself). Classic's launcher keeps every item. */
export const openItems = (snap: Snapshot) => launchItems(snap).filter(u => !hiddenInOpen(groupKey(u.key)));

function Launcher() {
  const { snap, ui, set, toggleSelect } = useApp();
  const input = useRef<HTMLInputElement>(null);
  const q = ui.launcherQuery.trim().toLowerCase();
  const all = launchItems(snap), list = all.filter(u => !q || matches(u.hay, q));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // '/' opens ⌘K (App.tsx); the filter still works when clicked
      if (e.key === 'Escape' && document.activeElement === input.current) { set({ launcherQuery: '' }); input.current?.blur(); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [set]);
  const showOnMap = (owner: NonNullable<Selection>) => { toggleSelect(owner); scrollTo({ top: 0, behavior: 'smooth' }); };
  // two tiles with one monogram can't be told apart: say so while developing (tests/server/monograms.test.ts checks the config)
  const names = all.map(u => u.name).join('\n');
  useEffect(() => {
    const c = import.meta.env.DEV ? monoClashes(names.split('\n')) : [];
    if (c.length) console.warn(`Launcher monograms clash: ${c.join(' · ')}`);
  }, [names]);
  const nApps = all.filter(a => a.app).length;
  return (
    <div style={flexCol(12)}>
      <div style={row(14)}>
        <span style={eyebrow()}>Launch</span>
        <label style={row(8, { width: 300, padding: '6px 0', borderBottom: '1px solid var(--rule)' })}>
          <span style={mono(12, 'var(--accent)')}>/</span>
          <input ref={input} value={ui.launcherQuery} onChange={e => set({ launcherQuery: e.target.value })} placeholder={`Filter ${snap.uis.length} UIs and ${nApps} apps…`} aria-label="Filter web UIs and apps"
            style={{ flex: 1, background: 'transparent', border: 0, outline: 'none', color: 'var(--text)', font: '500 13px var(--font-ui)' }} />
        </label>
        <span style={{ fontSize: 12, color: 'var(--mut-3)' }}>{q ? `${list.length} of ${all.length}` : ''}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9,minmax(0,1fr))', gap: 8, minHeight: 84 }}>
        {list.map(u => (
          <div key={u.key} className="h-tile" style={{ position: 'relative', borderRadius: 12, minWidth: 0 }}>
            <a href={u.url} target="_blank" rel="noopener noreferrer" title={`${u.url}${u.monitored ? ` · ${u.status}` : ' · no monitor'}`} aria-label={`Open ${u.name}${u.app ? ' (app)' : ''}`}
              style={row(8, { padding: '10px 6px', borderRadius: 12, minWidth: 0, color: 'inherit' })}>
              <div style={{ position: 'relative', width: 30, height: 30, borderRadius: u.app ? 15 : 9, ...tint(hueOf(u.name)), display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 11.5, flex: 'none', boxShadow: u.public ? '0 0 0 1.5px var(--pub)' : 'none' }}>
                {monoOf(u.name)}
                <span title={u.monitored ? u.status : 'no monitor'} style={{ position: 'absolute', right: -3, top: -3, width: 9, height: 9, boxSizing: 'content-box', borderRadius: '50%', background: u.monitored ? statusColor(u.status) : 'var(--bg)', border: '2px solid var(--bg)', boxShadow: u.monitored ? 'none' : 'inset 0 0 0 1.5px var(--mut-5)' }} />
              </div>
              <div style={{ minWidth: 0, ...flexCol(1) }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', ...ellipsis }}>{u.name}</span>
                <span style={mono(11, 'var(--mut-3)', ellipsis)}>{u.sub}</span>
              </div>
            </a>
            {u.owner && (
              <button className="tile-open" onClick={() => showOnMap(u.owner!)} aria-label={`Show ${u.name} on the map`} title="Show on the map"
                style={{ position: 'absolute', right: 4, top: 4, width: 18, height: 18, display: 'grid', placeItems: 'center', borderRadius: 5, fontSize: 12, lineHeight: 1, color: 'var(--mut-3)' }}>◎</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
