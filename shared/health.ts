// Health tab view logic shared by the desktop and phone layouts (pure: no React, no CSS). Problems first in every
// list; job families share one line (pills per member) so 23 healthy backup rows don't push the page apart.
import type { JobView, ModuleId, Monitor, OpsTone, Snapshot, Status, Tone, Volume } from './types.ts';
import { DISK_WARN } from './rules.ts';

type H = Snapshot['health'];

export const STATUS_RANK: Record<Status, number> = { down: 0, degraded: 1, unknown: 2, up: 3 };
const TONE_RANK: Record<Tone, number> = { danger: 0, warn: 1, ok: 2 };

/** down > degraded > unknown (no data) > up */
export const worseStatus = (a: Status, b: Status): Status => (STATUS_RANK[a] <= STATUS_RANK[b] ? a : b);
export const worstStatus = (ss: Status[]): Status => ss.reduce(worseStatus, 'up');
export const worseTone = (a: Tone, b: Tone): Tone => (TONE_RANK[a] <= TONE_RANK[b] ? a : b);

/** A stable sort by rank (lower first); equal ranks keep their order. */
export function problemsFirst<T>(items: readonly T[], rank: (x: T) => number): T[] {
  return items.map((x, i) => ({ x, i, r: rank(x) })).sort((a, b) => a.r - b.r || a.i - b.i).map(e => e.x);
}

/** One line on Health: a family's rows (or a single row, passed through as a one-member group). */
export interface JobGroup {
  /** JobView.family, or the row's own name when it has none */
  family: string;
  members: JobView[];
  /** the worst member's status */
  status: Status;
  /** a member that isn't up is critical (the line takes the red tier) */
  critical: boolean;
  /** members' 14-day strips merged day by day (aligned on the newest day); null when no member has history */
  days: Status[] | null;
  /** the member whose last run is oldest (its age stands for the line) */
  ageMember: JobView;
}

/** Per day, right-aligned (newest last): down if any member is down, else degraded, else up, else unknown.
 *  Members with no history (null) are skipped; a shorter strip simply has no say on the older days. */
export function mergeDays(list: readonly (Status[] | null | undefined)[]): Status[] | null {
  const ds = list.filter((d): d is Status[] => Array.isArray(d) && d.length > 0);
  if (!ds.length) return null;
  const n = Math.max(...ds.map(d => d.length));
  return Array.from({ length: n }, (_, i) => {
    const day = ds.map(d => d[d.length - n + i]).filter((s): s is Status => s != null);
    return day.includes('down') ? 'down' : day.includes('degraded') ? 'degraded' : day.includes('up') ? 'up' : 'unknown';
  });
}

/** The label of a row inside its family's line ('Paperless', 'appdata'). */
export const shortLabel = (j: JobView) => j.short || j.name;

/** Rows that share a family make one group, placed where its first member is; rows without a family (or the only
 *  member of one) pass through as one-member groups. Groups are sorted problems first, ties keep config order. */
export function groupJobs(rows: readonly JobView[]): JobGroup[] {
  const by = new Map<string, JobView[]>();
  for (const j of rows) {
    const k = j.family ? `f:${j.family}` : `j:${j.id}`;
    const g = by.get(k);
    if (g) g.push(j); else by.set(k, [j]);
  }
  const groups = [...by.values()].map((members): JobGroup => {
    const status = worstStatus(members.map(m => m.status));
    const dated = members.filter(m => m.lastAt != null);
    const ageMember = dated.length ? dated.reduce((a, b) => (b.lastAt! < a.lastAt! ? b : a)) : members[0];
    return {
      family: members.length > 1 ? members[0].family! : members[0].name, members, status,
      critical: members.some(m => m.status !== 'up' && !!m.critical),
      days: mergeDays(members.map(m => m.days)), ageMember,
    };
  });
  return problemsFirst(groups, g => STATUS_RANK[g.status]);
}

/** Which members show as rows under a group: all when opened (problems first, the rest in config order), otherwise
 *  the ones that aren't up. */
export const shownMembers = (g: JobGroup, open: boolean) =>
  (open ? problemsFirst(g.members, m => STATUS_RANK[m.status]) : g.members.filter(m => m.status !== 'up'));

/** A compact row in Automation: a job row (the NFS and pipeline signals merged into theirs), or a fallback row
 *  for a signal whose job row is missing. */
