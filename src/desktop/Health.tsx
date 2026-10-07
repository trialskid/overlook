import { on } from '../lib/modules.ts';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useApp } from '../state.tsx';
import { agoText, ago, cellColor, jobAgo, jobColor, jobText, scrollToId, secSince, sevColors, statusColor, stripSince, toneColor, uiUrl, whenText, whyMissing } from '../lib/util.ts';
import { Bar, CountLink, Dot, Ext, SectionTitle, StatusDot, Tag, UptimeCells, ellipsis, eyebrow, flexCol, mono, row, ruled } from '../lib/ui.tsx';
import {
  STATUS_RANK, alertingRows, automationRows, exposureParts, groupJobs, problemsFirst, sectionIndex, shortLabel, shownMembers, sourcesFirst, storageParts, unitRows,
  type AutoRow, type JobGroup,
  sectionOn,
} from '../../shared/health.ts';
import type { Conn, JobView, Monitor, Severity, Snapshot, SourceView, Status, UpdatesView, Volume } from '../../shared/types.ts';
import { DisksBlock, NotYetLine, OPS_COLS, OpsEmpty, OpsRow, PowerBlock, UpdatesLine, opsMissing } from './Ops.tsx';
import { Heartbeat, useBeatClock } from '../lib/motion.tsx';
import { DevicesSection } from './Devices.tsx';

export { SectionTitle };
/** Latency stays neutral: the tunnel and public checks are 150-300 ms when healthy. Kuma's own status (the dot) says
 *  when something is slow or down; only a down check's missing latency is red. */
export const msColor = (st: Status) => (st === 'down' ? 'var(--danger)' : 'var(--mut-3)');
const CONN: Record<Conn, { label: string; c: string }> = {
  ok: { label: 'ok', c: 'var(--ok)' }, stale: { label: 'stale', c: 'var(--warn)' }, error: { label: 'error', c: 'var(--danger)' },
  'not-connected': { label: 'not connected', c: 'var(--mut-3)' }, mock: { label: 'mock', c: 'var(--accent-2)' },
};
const SEV_RANK: Record<Severity, number> = { danger: 0, warn: 1, info: 2 };
const RULE3 = '1px solid var(--rule-3)';
/** Public exposure's rows: 8px gaps so the longest one-line row (name, access tag, host, code) fits a 1440 column */
const EX_GAP = 8;
const SECTION = ruled('16px 0 0', 'var(--rule)', flexCol());
const TWO: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: '0 48px' };
const THREE: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 48, alignItems: 'start' };
const Empty = ({ children }: { children: ReactNode }) => <span style={{ fontSize: 12, color: 'var(--mut-3)', padding: '12px 0' }}>{children}</span>;
const Strip = ({ days }: { days: Status[] }) => <div style={{ display: 'flex', gap: 2, flex: 'none' }} aria-label="last 14 days">{days.map((d, j) => <span key={j} style={{ width: 6, height: 12, borderRadius: 2, background: cellColor(d) }} />)}</div>;
const NoHistory = () => <span style={{ fontSize: 11, color: 'var(--mut-3)', flex: 'none' }}>no history</span>;
const Caret = ({ open }: { open: boolean }) => <span aria-hidden="true" style={mono(11, 'var(--mut-3)', { flex: 'none' })}>{open ? '▴' : '▾'}</span>;
const twoCols = <T,>(a: T[]) => [a.slice(0, Math.ceil(a.length / 2)), a.slice(Math.ceil(a.length / 2))];

function MonitorRow({ m }: { m: Monitor }) {
  const watched = m.kumaId != null;
  const cert = m.certDays != null && m.certDays <= 14;
  return (
    <div style={row(12, { height: 30, borderBottom: RULE3, opacity: watched ? 1 : 0.55 })}>
      <StatusDot status={m.status} monitored={watched} size={6} />
      <span title={m.label !== m.name ? `${m.label} · ${m.name}` : m.name} style={{ width: 180, flex: 'none', fontSize: 13, fontWeight: 600, ...ellipsis }}>{m.label || m.name}</span>
      {watched
        ? <UptimeCells cells={m.cells} title={m.uptime1 != null ? `24 h: ${m.uptime1.toFixed(2)}%` : undefined} style={{ flex: 1 }} />
        : <span style={{ flex: 1, fontSize: 11, color: 'var(--mut-3)' }}>no monitor</span>}
      {cert && <span title="TLS certificate expires soon" style={mono(11, 'var(--warn)', { flex: 'none' })}>cert {m.certDays} d</span>}
      <span style={mono(12, msColor(m.status), { width: 52, flex: 'none', textAlign: 'right' })}>{!watched || m.ms == null ? '—' : `${m.ms} ms`}</span>
      <span style={mono(12, 'var(--mut-3)', { width: 58, flex: 'none', textAlign: 'right' })} title="30-day uptime (Uptime Kuma)">{m.uptime30 == null ? '—' : `${m.uptime30.toFixed(2)}%`}</span>
    </div>
  );
}

