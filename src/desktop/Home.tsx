import { useState } from 'react';
import { useApp } from '../state.tsx';
import { agoText, secSince } from '../lib/util.ts';
import { Dot, Ext, NotConnected, StatusDot, ellipsis, eyebrow, flexCol, mono, row, ruled } from '../lib/ui.tsx';
import type { Snapshot } from '../../shared/types.ts';
import { UpsHomeRow } from './Ops.tsx';

type HomeSnap = Snapshot['home'];
const modeText = (m: string) => m.split('_').map(w => w[0]?.toUpperCase() + w.slice(1)).join('/');

/**
 * Home Assistant's real state, read-only (CC rule 1 and ~/code/homeassistant rules): nothing local
 * overrides it, there is no made-up setpoint or mode, and an unavailable entity reads 'Unavailable'.
 * Nothing on the Home tab looks like a control; the one way to act is the 'Open in Home Assistant' link.
 */
type Climate = { indoor: number; setpoint: number | null; setpointRange?: [number, number] | null; mode: string; action: string | null; available: boolean };
/** The dial's text and colours for one thermostat (the main one, or one of moreClimates) */
export function climateState(c: Climate | null) {
  const cl = c?.available ? c : null;
  const mode = cl?.mode.toLowerCase() ?? '';
  // heat_cool / auto / off have no single target, so they get the neutral 'set' wording
  const verb = mode === 'cool' ? 'cool' : mode === 'heat' ? 'heat' : 'set';
  const tone = verb === 'cool' ? 'var(--accent)' : verb === 'heat' ? 'var(--heat)' : 'var(--mut-3)';
  const sp = cl?.setpoint ?? null, range = cl?.setpointRange ?? null;
  return {
    sp, range, tone, mode: cl ? modeText(cl.mode) : null,
    spText: sp != null ? `${sp.toFixed(1)}°` : range ? `${range[0].toFixed(1)}–${range[1].toFixed(1)}°` : '—',
    spLabel: sp != null ? `${verb} to` : range ? 'heat · cool range' : mode === 'off' ? 'thermostat off' : 'no setpoint',
    spColor: sp == null && !range ? 'var(--mut-3)' : tone,
  };
}
export function homeState(h: HomeSnap) {
  const gOpen = h.garage?.available ? h.garage.open : null;
  return {
    ...climateState(h.climate),
    gOpen, garageWord: !h.garage ? '—' : gOpen == null ? 'Unavailable' : gOpen ? 'Open' : 'Closed',
    garageSub: !h.garage ? '' : h.garage.available ? h.garage.sub : 'Unavailable in Home Assistant',
  };
}

export const TONER = { c: 'var(--toner-c)', m: 'var(--toner-m)', y: 'var(--toner-y)', k: 'var(--text-2)' } as const;
/** CMYK toner bars; null (printer off / unavailable) renders empty bars. */
export const Toner = ({ t }: { t: { c: number; m: number; y: number; k: number } | null }) => (
  <div style={{ display: 'flex', gap: 6 }} role="img" aria-label={t ? `toner C ${t.c}%, M ${t.m}%, Y ${t.y}%, K ${t.k}%` : 'toner: no data'}>
    {(['c', 'm', 'y', 'k'] as const).map(k => (
      <div key={k} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3 }} title={t ? `${k.toUpperCase()} ${t[k]}%` : 'no data'}>
        <div style={{ width: 6, height: 22, borderRadius: 3, background: 'var(--rule-3)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden' }}>{t && <div style={{ height: `${t[k]}%`, background: TONER[k] }} />}</div>
        <span style={mono(11, 'var(--mut-3)')}>{k.toUpperCase()}</span>
      </div>
    ))}
  </div>
);