export interface AutoRow {
  /** the row to draw; status is the merged one (the dot), detail the merged text */
  job: JobView;
  /** false: a fallback row with no job behind it (no #job- anchor) */
  anchor: boolean;
  /** the detail text's colour: a status (statusColor) or 'warn'; absent = the job's own tier (jobText) */
  detailColor?: Status | 'warn';
  /** dot coloured by its status (statusColor) rather than a job's tier (a fallback row) */
  plain?: boolean;
  /** tooltip; absent = 'where · schedule' */
  title?: string;
  /** the detail is a merged signal: the phone puts it before 'where' */
  lead?: boolean;
}
export type AutoUnit = { kind: 'row'; row: AutoRow; status: Status } | { kind: 'group'; group: JobGroup; status: Status };


/** An ops tone (plans H5-H13) as a row status: danger is down, warn degraded, no data unknown. */
export const opsStatus = (t: OpsTone): Status => (t === 'danger' ? 'down' : t === 'warn' ? 'degraded' : t === 'none' ? 'unknown' : 'up');

/** Automation's units: every automation job except the ones an Alerting row stands for, and jobs that share a family
 *  as one group. Problems first, ties in config order. */
export function automationRows(h: Pick<H, 'jobs' | 'alerting'>): AutoUnit[] {
  const inAlerting = new Set(h.alerting.map(a => a.job).filter(Boolean));
  const jobs = h.jobs.filter(j => j.group === 'automation' && !inAlerting.has(j.id));
  const units: AutoUnit[] = [];
  for (const g of groupJobs(jobs).sort((a, b) => jobs.indexOf(a.members[0]) - jobs.indexOf(b.members[0]))) {
    if (g.members.length > 1) { units.push({ kind: 'group', group: g, status: g.status }); continue; }
    units.push(rowUnit({ job: g.members[0], anchor: true }));
  }
  return problemsFirst(units, u => STATUS_RANK[u.status]);
}
const rowUnit = (row: AutoRow): AutoUnit => ({ kind: 'row', row, status: row.job.status });

/** Rows counted in a section's 'N of M ok': a group counts each member. */
export const unitRows = (units: readonly AutoUnit[]) => units.flatMap(u => (u.kind === 'group' ? u.group.members.map(m => m.status) : [u.status]));

/** A job's status in Alerting's tones: no data is 'warn' (as the row's own 'no data'), a failure the job's tier. */
export const jobTone = (j: Pick<JobView, 'status' | 'critical'>): Tone => (j.status === 'up' ? 'ok' : j.status === 'unknown' ? 'warn' : j.critical ? 'danger' : 'warn');

export type AlertingRow = H['alerting'][number] & { /** the job behind the row (watchdogs) */ jobRow?: JobView };
/** Alerting: the watchdog rows absorb their jobs (tone = the worse of the two), problems first. */
export function alertingRows(h: Pick<H, 'alerting' | 'jobs'>): AlertingRow[] {
  const rows = h.alerting.map((a): AlertingRow => {
    const j = a.job ? h.jobs.find(x => x.id === a.job) : undefined;
    return j ? { ...a, tone: worseTone(a.tone, jobTone(j)), jobRow: j } : { ...a };
  });
  return problemsFirst(rows, a => TONE_RANK[a.tone]);
}

/** Public exposure: problem endpoints, healthy probed ones (config order), then the port-forwards (one row). */
export function exposureParts(h: Pick<H, 'exposure'>) {
  const probed = h.exposure.filter(x => x.via !== 'port-forward');
  return {
    probed,
    problems: probed.filter(x => x.status !== 'up'),
    healthy: probed.filter(x => x.status === 'up'),
    forwards: h.exposure.filter(x => x.via === 'port-forward'),
  };
}

/** Storage: the array row with its disks under it, then the rest. No array row: its disks are ordinary rows. */
export function storageParts(h: Pick<H, 'storage'>) {
  const parent = h.storage.find(v => !v.under && h.storage.some(d => d.under === v.name));
  const disks = parent ? h.storage.filter(v => v.under === parent.name) : [];
  return { parent: parent ?? null, disks, rest: h.storage.filter(v => v !== parent && !disks.includes(v)) };
}

/** Sources: error, stale, not connected, then the rest. */
const SRC_RANK: Record<string, number> = { error: 0, stale: 1, 'not-connected': 2 };
export const sourcesFirst = <T extends { conn: string }>(s: readonly T[]) => problemsFirst(s, x => SRC_RANK[x.conn] ?? 3);