/** A web UI or app no Uptime Kuma monitor watches: a chip under the uptime grid (both layouts). */
export function NoMonitorLine({ snap, mons, style }: { snap: Snapshot; mons: Monitor[]; style?: CSSProperties }) {
  if (!mons.length) return null;
  return (
    <div data-nomon style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, ...style }}>
      <span style={{ ...eyebrow('var(--mut-3)', 11), marginRight: 2 }}>No monitor · {mons.length}</span>
      {mons.map(m => {
        const url = uiUrl(snap, m.name), label = m.label || m.name;
        const inner = <><StatusDot status="unknown" monitored={false} size={6} />{label}</>;
        const s: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', borderRadius: 99, border: '1px solid var(--pill-bd)', fontSize: 11, color: 'var(--mut-3)', whiteSpace: 'nowrap' };
        const title = `${label}${m.label && m.label !== m.name ? ` · ${m.name}` : ''} · no Uptime Kuma monitor`;
        return url
          ? <span key={m.name} data-chip title={title} style={{ display: 'inline-flex' }}><Ext href={url} arrow={false} label={`Open ${label}`} style={{ ...s, color: 'var(--mut-3)' }}>{inner}</Ext></span>
          : <span key={m.name} data-chip title={title} style={s}>{inner}</span>;
      })}
    </div>
  );
}

/** title: tooltip (default 'where · schedule'); label: the name shown (a family member's short label); child: a row
 *  under a group line; anchor false: no #job- id (a fallback row); detailColor / dotColor override the job's tier. */
function JobRow({ j, compact, label, child, anchor = true, title, detailColor, dotColor }:
  { j: JobView; compact?: boolean; label?: string; child?: boolean; anchor?: boolean; title?: string; detailColor?: string; dotColor?: string }) {
  const text = label ?? j.name;
  const name = j.link ? <Ext href={j.link} arrow={false} label={`Open ${j.name}`} style={{ color: 'inherit' }}>{text}</Ext> : text;
  const id = anchor ? `job-${j.id}` : undefined;
  const tip = title ?? [j.where, j.schedule].filter(Boolean).join(' · ');
  if (compact) return (
    <div id={id} data-open={child ? (j.status === 'up' ? 'all' : 'problem') : undefined} title={tip}
      style={row(10, { minHeight: 34, padding: '4px 0', paddingLeft: child ? 17 : 0, borderBottom: RULE3, scrollMarginTop: 80 })}>
      <StatusDot status={j.status} color={dotColor ?? jobColor(j)} />
      <span style={{ flex: '0 1 auto', minWidth: 0, fontSize: 13, fontWeight: 600, ...ellipsis }}>{name}</span>
      <span style={{ flex: '1 1 0', minWidth: 0, fontSize: 12, color: detailColor ?? jobText(j), ...ellipsis }}>{j.detail}</span>
      <span style={mono(12, 'var(--mut-1)', { flex: 'none' })}>{jobAgo(j)}</span>
    </div>
  );
  return (
    <div id={id} style={flexCol(6, { padding: '11px 0', borderBottom: RULE3, scrollMarginTop: 80 })}>
      <div style={row(10)}><StatusDot status={j.status} color={jobColor(j)} /><span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 600, ...ellipsis }}>{name}</span><span style={mono(12, 'var(--mut-1)')}>{jobAgo(j)}</span></div>
      <div style={row(10, { paddingLeft: 17 })}>
        <span title={tip} style={{ flex: 1, minWidth: 0, fontSize: 12, color: jobText(j), ...ellipsis }}>{[j.where, j.detail].filter(Boolean).join(' · ')}</span>
        {j.days ? <Strip days={j.days} /> : <NoHistory />}
      </div>
    </div>
  );
}

/** A family member inside its group line. Healthy: muted, no dot. Failing or overdue: its tier's dot, text and rim. */
export function JobPill({ j, anchor }: { j: JobView; anchor: boolean }) {
  const bad = j.status === 'down' || j.status === 'degraded', unk = j.status === 'unknown';
  return (
    <span id={anchor ? `job-${j.id}` : undefined} data-pill title={[j.name, j.where, j.detail, jobAgo(j)].filter(Boolean).join(' · ')}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 7px', borderRadius: 99, fontSize: 11, fontWeight: 600, lineHeight: '15px', whiteSpace: 'nowrap', scrollMarginTop: 80,
        border: `1px solid ${bad ? (j.critical ? 'var(--danger-rule)' : 'var(--warn-rule)') : 'var(--pill-bd)'}`, color: bad ? jobText(j) : unk ? 'var(--mut-3)' : 'var(--mut-2)',
      }}>
      {(bad || unk) && <span style={{ width: 5, height: 5, borderRadius: '50%', background: bad ? jobColor(j) : 'var(--mut-5)', flex: 'none' }} />}
      {shortLabel(j)}
    </span>
  );
}
export const groupColor = (g: JobGroup) => jobColor({ status: g.status, critical: g.critical });

