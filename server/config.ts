import fs from 'node:fs';
import path from 'node:path';
import type { HomelabConfig } from '../shared/types.ts';

const file = process.env.HOMELAB_CONFIG || path.resolve(process.cwd(), 'config/homelab.json');
const stamp = () => { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; };
if (!fs.existsSync(file)) {
  console.error(`[config] ${file} not found. Copy config/example.homelab.json to config/homelab.json (or set HOMELAB_CONFIG) and edit it.`);
  process.exit(1);
}
let seen = stamp();

/** Keys a file may leave out, and what they mean when it does. Only domain, hosts and network are required. */
const DEFAULTS = (): Omit<HomelabConfig, 'domain' | 'hosts' | 'network'> => ({
  publicEndpoints: [], retiredHosts: [], guests: [], apps: [], macRoles: [], webUis: {}, uiPaths: {}, uiLabels: {}, kumaAliases: {}, links: {},
  attentionRules: { bazarrMissingSubtitlesAbove: 1000, wudUpdatesAbove: 0, diskWarnPct: 85, diskDangerPct: 95, certWarnDays: 14, lockBatteryWarnPct: 25 },
  jobs: [], devices: [], mediaAlsoRunning: [], versions: [],
});
const HA_DEFAULTS = (): NonNullable<HomelabConfig['homeAssistant']> => ({
  climate: '', climateLabel: '', humidity: null, garage: '', garageObstruction: null, garageLight: null, smoke: [], printer: null, backup: null, locks: [],
});
const REQUIRED = ['domain', 'hosts', 'network'] as const;
const validZone = (z: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };
/** A parsed homelab.json with its defaults filled in. Throws when it can't be used at all. */
export function normalize(j: unknown): HomelabConfig {
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('not a JSON object');
  const o = j as Record<string, unknown>;
  const missing = REQUIRED.filter(k => o[k] == null);
  if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
  if (!Array.isArray(o.hosts)) throw new Error('hosts is not a list');
  if (o.timezone != null && (typeof o.timezone !== 'string' || !validZone(o.timezone))) throw new Error(`timezone ${String(o.timezone)} is not an IANA zone (e.g. Europe/London)`);
  const d = DEFAULTS();
  return {
    ...d, ...o,
    attentionRules: { ...d.attentionRules, ...(o.attentionRules as object | undefined) },
    ...(o.homeAssistant ? { homeAssistant: { ...HA_DEFAULTS(), ...(o.homeAssistant as object) } } : {}),
  } as HomelabConfig;
}

/** One object for the life of the process: a reload replaces its contents in place, so every importer sees it. */
export const config: HomelabConfig = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
/** homelab.json `timezone` wins over TZ for clock times and Library health's calendar days (Node reads TZ live). */
const applyTimezone = (c: HomelabConfig) => { if (c.timezone) process.env.TZ = c.timezone; };
applyTimezone(config);
/** Throws when `next` can't be used (index.ts dry-runs derive() with it). */
export type Validate = (next: HomelabConfig) => void;
let validator: Validate | null = null;

/** Re-reads homelab.json if it changed. A file that doesn't parse, lacks a required key or fails the validator
 *  (e.g. a guest without an ip, which would make every rebuild throw) keeps the old config. */
export function reloadConfig(log: (msg: string) => void = m => console.log(m), validate: Validate | null = validator): boolean {
  let now: string;
  try { now = stamp(); } catch { return false; } // mid-replace or briefly missing: try again next round
  if (now === seen) return false;
  seen = now;
  try {
    const next = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    validate?.(next);
    for (const k of Object.keys(config)) delete (config as unknown as Record<string, unknown>)[k];
    Object.assign(config, next);
    applyTimezone(config);
    log('config reloaded');
    return true;
  } catch (e) {
    log(`config not reloaded, keeping the old one: ${(e as Error).message}`);
    return false;
  }
}
/** Checked every 30 s (mtime + size). Started by index.ts, so importing config in a test starts no timer. */
export function watchConfig(validate?: Validate, every = 30_000) {
  validator = validate ?? null;
  return setInterval(() => reloadConfig(), every).unref();
}
