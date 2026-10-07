// Prometheus · Home Assistant (every 15 s): HA's own Prometheus exporter, entity ids from
// config.homeAssistant. Display-only: this file reads metrics and nothing else, and no code path anywhere
// calls a HA service.
//
// Availability: when an entity goes unavailable, HA's exporter sets homeassistant_entity_available to 0 and
// DROPS its value series (it does not keep the last value). Every entity is therefore gated on
// entity_available == 1; 0 or missing reads available:false / 'unavailable' / 'no-data'. When a tile is
// unavailable its value fields are placeholders the page must not show (garage open false,
// climate indoor NaN, mode '—').
//
// Verified 2026-10-04: lock_state 1 = locked, 0 = unlocked. HA's state_as_number maps 'open' to 1 as well (an
// open lock reads locked), and returns nothing for jammed/locking/unlocking, so the series keeps its last value:
// only the lock's own `jammed` binary sensor can say 'jammed' (the laundry lock has none), and derive flags a
// lock reading locked while its door contact is open.
// Appliances: text states (cycle stage, vacuum status, current room, errors) aren't exported, so the cards use
// power switches, binaries and numeric sensors only. Durations come as sensor_duration_{s,min,h,d}.
// Door contacts are device_class opening (1 = open). Kidde `*_battery_state` is device_class battery
// (1 = low); `*_fault` sensors are device_class problem; `_last_seen` checks in about every 24 h.
import { config } from '../config.ts';
import { jobOf } from '../derive/util.ts';
import { rows, type Row } from './prometheus.ts';
import { env, type Adapter } from './types.ts';
import type { Raw } from '../raw.ts';

type Ha = NonNullable<Raw['ha']>;
const SMOKE_ALARMS: [string, string][] = [['smoke_alarm', 'smoke alarm'], ['co_alarm', 'CO alarm'], ['too_much_smoke', 'too much smoke'], ['hardwire_smoke_alarm', 'hardwired smoke alarm']];
const LAST_SEEN_MAX = 36 * 3600; // Kidde check-ins are ~24 h apart (max gap 23.98 h over 7 days)
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&'); // regex-escaped, inside a PromQL string