/** One line for a job family: dot, name and caret, merged strip (or 'n/m on time' when compact), age, member pills.
 *  The caret sits by the name (as on the phone) so the age shares one right edge with plain and child rows.
 *  Members that aren't up always show as rows under it; opening it shows every member as a row. */
function GroupRow({ g, compact }: { g: JobGroup; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const kids = shownMembers(g, open), ok = g.members.filter(m => m.status === 'up').length;
  return <>
    <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className="h-inset" data-group={g.family} title={g.members[0].where}
      style={flexCol(compact ? 5 : 6, { width: '100%', padding: compact ? '6px 0' : '9px 0', borderBottom: RULE3, scrollMarginTop: 80, textAlign: 'left' })}>
      <span style={row(10, { width: '100%' })}>
        <StatusDot status={g.status} color={groupColor(g)} />
        <span style={row(6, { flex: 1, minWidth: 0 })}><span style={{ minWidth: 0, fontSize: compact ? 13 : 14, fontWeight: 600, ...ellipsis }}>{g.family}</span><Caret open={open} /></span>
        {compact ? <span style={{ fontSize: 12, color: 'var(--mut-3)', flex: 'none' }}>{ok}/{g.members.length} on time</span> : g.days ? <Strip days={g.days} /> : <NoHistory />}
        <span style={mono(12, 'var(--mut-1)', { minWidth: 58, flex: 'none', textAlign: 'right' })}>{jobAgo(g.ageMember)}</span>
      </span>
      {!open && <span style={{ display: 'flex', flexWrap: 'wrap', gap: 5, paddingLeft: 17 }}>{g.members.map(m => <JobPill key={m.id} j={m} anchor={!kids.includes(m)} />)}</span>}
    </button>
    {kids.map(m => <JobRow key={m.id} j={m} compact child label={shortLabel(m)} />)}
  </>;
}
const autoDetail = (r: AutoRow) => (r.detailColor === 'warn' ? 'var(--warn)' : r.detailColor ? statusColor(r.detailColor) : undefined);

/** Jobs with no machine-readable signal, folded to one line that still names them all. */
function NotMonitored({ items }: { items: Snapshot['health']['unmonitored'] }) {
  const [open, setOpen] = useState(false);
  return <>
    <button id="health-unmonitored" type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className="h-inset"
      style={row(10, { width: '100%', minHeight: 34, borderBottom: RULE3, scrollMarginTop: 80, textAlign: 'left' })}>
      <StatusDot status="unknown" monitored={false} />
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--mut-2)', flex: 'none' }}>Not monitored · {items.length}</span>
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, color: 'var(--mut-3)', ...ellipsis }}>{items.map(u => u.name).join(', ')}</span>
      <Caret open={open} />
    </button>
    {open && items.map((u, i) => (
      <div key={`${u.name}-${i}`} style={row(10, { minHeight: 32, padding: '4px 0', borderBottom: RULE3 })} title={u.note}>
        <StatusDot status="unknown" monitored={false} />
        <div style={{ flex: 1, minWidth: 0, ...flexCol(1) }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', ...ellipsis }}>{u.name}</span>
          <span style={{ fontSize: 11, color: 'var(--mut-3)', ...ellipsis }}>{[u.where, u.note].filter(Boolean).join(' · ')}</span>
        </div>
      </div>
    ))}
  </>;
}