const SMOKE: Record<HomeSnap['smoke'][number]['state'], [string, string]> = {
  clear: ['var(--ok)', 'Clear'], alarm: ['var(--danger)', 'ALARM'], offline: ['var(--warn)', 'Offline'], fault: ['var(--warn)', 'Fault'], 'no-data': ['var(--mut-3)', 'No data'],
};
// an unavailable lock has an amber attention item, so it reads amber here too
const LOCK: Record<HomeSnap['locks'][number]['state'], [string, string]> = {
  locked: ['var(--ok)', 'Locked'], unlocked: ['var(--warn)', 'Unlocked'], jammed: ['var(--danger)', 'Jammed'], unavailable: ['var(--warn)', 'Unavailable'], 'no-data': ['var(--mut-3)', 'No data'],
};
type Lock = HomeSnap['locks'][number];
/** The lock's sub-line: its door (or why there's none). A lock without a jam sensor isn't flagged. */
export function lockNotes(l: Lock) {
  const noData = l.state === 'no-data' || l.state === 'unavailable';
  const door = l.door ? `door ${l.door}` : l.sensors?.door === false ? 'no door sensor' : noData ? '' : 'door: no data';
  return { door };
}
/** Below this a lock battery reads amber (homelab.json attentionRules.lockBatteryWarnPct drives the attention item). */
const LOCK_BATTERY_LOW = 30, TONER_LOW = 10;
export const smokeLook = (s: HomeSnap['smoke'][number]['state']) => SMOKE[s];
type Light = HomeSnap['lights'][number];
/** [dot, word colour, word]: on reads 'On · 80%' (no % for on/off-only lights), off and no-data stay quiet */
export const lightLook = (l: Light): [string, string, string] => (!l.available || l.on == null ? ['var(--mut-5)', 'var(--mut-3)', l.available ? 'No data' : 'Unavailable']
  : l.on ? ['var(--accent)', 'var(--accent)', l.brightness != null && l.brightness < 100 ? `On · ${l.brightness}%` : 'On'] : ['var(--mut-5)', 'var(--mut-3)', 'Off']);