export const promHome: Adapter = {
  name: 'prom-home',
  label: 'Prometheus · Home Assistant',
  every: 15_000,
  needs: 'PROMETHEUS_URL in .env and a homeAssistant section in homelab.json',
  configured: () => !!env('PROMETHEUS_URL') && !!config.homeAssistant,
  async run() {
    const ha = config.homeAssistant!;
    const ids = [ha.climate, ha.humidity, ha.garage, ha.garageObstruction, ha.garageLight, ...(ha.lights ?? []).map(l => l.entity), ...(ha.moreClimates ?? []).flatMap(c => [c.entity, c.battery]),
      ...ha.smoke.map(s => `${s.sensorPrefix}_last_seen`),
      ...(ha.printer ? [ha.printer.entity, ...Object.values(ha.printer.toner)] : []),
      ...ha.locks.flatMap(l => [l.entity, l.battery, l.jammed, l.door])].filter((x): x is string => !!x);
    const appIds = (ha.appliances ?? []).flatMap(a => [a.power, a.remaining, a.progress, a.finish, a.energyToday, a.cleaning, a.charging, a.battery, a.area, a.lastEnd, a.climate, a.temperature, a.humidity, a.target, a.presence, a.slept, ...(a.maintenance ?? []).map(m => m.entity)]).filter((x): x is string => !!x);
    const ent = [...ids.map(esc), ...ha.smoke.map(s => `${esc(s.prefix)}_.+`)].join('|');
    const r = await rows({
      up: `up{job="${jobOf(config, 'homeassistant', 'homeassistant')}"}`,
      up2m: `max_over_time(up{job="${jobOf(config, 'homeassistant', 'homeassistant')}"}[2m])`,
      ...(appIds.length ? { app: `{__name__=~"homeassistant_(sensor_.+|binary_sensor_state|switch_state|entity_available|climate_.+)",entity=~"${appIds.map(esc).join('|')}"}` } : {}),
      updates: 'homeassistant_update_state == 1',
      e: `{__name__=~"homeassistant_(entity_available|last_updated_time_seconds|binary_sensor_state|switch_state|lock_state|cover_state|light_brightness_percent|climate_.+|sensor_(battery_percent|humidity_percent|unit_percent|timestamp_seconds))",entity=~"${ent}"}`,
    });

    // index: metric → entity → rows
    const idx = new Map<string, Map<string, Row[]>>();
    for (const x of r.e ?? []) {
      const byE = idx.get(x.m.__name__) ?? idx.set(x.m.__name__, new Map()).get(x.m.__name__)!;
      byE.set(x.m.entity, [...(byE.get(x.m.entity) ?? []), x]);
    }
    const get = (metric: string, e: string | null | undefined) => (e ? idx.get(`homeassistant_${metric}`)?.get(e) ?? [] : []);
    /** true / false (0) / null (no series at all: unknown to the exporter) */
    const avail = (e: string | null | undefined) => { const x = get('entity_available', e)[0]; return x ? x.v === 1 : null; };
    /** the value, only while the entity is available */
    const num = (metric: string, e: string | null | undefined) => (avail(e) ? get(metric, e)[0]?.v ?? null : null);
    const on = (metric: string, e: string | null | undefined) => { const v = num(metric, e); return v == null ? null : v > 0; };
    const label = (metric: string, e: string, key: string) => (avail(e) ? get(metric, e).find(x => x.v === 1)?.m[key] ?? null : null);
    const updatedMs = (e: string) => { const v = get('last_updated_time_seconds', e)[0]?.v; return v ? Math.round(v * 1000) : null; };

    const up = r.up?.[0] ? r.up[0].v === 1 : null;
    const out: Ha = {
      up,
      downFor2m: r.up2m?.[0] ? r.up2m[0].v === 0 : up === false,
      updates: [...new Set((r.updates ?? []).map(x => x.m.friendly_name || x.m.entity).filter(Boolean))].sort(),
      climate: climate(), garage: garage(), lights: [], moreClimates: (ha.moreClimates ?? []).map(c => ({ ...climateOf(c.entity, c.name, null), battery: num('sensor_battery_percent', c.battery) })), appliances: [], smoke: ha.smoke.map(smoke), locks: ha.locks.map(lock), printer: null,
    };
    // HA's exporter reports an off light as 0 %
    out.lights = (ha.lights ?? []).map(l => { const b = num('light_brightness_percent', l.entity); return { name: l.name, room: l.room, on: b == null ? null : b > 0, brightness: b == null ? null : Math.round(b), available: avail(l.entity) === true }; });
    out.appliances = (ha.appliances ?? []).map(appliance);
    if (ha.printer) {
      const t = ha.printer.toner, c = num('sensor_unit_percent', t.c), m = num('sensor_unit_percent', t.m), y = num('sensor_unit_percent', t.y), k = num('sensor_unit_percent', t.k);
      out.printer = { available: avail(ha.printer.entity) === true, toner: c != null && m != null && y != null && k != null ? { c, m, y, k } : null };
    }
    return { ha: out };

    function climate(): Ha['climate'] { return climateOf(ha.climate, ha.climateLabel, ha.humidity); }
    function climateOf(e: string, name: string, humidity: string | null): NonNullable<Ha['climate']> {
      const indoor = num('climate_current_temperature_celsius', e);
      const mode = label('climate_mode', e, 'mode'), action = label('climate_action', e, 'action');
      // one setpoint: the single target; in heat_cool the bound it is working toward (heating → low,
      // cooling → high), none while idle. setpointRange carries the low–high pair for heat_cool.
      const low = num('climate_target_temperature_low_celsius', e), high = num('climate_target_temperature_high_celsius', e);
      const range: [number, number] | null = low != null && high != null ? [low, high] : null;
      const setpoint = num('climate_target_temperature_celsius', e) ?? (range && action === 'heating' ? range[0] : range && action === 'cooling' ? range[1] : null);
      return {
        name, indoor: indoor ?? NaN, setpoint, setpointRange: range, humidity: num('sensor_humidity_percent', humidity),
        mode: mode ? mode.replace(/_/g, '/').replace(/^./, c => c.toUpperCase()) : '—', action, available: indoor != null,
      };
    }

    function appliance(a: NonNullable<typeof ha.appliances>[number]): Ha['appliances'][number] {
      const byE = new Map<string, Row[]>();
      for (const x of r.app ?? []) byE.set(x.m.entity, [...(byE.get(x.m.entity) ?? []), x]);
      const up = (e?: string) => !!e && (byE.get(e) ?? []).some(x => x.m.__name__ === 'homeassistant_entity_available' && x.v === 1);
      const val = (e?: string) => { const x = up(e) ? (byE.get(e!) ?? []).find(x => x.m.__name__ !== 'homeassistant_entity_available') : undefined; return x && Number.isFinite(x.v) ? x : null; };
      const n = (e?: string) => val(e)?.v ?? null, flag = (e?: string) => { const v = n(e); return v == null ? null : v > 0; };
      const MIN: Record<string, number> = { s: 1 / 60, min: 1, h: 60, d: 1440 };
      const minutes = (e?: string) => { const x = val(e); const u = x?.m.__name__.match(/duration_(s|min|h|d)$/)?.[1]; return x && u ? x.v * MIN[u] : null; };
      const ts = (e?: string) => { const x = val(e); return x && /timestamp_seconds$/.test(x.m.__name__) && x.v > 0 ? Math.round(x.v * 1000) : null; };
      const parts = (a.maintenance ?? []).map(m => ({ name: m.name, mins: minutes(m.entity) })).filter((m): m is { name: string; mins: number } => m.mins != null).sort((x, y) => x.mins - y.mins);
      const pct = (e?: string) => { const v = n(e); return v == null ? null : Math.round(v); };
      const base = { kind: a.kind, name: a.name, progress: pct(a.progress), remainingMin: null as number | null, finishAt: ts(a.finish), battery: pct(a.battery), areaM2: n(a.area),
        lastAt: ts(a.lastEnd), energyTodayKwh: (() => { const x = val(a.energyToday); return x ? x.v / (/_wh$/.test(x.m.__name__) ? 1000 : 1) : null; })(),
        maintenance: parts[0] ? { name: parts[0].name, hoursLeft: Math.round(parts[0].mins / 60) } : null };
      if (a.kind === 'thermostat' || a.kind === 'bed') {
        const cr = up(a.climate) ? byE.get(a.climate!) ?? [] : [];
        const cv = (m: string) => cr.find(x => x.m.__name__ === `homeassistant_climate_${m}`)?.v ?? null;
        const act = cr.find(x => x.m.__name__ === 'homeassistant_climate_action' && x.v === 1)?.m.action ?? null;
        const mode = cr.find(x => x.m.__name__ === 'homeassistant_climate_mode' && x.v === 1)?.m.mode ?? null;
        const state = !cr.length ? 'no-data' : mode === 'off' || act === 'off' ? 'off' : act === 'heating' ? 'heating' : act === 'cooling' ? 'cooling' : 'idle';
        const slept = minutes(a.slept);
        return { ...base, state, tempC: n(a.temperature) ?? cv('current_temperature_celsius'), targetC: a.kind === 'bed' ? n(a.target) : cv('target_temperature_celsius') ?? cv('target_temperature_low_celsius'),
          humidity: pct(a.humidity), inBed: flag(a.presence), sleptMin: slept == null ? null : Math.round(slept) };
      }
      if (a.kind === 'vacuum') {
        const cl = flag(a.cleaning), ch = flag(a.charging);
        return { ...base, state: cl == null ? 'no-data' : cl ? 'cleaning' : ch ? 'charging' : 'docked' };
      }
      const pw = flag(a.power), rem = minutes(a.remaining);
      return { ...base, remainingMin: rem == null ? null : Math.round(rem), state: pw == null ? 'no-data' : !pw ? 'off' : rem != null || base.progress != null ? 'running' : 'on' };
    }

    function garage(): Ha['garage'] {
      const e = ha.garage, states = avail(e) ? get('cover_state', e) : [];
      const open = states.length ? states.some(x => /^(open|opening)$/.test(x.m.state) && x.v === 1) : null;
      return {
        open: open === true, available: open != null,
        since: open != null ? updatedMs(e) : null, // last_updated: also moves on attribute changes
        obstruction: on('binary_sensor_state', ha.garageObstruction), light: on('light_brightness_percent', ha.garageLight),
      };
    }

    function smoke(s: (typeof ha.smoke)[number]): Ha['smoke'][number] {
      const p = (suffix: string) => `${s.prefix}_${suffix}`;
      const bin = (suffix: string) => num('binary_sensor_state', p(suffix));
      const known = [...(idx.get('homeassistant_entity_available')?.keys() ?? [])].some(e => e.startsWith(`${s.prefix}_`));
      if (up !== true) return { name: s.name, state: 'no-data', detail: up === false ? 'Home Assistant not answering' : 'no Home Assistant data' };
      if (!known) return { name: s.name, state: 'no-data', detail: `no ${s.prefix}_* series in Prometheus` };
      const alarms = SMOKE_ALARMS.filter(([k]) => bin(k) === 1).map(([, t]) => t);
      if (alarms.length) return { name: s.name, state: 'alarm', detail: alarms.join(' · ') };
      const off: string[] = [];
      if (bin('smoke_alarm') == null || bin('co_alarm') == null) off.push('alarm sensors unavailable in Home Assistant');
      if (bin('online') === 0) off.push('Kidde reports it offline');
      if (bin('lost') === 1) off.push('Kidde lost it');
      if (bin('contact_lost') === 1) off.push('contact lost');
      const seen = num('sensor_timestamp_seconds', `${s.sensorPrefix}_last_seen`);
      if (seen != null && Date.now() / 1000 - seen > LAST_SEEN_MAX) off.push('no check-in for over 36 h');
      if (off.length) return { name: s.name, state: 'offline', detail: off.join(' · ') };
      const faults = [...(idx.get('homeassistant_binary_sensor_state')?.values() ?? [])].flat()
        .filter(x => x.m.entity.startsWith(`${s.prefix}_`) && x.m.entity.endsWith('_fault') && x.v === 1 && avail(x.m.entity))
        .map(x => x.m.entity.slice(s.prefix.length + 1).replace(/_/g, ' '));
      if (bin('battery_state') === 1) faults.push('low battery');
      if (faults.length) return { name: s.name, state: 'fault', detail: faults.join(' · ') };
      return { name: s.name, state: 'clear', detail: seen == null ? 'online · no check-in time' : 'online · no faults' };
    }

    function lock(l: (typeof ha.locks)[number]): Ha['locks'][number] {
      const a = avail(l.entity), v = num('lock_state', l.entity);
      const state: Ha['locks'][number]['state'] = up !== true || a == null ? 'no-data' : !a ? 'unavailable'
        : num('binary_sensor_state', l.jammed) === 1 ? 'jammed' : v === 1 ? 'locked' : v === 0 ? 'unlocked' : 'no-data';
      const door = num('binary_sensor_state', l.door);
      return {
        name: l.name, state, since: a ? updatedMs(l.entity) : null,
        battery: num('sensor_battery_percent', l.battery), door: door == null ? null : door === 1 ? 'open' : 'closed',
      };
    }
  },
};