function VolumeRow({ v }: { v: Volume }) {
  if (v.missing) return (
    <div title={v.missing} style={flexCol(4, { padding: '10px 0', borderBottom: RULE3 })}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, ...ellipsis }}>{v.name}</span><span style={mono(12, 'var(--mut-3)', { flex: 'none' })}>— / {v.cap}</span></div>
      <span style={{ fontSize: 12, color: v.tone === 'ok' ? 'var(--mut-3)' : toneColor(v.tone), ...ellipsis }}>{v.missing}</span>
    </div>
  );
  return (
    <div style={flexCol(7, { padding: '12px 0', borderBottom: RULE3 })}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}><span style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{v.name}</span><span style={mono(12, 'var(--text-2)')}>{v.used}</span><span style={mono(12, 'var(--mut-3)')}>/ {v.cap}</span></div>
      <Bar pct={v.pct} color={v.tone === 'ok' ? 'var(--accent)' : toneColor(v.tone)} />
      <span style={{ fontSize: 12, color: v.tone === 'ok' ? 'var(--mut-3)' : toneColor(v.tone) }}>{v.pct}% used · {v.sub}</span>
    </div>
  );
}
/** The array's disks (and cache): one 24px line each under the array row. */
export function DiskBlock({ disks, parent, labelW = 56 }: { disks: Volume[]; parent: Volume; labelW?: number }) {
  const prefix = `${parent.name.split(' ')[0]} `;
  return (
    <div data-disks style={flexCol(0, { padding: '6px 0 6px 17px', borderBottom: RULE3 })}>
      {disks.map(v => { const c = v.tone === 'ok' ? null : toneColor(v.tone); return (
        <div key={v.name} data-disk title={`${v.used} / ${v.cap}`} style={row(10, { height: 24 })}>
          <span style={{ width: labelW, flex: 'none', fontSize: 12, fontWeight: 600, ...ellipsis }}>{v.name.startsWith(prefix) ? v.name.slice(prefix.length) : v.name}</span>
          <div style={{ flex: 1, minWidth: 0 }}><Bar pct={v.pct} height={4} color={c ?? 'var(--accent)'} /></div>
          <span style={mono(12, c ?? 'var(--mut-3)', { width: 36, flex: 'none', textAlign: 'right' })}>{v.pct}%</span>
          <span style={mono(12, c ?? 'var(--mut-3)', { width: 84, flex: 'none', textAlign: 'right', whiteSpace: 'nowrap' })}>{v.sub}</span>
        </div>
      ); })}
    </div>
  );
}

/** Both layouts' Sources sub-line: '16 answering · 2 not connected' (+ '· 1 not answering'). */
export function sourcesLine(sources: SourceView[]) {
  const n = (f: (s: SourceView) => boolean) => sources.filter(f).length;
  const ok = n(s => s.conn === 'ok' || s.conn === 'mock'), off = n(s => s.conn === 'not-connected'), bad = sources.length - ok - off;
  return [`${ok} answering`, off && `${off} not connected`, bad && `${bad} not answering`].filter(Boolean).join(' · ');
}
/** Both layouts' uptime window: 'last 24 h in 30-min slots', or since when the strips have data after a deploy. */
export function uptimeWindow(snap: Snapshot) {
  const since = stripSince([...snap.health.monitors, ...snap.health.unmapped].map(m => m.cells), snap.at);
  return since ? `last 24 h in 30-min slots · data since ${whenText(since)}` : 'last 24 h in 30-min slots';
}
/** danger and warn alerts in full rows; info alerts (by their own text, not proof of an outage) folded behind a count */
export function useAlertFold(alerts: Snapshot['alerts']) {
  const [open, setOpen] = useState(false);
  const all = alerts ?? [], info = all.filter(a => a.severity === 'info');
  const shown = problemsFirst(open ? all : all.filter(a => a.severity !== 'info'), a => SEV_RANK[a.severity] ?? 3);
  return { shown, info: info.length, open, toggle: () => setOpen(o => !o) };
}

function AlertRow({ a }: { a: NonNullable<Snapshot['alerts']>[number] }) {
  const c = sevColors(a.severity);
  return (
    <a className="h-inset" href={a.url} target="_blank" rel="noopener noreferrer" title={a.summary} style={{ display: 'flex', gap: 10, padding: '9px 4px', borderBottom: RULE3, color: 'var(--text)' }}>
      <Dot size={7} color={c.c} style={{ marginTop: 6 }} />
      <div style={{ flex: 1, minWidth: 0, ...flexCol(2) }}>
        <span style={{ fontSize: 13, fontWeight: 600, ...ellipsis }}>{a.name}</span>
        <span style={{ fontSize: 12, color: c.sub, ...ellipsis }}>{a.summary || a.severity}</span>
      </div>
      <span style={mono(11, 'var(--mut-3)', { flex: 'none', paddingTop: 2 })}>{a.since == null ? '' : agoText(secSince(a.since))}</span>
    </a>
  );
}

/** A host's guests' apt counts on one line under its own: 'loop-dashboard 11' (tooltip: each one's detail). */
function GuestUpdates({ us }: { us: UpdatesView[] }) {
  const warn = us.some(u => u.tone === 'warn');
  return (
    <span title={us.map(u => `${u.name}: ${u.value} · ${u.sub}`).join('\n')} style={{ fontSize: 11.5, color: warn ? 'var(--warn)' : 'var(--mut-3)', ...ellipsis }}>
      guests · {us.map(u => `${u.name} ${u.value === '—' ? '—' : u.security ? `${u.pending ?? 0} (${u.security} sec)` : u.pending ?? 0}${u.reboot ? ' reboot' : ''}`).join(' · ')}
    </span>
  );
}