type Appliance = HomeSnap['appliances'][number];
const hm = (min: number) => (min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.round(min)} min`);
const deg = (c: number | null | undefined) => (c == null ? null : `${c.toFixed(1)}°`);
/** One appliance card's text: the big word, its colour, sub-lines (warn = amber) and a progress bar while running. */
export function applianceView(a: Appliance): { word: string; tone: string; lines: { text: string; warn?: boolean }[]; progress: number | null } {
  const lines: { text: string; warn?: boolean }[] = [];
  const add = (text: string | false | null | undefined, warn = false) => { if (text) lines.push({ text, warn }); };
  if (a.state === 'no-data') return { word: 'No data', tone: 'var(--mut-3)', lines: [], progress: null };
  if (a.kind === 'thermostat' || a.kind === 'bed') {
    const st = a.state === 'heating' ? 'Heating' : a.state === 'cooling' ? 'Cooling' : a.state === 'off' ? 'Off' : 'Idle';
    add([a.kind === 'bed' ? `bed · ${st.toLowerCase()}` : st, a.state !== 'off' && a.targetC != null && `set ${deg(a.targetC)}`].filter(Boolean).join(' · '));
    if (a.kind === 'thermostat') add(a.battery != null && `battery ${a.battery}%`, a.battery != null && a.battery < 20);
    return { word: deg(a.tempC) ?? '—', tone: a.state === 'heating' ? 'var(--heat)' : a.state === 'cooling' ? 'var(--accent)' : 'var(--text)', lines, progress: null };
  }
  const busy = a.state === 'running' || a.state === 'cleaning';
  const word = { running: 'Running', on: 'On', off: 'Off', cleaning: 'Cleaning', charging: 'Charging', docked: 'Docked', heating: 'Heating', cooling: 'Cooling', idle: 'Idle' }[a.state];
  if (a.kind === 'vacuum') {
    add(busy ? a.progress != null && `${a.progress}% done` : a.lastAt != null && `last clean ${agoText(secSince(a.lastAt))} ago`);
    add(a.battery != null && `battery ${a.battery}%`);
    const m = a.maintenance;
    if (m) add(m.hoursLeft <= 0 ? `${m.name}: clean now (${-m.hoursLeft} h overdue)` : `${m.name} due in ${m.hoursLeft} h`, m.hoursLeft <= 0);
  } else {
    add(busy && [a.remainingMin != null && `${hm(a.remainingMin)} left`, a.progress != null && `${a.progress}%`,
      a.finishAt != null && `done at ${new Date(a.finishAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`].filter(Boolean).join(' · '));
    add(a.energyTodayKwh != null && a.energyTodayKwh > 0 && `${a.energyTodayKwh.toFixed(1)} kWh today`);
  }
  return { word, tone: busy ? 'var(--accent)' : a.state === 'charging' ? 'var(--ok)' : 'var(--mut-3)', lines, progress: busy ? a.progress : null };
}
export const lightsSub = (ls: Light[]) => { const on = ls.filter(l => l.on).length; return ls.some(l => l.available) ? `${on} of ${ls.length} on` : undefined; };
export const lockLook = (s: HomeSnap['locks'][number]['state']) => LOCK[s];

/** The thermostat's target line (review finding 19): what it's doing now, coloured by that: 'heating to 21.0°' in
 *  heat, 'cooling to …' in accent, otherwise 'set to …' in grey (the mode is on the next line). */
export function climateTarget(cl: Climate): { text: string; color: string } {
  const c = climateState(cl), a = (cl.action ?? '').toLowerCase();
  const verb = a === 'heating' ? 'heating' : a === 'cooling' ? 'cooling' : 'set';
  const color = verb === 'heating' ? 'var(--heat)' : verb === 'cooling' ? 'var(--accent)' : 'var(--mut-3)';
  return c.sp == null && !c.range ? { text: c.spLabel, color: 'var(--mut-3)' } : { text: `${verb} to ${c.spText}`, color };
}
/** 'Garage thermostat · 16.8° · idle': an extra thermostat as one line (finding 19); the rest is in its tooltip. */
export function climateLine(m: HomeSnap['moreClimates'][number]) {
  const c = climateState(m);
  return {
    temp: m.available ? `${m.indoor.toFixed(1)}°` : null, word: m.available ? (m.action || (c.mode ?? '—')).toLowerCase() : 'unavailable',
    heating: m.available && m.action === 'heating',
    title: m.available ? [`${c.spLabel} ${c.spText}`, c.mode && `mode ${c.mode}`, m.battery != null && `battery ${Math.round(m.battery)}%`].filter(Boolean).join(' · ') : 'Unavailable in Home Assistant',
  };
}

/** A thermostat as a readout, nothing dial-like (finding 19): indoor temperature, then what it's doing and the
 *  humidity · outside · mode line. */
export function ClimateReadout({ cl, outside, humidity }: { cl: Climate; outside: number | null; humidity: number | null }) {
  if (!cl.available) return <span style={{ fontSize: 13, color: 'var(--mut-3)' }}>Unavailable in Home Assistant</span>;
  const c = climateState(cl), t = climateTarget(cl);
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, minWidth: 0 }}>
      <span style={mono(34, undefined, { fontWeight: 500, lineHeight: 1, flex: 'none' })}>{cl.indoor.toFixed(1)}°</span>
      <div style={flexCol(2, { minWidth: 0 })}>
        <span style={{ fontSize: 13, fontWeight: 600, color: t.color, ...ellipsis }}>{t.text}</span>
        <span style={{ fontSize: 12, color: 'var(--mut-3)', ...ellipsis }}>{[humidity != null && `${humidity}% humidity`, outside != null && `${outside.toFixed(1)}° outside`, c.mode].filter(Boolean).join(' · ')}</span>
      </div>
    </div>
  );
}

/** Behind the climate readout (review 3b): while the furnace runs, 14 warm particles rise and fade over a breathing
 *  glow; while the AC runs, cool ones sink from the top. Idle, off or anything else: nothing. Keyed by the action, so
 *  a tick doesn't restart it. */
function ClimateFx({ action }: { action: string | null }) {
  const a = (action ?? '').toLowerCase(), heat = a === 'heating';
  if (!heat && a !== 'cooling') return null;
  return (
    <div key={a} aria-hidden="true" style={{ position: 'absolute', inset: 0, zIndex: -1, pointerEvents: 'none' }}>
      <div data-motion="" style={{ position: 'absolute', inset: 0, background: `radial-gradient(ellipse 50% 85% at 48% ${heat ? '100%' : '0%'}, ${heat ? 'var(--heat-glow)' : 'var(--cool-glow)'}, transparent 70%)`, animation: 'cc-breathe 3.2s ease-in-out infinite' }} />
      {Array.from({ length: 14 }, (_, k) => { const size = 3 + (k % 3); return (
        <span key={k} data-motion="" style={{ position: 'absolute', left: `${28 + ((k * 37) % 44)}%`, [heat ? 'bottom' : 'top']: -6, width: size, height: size, borderRadius: '50%', background: heat ? 'var(--heat)' : 'var(--accent)', opacity: 0, animation: `${heat ? 'cc-rise' : 'cc-fall'} ${(2.3 + (k % 4) * 0.4).toFixed(1)}s ease-out infinite`, animationDelay: `${(-k * 0.31).toFixed(2)}s` }} />
      ); })}
    </div>
  );
}

/** Home's one-line answer (review finding 18): the worst of the locks, the garage and the detectors as the headline,
 *  the three of them in the sub-line. Never claims 'locked' or 'clear' for something with no data. */
export type HomeTier = 'danger' | 'warn' | 'none' | 'ok';
export function homeSummary(h: HomeSnap): { tier: HomeTier; headline: string; since: number | null; sub: string } {
  const items: { tier: HomeTier; text: string; since?: number | null }[] = [];
  const add = (tier: HomeTier, text: string, since?: number | null) => items.push({ tier, text, since });
  for (const s of h.smoke) {
    if (s.state === 'alarm') add('danger', `Smoke alarm · ${s.name}`);
    else if (s.state === 'offline' || s.state === 'fault') add('warn', `${s.name} ${s.state}`);
    else if (s.state === 'no-data') add('none', `${s.name}: no data`);
  }
  for (const l of h.locks) {
    if (l.state === 'jammed') add('danger', `${l.name} jammed`, l.since);
    else if (l.state === 'unlocked') add('warn', `${l.name} unlocked`, l.since);
    else if (l.state === 'unavailable') add('warn', `${l.name} unavailable`, l.since);
    else if (l.state === 'no-data') add('none', `${l.name}: no data`);
    if (l.door === 'open') add('warn', `${l.name} open`);
  }
  const g = h.garage;
  if (!g) add('none', 'Garage: no data');
  else if (!g.available) add('warn', 'Garage unavailable');
  else { if (g.open) add('warn', 'Garage open'); if (g.obstruction) add('warn', 'Garage obstruction'); }
  const RANK: Record<HomeTier, number> = { danger: 0, warn: 1, none: 2, ok: 3 };
  const worst = items.sort((a, b) => RANK[a.tier] - RANK[b.tier])[0];
  const locked = h.locks.filter(l => l.state === 'locked').length, noLock = h.locks.every(l => l.state === 'no-data');
  const smokeBad = h.smoke.filter(s => s.state !== 'clear' && s.state !== 'no-data');
  const sub = [
    // when the headline is 'All doors locked', the count would only repeat it
    h.locks.length ? (noLock ? 'locks: no data' : !worst && locked === h.locks.length ? '' : `${locked} of ${h.locks.length} doors locked`) : '',
    !g ? 'garage: no data' : !g.available ? 'garage unavailable' : g.open ? 'garage open' : 'garage closed',
    !h.smoke.length ? '' : h.smoke.every(s => s.state === 'no-data') ? 'smoke: no data' : h.smoke.some(s => s.state === 'alarm') ? 'smoke alarm'
      : smokeBad.length ? `${smokeBad.length} detector${smokeBad.length === 1 ? '' : 's'} ${smokeBad.every(s => s.state === 'offline') ? 'offline' : 'need a look'}` : 'smoke and CO clear',
  ].filter(Boolean).join(' · ');
  if (!worst) return { tier: 'ok', headline: h.locks.length ? 'All doors locked' : 'All clear', since: null, sub };
  const headline = worst.tier === 'none' && h.haUp == null ? 'Home Assistant not answering' : worst.text;
  return { tier: worst.tier, headline, since: worst.tier === 'none' ? null : worst.since ?? null, sub };
}
export const TIER_C: Record<HomeTier, { c: string; sub: string; halo: string; rule: string }> = {
  danger: { c: 'var(--danger)', sub: 'var(--danger-sub)', halo: 'var(--danger-a18)', rule: 'var(--danger)' },
  warn: { c: 'var(--warn)', sub: 'var(--warn-sub)', halo: 'var(--warn-a18)', rule: 'var(--warn)' },
  none: { c: 'var(--mut-3)', sub: 'var(--mut-3)', halo: 'transparent', rule: 'var(--rule)' },
  ok: { c: 'var(--ok)', sub: 'var(--mut-3)', halo: 'var(--ok-a16)', rule: 'var(--rule)' },
};

const ACTIVE = new Set<Appliance['state']>(['running', 'cleaning', 'heating', 'cooling']);
const WORD: Partial<Record<Appliance['state'], string>> = { on: 'on', off: 'off', charging: 'charging', docked: 'docked', idle: 'idle', 'no-data': 'no data' };
/** 'Washer and dryer off · vacuum docked': names as one sentence, plain one-word names lower-cased after the first */
const nameList = (ns: string[], first: boolean) => {
  const low = ns.map((n, i) => (!(first && i === 0) && /^[A-Z][a-z]+$/.test(n) ? n.toLowerCase() : n));
  return low.length > 1 ? `${low.slice(0, -1).join(', ')} and ${low[low.length - 1]}` : low[0];
};
/** Appliances, compressed (review finding 20): running ones as rows, the idle rest on one line, warnings in amber. */
export function applianceSummary(list: Appliance[]) {
  const short = (a: Appliance) => a.name.split(' · ')[0];
  const active = list.filter(a => ACTIVE.has(a.state)), idle = list.filter(a => !ACTIVE.has(a.state));
  const groups = new Map<string, string[]>();
  for (const a of idle) { const w = WORD[a.state] ?? a.state; groups.set(w, [...(groups.get(w) ?? []), short(a)]); }
  const idleText = [...groups].map(([w, ns], i) => `${nameList(ns, i === 0)} ${w}`).join(' · ');
  const warnings = idle.flatMap(a => applianceView(a).lines.filter(l => l.warn).map(l => `${short(a)} · ${l.text}`));
  const rows = active.map(a => ({
    a, word: { running: 'Running', cleaning: 'Cleaning', heating: 'Heating', cooling: 'Cooling' }[a.state as 'running'],
    color: a.state === 'heating' ? 'var(--heat)' : 'var(--accent)',
    right: a.remainingMin != null ? `${hm(a.remainingMin)} left` : a.finishAt != null ? `done at ${new Date(a.finishAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : a.kind === 'vacuum' && a.progress != null ? `${a.progress}% done` : a.targetC != null ? `set ${deg(a.targetC)}` : '',
    progress: a.kind === 'bed' || a.kind === 'thermostat' ? null : a.progress,
  }));
  return { rows, idleText, warnings };
}
/** Lights by room, in config order (finding 20): rooms with a light on, then the rest (all off, or no data). */
export function lightRooms(ls: Light[]) {
  const rooms = new Map<string, { room: string; on: number; total: number; known: number }>();
  for (const l of ls) {
    const r = rooms.get(l.room) ?? { room: l.room, on: 0, total: 0, known: 0 };
    r.total++; if (l.available && l.on != null) { r.known++; if (l.on) r.on++; }
    rooms.set(l.room, r);
  }
  const all = [...rooms.values()], lit = all.filter(r => r.on > 0), dark = all.filter(r => r.on === 0);
  const off = dark.filter(r => r.known === r.total).length, nd = dark.length - off;
  const plural = (n: number) => `${n} room${n === 1 ? '' : 's'}`;
  return { lit, dark, darkLabel: [off && `${plural(off)} all off`, nd && `${plural(nd)} no data`].filter(Boolean).join(' · ') };
}

