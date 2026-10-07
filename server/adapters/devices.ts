// The router's device list (module devices): a JSON file that any job of yours writes every few minutes (from your
// router's API, an ARP scan, ntopng …), mounted read-only (DEVICES_FILE, default /app/inbox/devices.json). No network
// here: one file read. The format is in docs/INTEGRATIONS.md: { at, source?, devices: [{ mac, ip, name, vendor, type,
// network, lastActive, firstSeen }] }.
import fs from 'node:fs';
import { env, type Adapter } from './types.ts';
import type { DeviceRaw, Raw } from '../raw.ts';

/** a file older than this no longer counts (run() throws, so the source goes stale) */
export const DEVICES_MAX_AGE = 20 * 60e3;
export const devicesFile = () => env('DEVICES_FILE') || '/app/inbox/devices.json';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
/** epoch ms, or null; a time in seconds (< 1e11) is taken as seconds */
const ms = (v: unknown) => {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? (n < 1e11 ? n * 1000 : n) : null;
};

/** The file's JSON → Raw.devices. A bad entry is skipped (no MAC, not an object, a repeated MAC), a missing field reads
 *  '' / null. Throws only when the file as a whole is unusable or older than DEVICES_MAX_AGE. */
export function parseDevices(j: unknown, now = Date.now()): NonNullable<Raw['devices']> {
  const o = j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  const at = ms(o?.at);
  if (!o || at == null) throw new Error('devices.json has no `at` time');
  if (!Array.isArray(o.devices)) throw new Error('devices.json has no `devices` list');
  if (now - at > DEVICES_MAX_AGE) throw new Error(`devices.json is ${Math.round((now - at) / 60e3)} min old (its job should write every few minutes)`);
  const seen = new Set<string>(), list: DeviceRaw[] = [];
  for (const d of o.devices) {
    if (!d || typeof d !== 'object') continue;
    const x = d as Record<string, unknown>, mac = str(x.mac).toUpperCase();
    if (!mac || seen.has(mac)) continue;
    seen.add(mac);
    list.push({ mac, ip: str(x.ip), name: str(x.name), vendor: str(x.vendor), type: str(x.type), brand: str(x.brand), os: str(x.os), network: str(x.network), lastActive: ms(x.lastActive), firstSeen: ms(x.firstSeen) });
  }
  return { at, source: str(o.source) || 'device list', list };
}

export const devices: Adapter = {
  name: 'devices', label: 'Devices', every: 60_000, needs: 'a devices.json written by your own job (DEVICES_FILE)', configured: () => fs.existsSync(devicesFile()),
  async run() { return { devices: parseDevices(JSON.parse(await fs.promises.readFile(devicesFile(), 'utf8'))) }; },
};