/** Plans H5-H13: Power | Unraid disks | Edge, each problems first. A column whose plan isn't applied says so in one
 *  line; with none of the three applied the band is a single 'Not monitored yet' chip line (as are Updates, iCloud and
 *  whose homes are Software and Automation). */
function OpsBand({ snap }: { snap: Snapshot }) {
  const ops = snap.health.ops;
  if (!ops) return null;
  const cols3 = { power: on(snap, 'ups'), disks: on(snap, 'unraid'), edge: on(snap, 'edge') };
  const shown = !!((cols3.power && ops.power) || (cols3.disks && ops.disks) || (cols3.edge && ops.edge));
  const cols = new Set<string>(shown ? Object.values(OPS_COLS).flat() : []);
  const chips = ops.missing.filter(m => !cols.has(m.id));
  const d = ops.disks, edgeMissing = opsMissing(ops, OPS_COLS.edge);
  return <>
    {shown && (
      <div data-band="ops" style={THREE}>
        {cols3.power && <div style={SECTION}>
          <SectionTitle sm={SM} id="health-power" title="Power" sub="UPS" />
          {ops.power ? <PowerBlock p={ops.power} /> : <OpsEmpty missing={opsMissing(ops, OPS_COLS.power)} />}
        </div>}
        {cols3.disks && <div style={SECTION}>
          <SectionTitle sm={SM} id="health-disks" title="Unraid disks" sub={d ? `array, parity, SMART${d.rows.length ? ` · ${d.rows.length} disks` : ''}${d.readAt != null ? ` · read ${ago(d.readAt)}` : ''}` : undefined} />
          {d ? <DisksBlock d={d} /> : <OpsEmpty missing={opsMissing(ops, OPS_COLS.disks)} />}
        </div>}
        {cols3.edge && <div style={SECTION}>
          <SectionTitle sm={SM} id="health-edge" title="Edge" sub="tunnels, proxy, push" />
          {ops.edge?.map(l => <OpsRow key={l.id} l={l} />)}
          {edgeMissing.length > 0 && <OpsEmpty missing={edgeMissing} />}
        </div>}
      </div>
    )}
    {chips.length > 0 && <NotYetLine missing={chips} />}
  </>;
}

/** The index row's height: its 2px rule, 12px above the text, the name (18) and state (16) lines 5px apart, 12px
 *  below. Health's section anchors scroll this much further down, so a jump lands under the sticky row. */
const INDEX_H = 2 + 12 + 18 + 5 + 16 + 12, SM = 20 + INDEX_H;

/** Review finding 13: one entry per section with its worst state, sticky while Health scrolls; each jumps to its
 *  section. A section with a problem gets its tier's top rule and coloured state; a fine one stays grey. */
function SectionIndex({ snap }: { snap: Snapshot }) {
  const idx = sectionIndex(snap);
  return (
    <nav aria-label="Health sections" data-index style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--bg)', display: 'grid', gridTemplateColumns: `repeat(${idx.length},minmax(0,1fr))`, gap: '0 20px', paddingBottom: 12 }}>
      {idx.map(e => { const bad = e.tone !== 'ok'; return (
        <div key={e.id} style={{ borderTop: `2px solid ${bad ? toneColor(e.tone) : 'var(--rule)'}`, paddingTop: 12, minWidth: 0 }}>
          <CountLink onClick={() => scrollToId(e.anchor)} gap={5} label={`${e.name}: ${e.state}. Go to the section`}>
            <span style={row(6, { fontSize: 13, fontWeight: 700, lineHeight: '18px' })}>{e.name}<span style={{ flex: 1 }} /><span aria-hidden="true" style={{ fontSize: 12, color: 'var(--mut-3)' }}>↓</span></span>
            <span title={e.state} style={{ fontSize: 12, lineHeight: '16px', color: bad ? toneColor(e.tone) : 'var(--mut-3)', fontWeight: bad ? 600 : undefined, ...ellipsis }}>{e.state}</span>
          </CountLink>
        </div>
      ); })}
    </nav>
  );
}