/** The summary over its 2px rule in the worst tier: dot, headline, age, and the three answers under it. */
function Summary({ h }: { h: HomeSnap }) {
  const sm = homeSummary(h), t = TIER_C[sm.tier];
  return (
    <div role="status" style={{ paddingTop: 14, borderTop: `2px solid ${t.rule}`, ...flexCol(4) }}>
      <div style={row(12, { minWidth: 0 })}>
        <Dot size={10} color={sm.tier === 'none' ? 'var(--mut-5)' : t.c} style={{ boxShadow: `0 0 0 4px ${t.halo}` }} />
        <span style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-.02em', color: sm.tier === 'ok' ? 'var(--text)' : t.c, minWidth: 0, ...ellipsis }}>{sm.headline}</span>
        {sm.since != null && <span title={`since ${new Date(sm.since).toLocaleString()}`} style={mono(13, t.sub, { fontWeight: 500, flex: 'none' })}>{agoText(secSince(sm.since))}</span>}
      </div>
      <span style={{ fontSize: 13, color: 'var(--mut-2)', ...ellipsis }}>{sm.sub}</span>
    </div>
  );
}
const GRID = { display: 'grid', gridTemplateColumns: '1.25fr 1fr 1fr', gap: 48, alignItems: 'start' } as const;
const BLOCK = (gap = 0) => ruled('12px 0 0', 'var(--rule)', flexCol(gap, { minWidth: 0, scrollMarginTop: 20 }));
const HEAD = { ...eyebrow(), paddingBottom: 4 };