// ---- the section index (review finding 13): one entry per Health section, its worst tier and one state line
export interface IndexEntry {
  id: 'alerts' | 'uptime' | 'backups' | 'automation' | 'alerting' | 'storage' | 'exposure' | 'sources' | 'devices';
  name: string;
  /** the section's existing anchor (health-<id>, both layouts) */
  anchor: string;
  /** the section's worst tier as the section itself draws it: ok = nothing to look at (grey), no data stays grey */
  tone: Tone;
  state: string;
}
/** devices: Health › Devices (review Phase 5); optional, so an index without it reads 'Not connected' */
type IndexSnap = Pick<Snapshot, 'alerts' | 'health' | 'sources' | 'at'> & { devices?: Snapshot['devices']; modules?: Snapshot['modules'] };
type Line = Pick<IndexEntry, 'tone' | 'state'>;
const more = (n: number) => (n > 0 ? ` +${n}` : '');
/** A section whose source sent nothing: grey while it isn't connected, amber while it isn't answering (Sources says why). */
function gap(s: IndexSnap, src: string): Line {
  const c = s.sources.find(x => x.name === src)?.conn;
  return c === 'stale' || c === 'error' ? { tone: 'warn', state: 'Not answering' } : c === 'ok' || c === 'mock' ? { tone: 'ok', state: 'No data' } : { tone: 'ok', state: 'Not connected' };
}
/** '1 late · Kopia → B2 +2': how many share the worst status, the first one's name, how many other problems. */
function worstLine<T>(bad: readonly T[], status: (x: T) => Status, name: (x: T) => string, word: Record<Status, string>, tone: Tone): Line {
  const n = bad.filter(x => status(x) === status(bad[0])).length;
  return { tone, state: `${n} ${word[status(bad[0])].replace(/^need /, n === 1 ? 'needs ' : 'need ')} · ${name(bad[0])}${more(bad.length - n)}` };
}
const JOB_WORD: Record<Status, string> = { down: 'failed', degraded: 'late', unknown: 'no data', up: 'ok' };
const AUTO_WORD: Record<Status, string> = { ...JOB_WORD, degraded: 'need a look' };
/** a failing or overdue row's tier, as its dot shows it: red for a critical one, amber otherwise; no data stays grey */
const failTone = (status: Status, critical: boolean): Tone => (status === 'up' || status === 'unknown' ? 'ok' : critical ? 'danger' : 'warn');
const worstTone = (ts: Tone[]) => ts.reduce(worseTone, 'ok');

function alertsLine(s: IndexSnap): Line {
  if (s.alerts == null) return gap(s, 'grafana');
  const firing = s.alerts.filter(a => a.severity !== 'info'), info = s.alerts.length - firing.length;
  if (!firing.length) return { tone: 'ok', state: info ? `Nothing firing · ${info} info` : 'Nothing firing' };
  return { tone: firing.some(a => a.severity === 'danger') ? 'danger' : 'warn', state: `${firing.length} firing` };
}
function uptimeLine(s: IndexSnap): Line {
  const mons = [...s.health.monitors, ...s.health.unmapped].filter(m => m.kumaId != null);
  if (!mons.length) return gap(s, 'kuma');
  const name = (m: Monitor) => m.label || m.name;
  const bad = problemsFirst(mons.filter(m => m.status === 'down' || m.status === 'degraded'), m => STATUS_RANK[m.status]);
  if (bad.length) return worstLine(bad, m => m.status, name, { ...JOB_WORD, down: 'down', degraded: 'degraded' }, bad[0].status === 'down' ? 'danger' : 'warn');
  // the uptime rows show a certificate expiring within 14 days in amber
  const cert = mons.filter(m => m.certDays != null && m.certDays <= 14).sort((a, b) => a.certDays! - b.certDays!);
  if (cert.length) return { tone: 'warn', state: `cert ${cert[0].certDays} d · ${name(cert[0])}${more(cert.length - 1)}` };
  const unk = mons.filter(m => m.status === 'unknown').length;
  return { tone: 'ok', state: unk ? `${mons.length - unk} of ${mons.length} up · ${unk} no data` : 'All up' };
}
function backupsLine(s: IndexSnap): Line {
  const rows = s.health.jobs.filter(j => j.group === 'backup');
  if (!rows.length) return gap(s, 'prom-jobs');
  const bad = problemsFirst(rows.filter(j => j.status !== 'up'), j => STATUS_RANK[j.status]);
  if (!bad.length) return { tone: 'ok', state: 'All on time' };
  return worstLine(bad, j => j.status, j => j.family || j.name, JOB_WORD, worstTone(bad.map(j => failTone(j.status, !!j.critical))));
}
function automationLine(s: IndexSnap): Line {
  const units = automationRows(s.health);
  if (!units.length) return gap(s, 'prom-jobs');
  const bad = units.filter(u => u.status !== 'up'); // already problems first
  if (!bad.length) return { tone: 'ok', state: 'All on time' };
  // as each row's dot: a group's or job's tier, a merged signal's (plain) status colour
  const tone = (u: AutoUnit) => (u.kind === 'group' ? failTone(u.status, u.group.critical) : failTone(u.status, u.row.plain ? u.status === 'down' : !!u.row.job.critical));
  return worstLine(bad, u => u.status, u => (u.kind === 'group' ? u.group.family : u.row.job.name), AUTO_WORD, worstTone(bad.map(tone)));
}
function alertingLine(s: IndexSnap): Line {
  const bad = alertingRows(s.health).filter(a => a.tone !== 'ok');
  if (!bad.length) return { tone: 'ok', state: 'All paths ok' };
  return { tone: bad[0].tone, state: bad.length === 1 ? `${bad[0].name} · ${bad[0].state}` : `${bad.length} need a look · ${bad[0].name}` };
}
function storageLine(s: IndexSnap): Line {
  const vs = s.health.storage;
  if (!vs.length) return gap(s, 'prom-infra');
  const bad = problemsFirst(vs.filter(v => v.tone !== 'ok'), v => TONE_RANK[v.tone]);
  if (bad.length) return { tone: bad[0].tone, state: `${bad[0].name} · ${bad[0].missing ? 'no figures' : `${bad[0].pct}%`}${more(bad.length - 1)}` };
  // the array and cache warn later than DISK_WARN, so 'all under 85%' is only said when it's true
  const top = vs.filter(v => !v.missing).reduce<Volume | null>((a, v) => (!a || v.pct > a.pct ? v : a), null);
  return { tone: 'ok', state: !top || top.pct < DISK_WARN ? `All under ${DISK_WARN}%` : `Fullest ${top.pct}% · ${top.name}` };
}
function exposureLine(s: IndexSnap): Line {
  if (!s.health.exposure.length) return gap(s, 'probes');
  const ex = exposureParts(s.health);
  // a probe without data stays grey (as its dot); a port-forward is a problem only when its own check fails
  const bad = problemsFirst([...ex.problems, ...ex.forwards].filter(x => x.status === 'down' || x.status === 'degraded'), x => STATUS_RANK[x.status]);
  if (bad.length) return worstLine(bad, x => x.status, x => x.name, { ...JOB_WORD, down: 'down', degraded: 'degraded' }, bad[0].status === 'down' ? 'danger' : 'warn');
  return { tone: 'ok', state: `${ex.healthy.length} of ${ex.probed.length} up` };
}
function sourceLine(s: IndexSnap): Line {
  const bad = sourcesFirst(s.sources.filter(x => x.conn === 'stale' || x.conn === 'error'));
  if (!bad.length) return { tone: 'ok', state: 'All answering' };
  // as the Sources pills: error red, stale amber
  return { tone: bad[0].conn === 'error' ? 'danger' : 'warn', state: `${bad.length} not answering · ${bad[0].label}` };
}