export function Health() {
  const { snap } = useApp();
  const h = snap.health;
  const watchedMons = problemsFirst(h.monitors.filter(m => m.kumaId != null), m => STATUS_RANK[m.status]);
  const noMon = h.monitors.filter(m => m.kumaId == null);
  const fold = useAlertFold(snap.alerts);
  const backups = h.jobs.filter(j => j.group === 'backup');
  const auto = automationRows(h), autoSt = unitRows(auto);
  const st = storageParts(h), hot = h.storage.filter(v => v.tone !== 'ok').length;
  const ex = exposureParts(h);
  const grafana = uiUrl(snap, 'grafana');
  return (
    <div style={flexCol(32)}>
      <SectionIndex snap={snap} />

      {sectionOn(snap, 'alerts') && <>
      {/* firing alerts first, in two columns: the most severe top-left */}
      <div style={SECTION}>
        <SectionTitle sm={SM} id="health-alerts" title="Grafana alerts" sub={snap.alerts ? `${snap.alerts.length} firing` : undefined} right={grafana ? <><span style={{ flex: 1 }} /><Ext href={`${grafana}/alerting/list`} label="Open Grafana alerting" style={{ fontSize: 12, fontWeight: 600, flex: 'none' }}>Grafana</Ext></> : undefined} />
        {snap.alerts == null ? <Empty>{whyMissing(snap, 'grafana', 'Grafana')}</Empty>
          : !snap.alerts.length ? <Empty>Nothing firing</Empty>
            : fold.shown.length > 0 && <div data-alerts style={TWO}>{twoCols(fold.shown).map((col, i) => <div key={i} style={flexCol()}>{col.map((a, k) => <AlertRow key={`${a.name}-${k}`} a={a} />)}</div>)}</div>}
        {fold.info > 0 && <button aria-expanded={fold.open} onClick={fold.toggle} className="h-link" style={{ alignSelf: 'flex-start', marginTop: 8, fontSize: 12, fontWeight: 600, color: 'var(--info)' }}>
          {fold.open ? 'Hide info alerts' : `+${fold.info} info alert${fold.info === 1 ? '' : 's'}`} <span aria-hidden="true">{fold.open ? '▴' : '▾'}</span></button>}
      </div>
      </>}

      {sectionOn(snap, 'uptime') && <>
      <div style={ruled('16px 0 0', 'var(--rule)', flexCol(10))}>
        <SectionTitle sm={SM} id="health-uptime" title="Service uptime" pad={0}
          right={<><span style={{ flex: 1 }} /><span style={row(14, { fontSize: 11, color: 'var(--mut-3)', flex: 'none' })}>
            {([['Up', 'var(--uptime-up)'], ['Degraded', 'var(--warn)'], ['Down', 'var(--danger)'], ['No data yet', 'var(--rule-3)']] as const).map(([l, c]) => <span key={l} style={row(5)}><span style={{ width: 8, height: 8, borderRadius: 2, background: c, boxShadow: l === 'No data yet' ? 'inset 0 0 0 1px var(--rule)' : undefined }} />{l}</span>)}
          </span></>} />
        {watchedMons.length ? (
          <div data-uptime style={TWO}>
            {twoCols(watchedMons).map((col, i) => <div key={i} style={flexCol()}>{col.map(m => <MonitorRow key={m.name} m={m} />)}</div>)}
          </div>
        ) : <Empty>{whyMissing(snap, 'kuma', 'Uptime Kuma')}</Empty>}
        <NoMonitorLine snap={snap} mons={noMon} />
        {h.unmapped.length > 0 && <>
          <span style={{ ...eyebrow(), paddingTop: 10 }}>Other Kuma monitors · {h.unmapped.length}</span>
          <div style={TWO}>
            {twoCols(h.unmapped).map((col, i) => <div key={i} style={flexCol()}>{col.map(m => <MonitorRow key={m.name} m={m} />)}</div>)}
          </div>
        </>}
      </div>
      </>}

      <div data-band="1" style={THREE}>
        <div style={SECTION}>
          <SectionTitle sm={SM} id="health-backups" title="Backups" sub={`${backups.filter(b => b.status === 'up').length} of ${backups.length} ok · last 14 days`} />
          {groupJobs(backups).map(g => (g.members.length > 1 ? <GroupRow key={`f-${g.family}`} g={g} /> : <JobRow key={g.members[0].id} j={g.members[0]} />))}
          {!backups.length && <Empty>{whyMissing(snap, 'prom-jobs', 'Backup checks')}</Empty>}
        </div>

        <div style={SECTION}>
          <SectionTitle sm={SM} id="health-automation" title="Automation" sub={`collectors, monitors, reports${autoSt.length ? ` · ${autoSt.filter(s => s === 'up').length} of ${autoSt.length} ok` : ''}`} />
          {auto.map(u => (u.kind === 'group' ? <GroupRow key={`f-${u.group.family}`} g={u.group} compact />
            : <JobRow key={u.row.job.id} j={u.row.job} compact anchor={u.row.anchor} title={u.row.title} detailColor={autoDetail(u.row)} dotColor={u.row.plain ? statusColor(u.row.job.status) : undefined} />))}
          {!auto.length && <Empty>{whyMissing(snap, 'prom-jobs', 'Automation checks')}</Empty>}
          {h.unmonitored.length > 0 && <NotMonitored items={h.unmonitored} />}
        </div>

        <div style={SECTION}>
          <SectionTitle sm={SM} id="health-alerting" title="Alerting" />
          {alertingRows(h).map(a => {
            const j = a.jobRow, jobBad = !!j && j.status !== 'up';
            return (
              <div key={a.name} id={j ? `job-${j.id}` : undefined} title={j ? `${j.name} · ${j.where} · ${j.schedule}` : undefined} style={row(12, { minHeight: 50, borderBottom: RULE3, scrollMarginTop: 80 })}>
                <Dot size={7} color={toneColor(a.tone)} />
                <div style={{ flex: 1, minWidth: 0, ...flexCol(1) }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{a.name}</span>
                  <span style={{ fontSize: 12, color: jobBad ? jobText(j) : 'var(--mut-3)', ...ellipsis }}>{jobBad ? j.detail || a.where : a.where}</span>
                </div>
                <span style={mono(12, toneColor(a.tone), { textAlign: 'right' })}>{a.state}</span>
              </div>
            );
          })}
        </div>
      </div>

      <OpsBand snap={snap} />

      <div data-band="2" style={THREE}>
        <div style={SECTION}>
          <SectionTitle sm={SM} id="health-storage" title="Storage" sub={`${h.storage.length} volumes${hot ? ` · ${hot} need${hot === 1 ? 's' : ''} a look` : ''}`} />
          {st.parent && <VolumeRow v={st.parent} />}
          {st.parent && st.disks.length > 0 && <DiskBlock disks={st.disks} parent={st.parent} />}
          {st.rest.map(v => (v.tone === 'ok' && !v.missing ? (
            <div key={v.name} title={v.sub} style={flexCol(6, { padding: '10px 0', borderBottom: RULE3 })}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, ...ellipsis }}>{v.name}</span>
                <span style={mono(12, 'var(--text-2)', { flex: 'none' })}>{v.used} / {v.cap}</span>
                <span style={mono(12, 'var(--mut-3)', { width: 36, flex: 'none', textAlign: 'right' })}>{v.pct}%</span>
              </div>
              <Bar pct={v.pct} />
            </div>
          ) : <VolumeRow key={v.name} v={v} />))}
          {!h.storage.length && <Empty>{whyMissing(snap, 'prom-infra', 'Storage')}</Empty>}
        </div>
        <div style={SECTION}>
          <SectionTitle sm={SM} id="health-software" title="Software" sub={h.versions.some(v => v.updates) ? 'versions in use · apt updates' : 'versions in use'} />
          {h.versions.map(v => (
            <div key={v.name} style={row(10, { minHeight: 40, borderBottom: RULE3 })}>
              {v.updates
                ? <div style={{ flex: 1, minWidth: 0, ...flexCol(1, { padding: '4px 0' }) }}>
                  <span style={{ fontSize: 13, fontWeight: 600, ...ellipsis }}>{v.name}</span><UpdatesLine u={v.updates} />
                  {v.guestUpdates && <GuestUpdates us={v.guestUpdates} />}
                </div>
                : <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, ...ellipsis }}>{v.name}</span>}
              {v.badge && <span style={{ padding: '2px 6px', borderRadius: 5, background: 'var(--warn-bg)', color: 'var(--warn)', fontSize: 11, fontWeight: 700 }}>{v.badge}</span>}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                <span style={mono(12, v.live ? 'var(--mut-1)' : 'var(--mut-3)')}>{v.version}</span>
                {!v.live && <span style={{ fontSize: 11, color: 'var(--mut-3)' }} title="Typed into homelab.json; no adapter can read this version">manual{v.asOf ? ` · as of ${v.asOf}` : ''}</span>}
              </div>
            </div>
          ))}
        </div>
        {sectionOn(snap, 'exposure') && <>
        <div style={SECTION}>
          <SectionTitle sm={SM} id="health-exposure" title="Public exposure" sub={h.exposure.length ? `${ex.healthy.length} of ${ex.probed.length} probed up · ${ex.forwards.length} port-forwards` : undefined} />
          {ex.problems.map((x, i) => (
            <div key={`${x.host}-${i}`} style={row(EX_GAP, { minHeight: 46, padding: '4px 0', borderBottom: RULE3 })} title={`${x.origin}${x.access ? ` · ${x.access}` : ''}`}>
              <StatusDot status={x.status} />
              <div style={{ flex: 1, minWidth: 0, ...flexCol(1) }}>
                <span style={row(6, { fontSize: 13, fontWeight: 600, minWidth: 0 })}><span style={ellipsis}>{x.name}</span>{x.access && <Tag>{x.access}</Tag>}</span>
                <span style={{ fontSize: 11, color: 'var(--mut-3)', ...ellipsis }}>
                  {x.url ? <Ext href={x.url} arrow={false} style={{ color: 'var(--mut-2)' }}>{x.host}</Ext> : x.host} · {x.origin}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', flex: 'none' }}>
                <span style={mono(11, x.code == null ? 'var(--mut-3)' : statusColor(x.status))}>{x.code ?? '—'}</span>
                <span style={mono(11, 'var(--mut-3)')}>{x.via}</span>
              </div>
            </div>
          ))}
          {ex.healthy.map((x, i) => (
            <div key={`${x.host}-${i}`} style={row(EX_GAP, { minHeight: 36, boxSizing: 'border-box', borderBottom: RULE3 })} title={`${x.origin} · ${x.via}`}>
              <StatusDot status={x.status} />
              <span style={{ maxWidth: 160, flex: 'none', minWidth: 0, fontSize: 13, fontWeight: 600, ...ellipsis }}>{x.name}</span>
              {x.access && <Tag>{x.access}</Tag>}
              <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--mut-3)', ...ellipsis }}>{x.url ? <Ext href={x.url} arrow={false} style={{ color: 'var(--mut-3)' }}>{x.host}</Ext> : x.host}</span>
              <span style={mono(11, 'var(--mut-1)', { flex: 'none' })}>{x.code ?? '—'}</span>
            </div>
          ))}
          {ex.forwards.map((x, i) => (
            <div key={`${x.host}-${i}`} data-forwards style={row(EX_GAP, { minHeight: 36, boxSizing: 'border-box', borderBottom: RULE3 })} title={`${x.host} → ${x.origin} · port-forward`}>
              {x.status === 'unknown' ? <Dot size={7} color="var(--pub)" /> : <StatusDot status={x.status} />}
              <span style={{ maxWidth: 160, flex: 'none', minWidth: 0, fontSize: 13, fontWeight: 600, ...ellipsis }}>{x.name}</span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: 'var(--mut-3)', ...ellipsis }}>{x.host}</span>
              <span style={mono(11, x.status === 'up' ? 'var(--mut-1)' : x.status === 'unknown' ? 'var(--pub-fg)' : statusColor(x.status), { flex: 'none' })}>{x.note ?? 'not probed'}</span>
            </div>
          ))}
          {h.orphans.map(o => (
            <div key={o.host} style={row(EX_GAP, { minHeight: 36, boxSizing: 'border-box', borderBottom: RULE3 })} title="Retired host that still resolves (a note: delete its DNS record)">
              <Dot size={7} color="var(--info)" />
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: 'var(--info)', ...ellipsis }}>{o.host}</span>
              <span style={mono(11, 'var(--info-sub)')}>orphan{o.code != null ? ` · ${o.code}` : ''}</span>
            </div>
          ))}
          {!h.exposure.length && <Empty>{whyMissing(snap, 'probes', 'Public probes')}</Empty>}
        </div>
        </>}
      </div>

      <div style={SECTION}>
        <SectionTitle sm={SM} id="health-sources" title="Sources" sub={sourcesLine(snap.sources)} />
        <SourceRows sources={snap.sources} />
      </div>

      {/* review Phase 5: the former Devices tab, last (reached from the index and ⌘K) */}
      <div style={SECTION}><DevicesSection sm={SM} /></div>
    </div>
  );
}