export function Home() {
  const { snap } = useApp();
  const h = snap.home, c = homeState(h);
  const p = h.printer, tonerLow = !!p?.toner && Object.values(p.toner).some(v => v < TONER_LOW);
  const haState = h.haUp == null ? 'not answering (Prometheus)' : h.haUp ? 'up' : 'down';
  const ap = applianceSummary(h.appliances), lr = lightRooms(h.lights);
  const [roomsOpen, setRoomsOpen] = useState(false);
  const haDown = <NotConnected what="Home Assistant" src="prom-home" />;
  const cf = h.configured;
  return (
    <div style={flexCol(28)}>
      <div style={row(12, { fontSize: 12, color: 'var(--mut-3)', marginBottom: -8 })}>
        <StatusDot status={h.haUp == null ? 'unknown' : h.haUp ? 'up' : 'down'} />
        <span><span style={{ color: 'var(--text-2)', fontWeight: 600 }}>Home Assistant</span> {haState}</span>
        {h.updates != null && <span style={{ minWidth: 0, ...ellipsis }} title={h.updates.join(', ')}>· {h.updates.length ? `${h.updates.length} update${h.updates.length === 1 ? '' : 's'}: ${h.updates.join(', ')}` : 'no updates pending'}</span>}
        <span style={{ flex: 1 }} />
        <Ext href={h.haUrl} style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>Open in Home Assistant</Ext>
      </div>

      <Summary h={h} />

      {/* security first: doors and locks, the garage, the detectors */}
      <div style={GRID}>
        {cf.locks && <div id="home-locks" style={BLOCK()}>
          <span style={HEAD}>Doors &amp; locks</span>
          {h.locks.length ? h.locks.map((l, i) => { const [col, word] = LOCK[l.state]; const low = l.battery != null && l.battery < LOCK_BATTERY_LOW, notes = lockNotes(l); return (
            <div key={`${l.name}-${i}`} style={row(12, { minHeight: 50, borderBottom: '1px solid var(--rule-3)' })}>
              <Dot size={8} color={col} pulse={l.state === 'jammed' ? 'danger' : undefined} />
              <div style={{ flex: 1, minWidth: 0, ...flexCol(2) }}>
                <span style={{ fontSize: 14, fontWeight: 600, ...ellipsis }}>{l.name}</span>
                <span style={{ fontSize: 12, color: 'var(--mut-3)', ...ellipsis }}>
                  {[notes.door && <span key="d" style={{ color: l.door === 'open' ? 'var(--warn)' : undefined }}>{notes.door}</span>,
                    l.battery != null && <span key="b" style={{ color: low ? 'var(--warn)' : undefined }}>battery {Math.round(l.battery)}%</span>,
                    l.since != null && <span key="s">{agoText(secSince(l.since))} ago</span>].filter(Boolean).flatMap((x, k) => (k ? [' · ', x] : [x]))}
                </span>
              </div>
              <span style={{ fontSize: 13, fontWeight: 700, color: col, flex: 'none' }}>{word}</span>
            </div>
          ); }) : <span style={{ padding: '12px 0' }}>{haDown}</span>}
        </div>}

        {cf.garage && <div style={BLOCK(12)}>
          <span style={eyebrow()}>Garage door</span>
          {h.garage ? <>
            <div style={row(12)}>
              <Dot size={10} color={c.gOpen == null ? 'var(--mut-5)' : c.gOpen ? 'var(--warn)' : 'var(--ok)'} />
              <span style={{ fontSize: c.gOpen == null ? 26 : 34, fontWeight: 700, letterSpacing: '-.02em', lineHeight: 1, color: c.gOpen == null ? 'var(--mut-3)' : undefined }}>{c.garageWord}</span>
            </div>
            <span style={{ fontSize: 13, color: 'var(--mut-3)' }}>{c.garageSub}</span>
            {h.garage.available && (h.garage.obstruction != null || h.garage.light != null) && (
              <div style={{ display: 'flex', gap: 18, paddingTop: 12, borderTop: '1px solid var(--rule-3)', fontSize: 12, color: 'var(--mut-3)' }}>
                {h.garage.obstruction != null && <span style={{ color: h.garage.obstruction ? 'var(--warn)' : undefined }}>Obstruction {h.garage.obstruction ? 'detected' : 'clear'}</span>}
                {h.garage.light != null && <span>Light {h.garage.light ? 'on' : 'off'}</span>}
              </div>
            )}
          </> : haDown}
        </div>}

        {(cf.safety || !!snap.health.ops?.power) && <div style={BLOCK()}>
          <span style={HEAD}>Safety &amp; power</span>
          {h.smoke.map((s, i) => { const [col, word] = SMOKE[s.state]; return (
            <div key={`${s.name}-${i}`} style={row(12, { minHeight: 44, borderBottom: '1px solid var(--rule-3)' })}>
              <Dot size={7} color={col} pulse={s.state === 'alarm' ? 'danger' : undefined} />
              <div style={{ flex: 1, minWidth: 0, ...flexCol() }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</span>
                {s.detail && <span style={{ fontSize: 11.5, color: 'var(--mut-3)', ...ellipsis }} title={s.detail}>{s.detail}</span>}
              </div>
              <span style={{ fontSize: 12, color: col, fontWeight: 600 }}>{word}</span>
            </div>
          ); })}
          {snap.health.ops?.power && <UpsHomeRow p={snap.health.ops.power} />}
          {p && (
            <div style={row(12, { minHeight: 56, borderBottom: '1px solid var(--rule-3)' })}>
              <span title={!p.available ? 'unavailable' : tonerLow ? 'toner low' : 'available'} style={{ display: 'flex' }}><Dot size={7} color={!p.available ? 'var(--mut-5)' : tonerLow ? 'var(--warn)' : 'var(--ok)'} /></span>
              <div style={{ flex: 1, ...flexCol() }}><span style={{ fontSize: 14, fontWeight: 600 }}>Printer</span><span style={{ fontSize: 12, color: 'var(--mut-3)' }}>{p.model} · {!p.available ? 'unavailable' : tonerLow ? 'toner low' : 'toner'}</span></div>
              <Toner t={p.available ? p.toner : null} />
            </div>
          )}
          {!h.smoke.length && !p && !snap.health.ops?.power && <span style={{ paddingTop: 12 }}>{haDown}</span>}
        </div>}
      </div>

      {/* comfort after: climate, appliances, lights, all compressed to what's happening */}
      <div style={GRID}>
        {/* clipped and its own stacking context: the heat or cool particles (review 3b) run behind its text */}
        {cf.climate && <div style={{ ...BLOCK(10), position: 'relative', overflow: 'hidden', isolation: 'isolate' }}>
          {h.climate?.available && <ClimateFx action={h.climate.action} />}
          <span style={{ ...eyebrow(), ...ellipsis }}>Climate{h.climate?.name ? ` · ${h.climate.name}` : ''}</span>
          {!h.climate ? haDown : <ClimateReadout cl={h.climate} outside={h.climate.outside} humidity={h.climate.humidity} />}
          {h.moreClimates.map((m, i) => { const ml = climateLine(m); return (
            <span key={`${m.name}-${i}`} title={ml.title} style={{ fontSize: 12, color: 'var(--mut-3)', ...ellipsis }}>
              {m.name}{ml.temp && <> · <span style={mono(12, 'var(--text-2)')}>{ml.temp}</span></>} · <span style={{ color: ml.heating ? 'var(--heat)' : undefined }}>{ml.word}</span>
            </span>
          ); })}
        </div>}

        {cf.appliances && <div id="home-appliances" style={BLOCK(8)}>
          <span style={eyebrow()}>Appliances</span>
          {ap.rows.map(({ a, word, color, right, progress }, i) => (
            <div key={`${a.name}-${i}`} style={flexCol(6, { paddingBottom: 4 })}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, minWidth: 0 }}>
                <span style={{ fontSize: 15, fontWeight: 700, minWidth: 0, ...ellipsis }}>{a.name}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color, flex: 'none' }}>{word}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: 'var(--mut-3)', flex: 'none' }}>{right}</span>
              </div>
              {progress != null && <div style={{ height: 4, borderRadius: 2, background: 'var(--rule-3)', overflow: 'hidden' }}><div style={{ width: `${Math.max(0, Math.min(100, progress))}%`, height: '100%', background: color }} /></div>}
            </div>
          ))}
          {ap.idleText && <span style={{ fontSize: 12, color: 'var(--mut-3)' }}>{ap.idleText}</span>}
          {ap.warnings.map((w, i) => <span key={i} style={{ fontSize: 12, color: 'var(--warn)', ...ellipsis }} title={w}>{w}</span>)}
        </div>}

        {cf.lights && <div id="home-lights" style={BLOCK(7)}>
          <span style={eyebrow()}>Lights{lightsSub(h.lights) ? ` · ${lightsSub(h.lights)}` : ''}</span>
          {[...lr.lit, ...(roomsOpen ? lr.dark : [])].map(r => (
            <div key={r.room} style={row(10, { fontSize: 13 })}>
              <Dot size={7} color={r.on ? 'var(--accent)' : 'var(--mut-5)'} />
              <span style={{ flex: 1, minWidth: 0, fontWeight: 600, ...ellipsis }}>{r.room}</span>
              <span style={{ fontSize: 12, color: 'var(--mut-3)', flex: 'none' }}>{r.on ? `${r.on} of ${r.total} on` : r.known < r.total ? 'no data' : 'all off'}</span>
            </div>
          ))}
          {lr.dark.length > 0 && (
            <button type="button" aria-expanded={roomsOpen} onClick={() => setRoomsOpen(o => !o)} className="h-link" style={{ alignSelf: 'flex-start', fontSize: 12, color: 'var(--mut-3)' }}>
              {roomsOpen ? 'Hide rooms that are off' : lr.darkLabel} <span aria-hidden="true">{roomsOpen ? '▴' : '▾'}</span>
            </button>
          )}
        </div>}
      </div>
    </div>
  );
}