function devicesLine(s: IndexSnap): Line {
  const d = s.devices;
  if (!d) return gap(s, 'devices');
  // as the rows' dots: an offline infra device is red, a smart-home one amber (their own sources, even without the list)
  for (const [id, tone] of [['infra', 'danger'], ['home', 'warn']] as const) {
    const off = d.groups.find(g => g.id === id)?.rows.filter(r => r.status === 'down') ?? [];
    if (off.length) return { tone, state: `${off.length} offline · ${off[0].name}${more(off.length - 1)}` };
  }
  if (!d.counts) return gap(s, 'devices');
  return { tone: 'ok', state: [`${d.counts.lanOnline} online`, ...d.counts.segments.map(x => `${x.online} ${x.name}`)].join(' · ') };
}

/** Health's index, in page order: Alerts, Uptime, Backups, Automation, Alerting, Storage, Exposure, Sources, Devices. */
/** Sections that belong to a module: left out while it's off (Health hides the section too). */
export const SECTION_MODULE: Partial<Record<IndexEntry['id'], ModuleId>> = { alerts: 'grafana', uptime: 'kuma', exposure: 'probes' };
export const sectionOn = (s: Pick<IndexSnap, 'modules'>, id: IndexEntry['id']) => { const m = SECTION_MODULE[id]; return !m || (s.modules?.[m] ?? 'on') !== 'off'; };
export function sectionIndex(s: IndexSnap): IndexEntry[] {
  const e = (id: IndexEntry['id'], name: string, l: Line): IndexEntry => ({ id, name, anchor: `health-${id}`, ...l });
  return ([
    e('alerts', 'Alerts', alertsLine(s)), e('uptime', 'Uptime', uptimeLine(s)), e('backups', 'Backups', backupsLine(s)),
    e('automation', 'Automation', automationLine(s)), e('alerting', 'Alerting', alertingLine(s)), e('storage', 'Storage', storageLine(s)),
    e('exposure', 'Exposure', exposureLine(s)), e('sources', 'Sources', sourceLine(s)), e('devices', 'Devices', devicesLine(s)),
  ]).filter(x => sectionOn(s, x.id));
}