/** Sources in two columns, each row with its heartbeat (review 3c); its own component so the traces' 1 s clock
 *  re-renders only these rows */
function SourceRows({ sources }: { sources: SourceView[] }) {
  const beatT = useBeatClock();
  return (
    <div style={TWO}>
      {twoCols(sourcesFirst(sources)).map((col, i) => (
        <div key={i} style={flexCol()}>
          {col.map(s => { const c = CONN[s.conn], note = s.error ?? (s.conn === 'not-connected' && s.needs ? `needs ${s.needs}` : ''); return (
            <div key={s.name} style={row(12, { minHeight: 32, borderBottom: RULE3 })}>
              <span style={{ width: 170, flex: 'none', fontSize: 13, fontWeight: 600, ...ellipsis }} title={s.name}>{s.label}</span>
              <span style={{ width: 92, flex: 'none' }}><span style={{ padding: '1px 7px', borderRadius: 99, border: `1px solid ${c.c}`, color: c.c, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{c.label}</span></span>
              <span style={mono(11.5, 'var(--mut-2)', { width: 74, flex: 'none' })} title={`every ${s.everySec} s · max age ${s.maxAgeSec} s`}>{s.lastOk == null ? '—' : ago(s.lastOk)}</span>
              <Heartbeat s={s} t={beatT} />
              {note && <span style={{ flex: '0 1 auto', maxWidth: 170, minWidth: 0, fontSize: 12, color: s.error ? 'var(--danger-sub)' : 'var(--mut-3)', ...ellipsis }} title={s.error ?? s.needs}>{note}</span>}
            </div>
          ); })}
        </div>
      ))}
    </div>
  );
}
