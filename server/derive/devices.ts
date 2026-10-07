// The router's device list (adapter devices, a JSON file any script can write) → the Devices tab. Same rules as derive.ts: pure and total, and
// nothing old shown as current (a stale list leaves only the config's rows, with their own sources' status).
// Infra and smart home are matched to the list by IP (the most recently active entry for that IP wins).
// Phones and Macs rotate private Wi-Fi MACs, so one named device can be several entries: per network, a name keeps
// only its most recently active entry, and a name already matched to an infra or smart-home row isn't listed again.
import type { DeviceRow, DevicesView, HomelabConfig, Status } from '../../shared/types.ts';
import type { DeviceRaw, Raw } from '../raw.ts';
import { arr, fin, slug } from './util.ts';

/** online = active within this */
export const ONLINE_MS = 30 * 60e3;
/** Other LAN and segment lists show devices active within this; older ones are only counted */
export const KNOWN_MS = 30 * 86400e3;

/** a config-known infra device: its own status ('unknown' = no source of its own, the device list's then counts) */
export interface InfraDevice { name: string; ip: string; sub: string; status: Status }
export interface DevicesCtx { raw: Raw; cfg: HomelabConfig; now: number; fresh: boolean; infra: InfraDevice[] }

const ipNum = (ip: string) => { const p = ip.split('.').map(Number); return p.length === 4 && p.every(n => Number.isInteger(n) && n >= 0 && n < 256) ? ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3] : Infinity; };
const byIp = (a: DeviceRow, b: DeviceRow) => ipNum(a.ip.split(' · ')[0]) - ipNum(b.ip.split(' · ')[0]);

export function deriveDevices({ raw, cfg, now, fresh, infra }: DevicesCtx): DevicesView {
  const list = fresh && raw.devices ? arr(raw.devices.list).filter(d => d && typeof d.mac === 'string' && d.mac) : null;
  const online = (d: DeviceRaw) => fin(d.lastActive) && now - d.lastActive <= ONLINE_MS;
  const known = (d: DeviceRaw) => fin(d.lastActive) && now - d.lastActive <= KNOWN_MS;
  // '.81' in homelab.json is on the main LAN
  const lanPrefix = String(cfg.network?.subnet ?? '').split('/')[0].split('.').slice(0, 3).join('.');
  const full = (ip: string) => (ip.startsWith('.') && lanPrefix ? lanPrefix + ip : ip);
  // a device is on a segment when the list names its network (the segment's name or id), else by the segment's prefix
  const segs = arr(cfg.network?.segments).filter(x => x?.id);
  const segOf = (d: DeviceRaw) => segs.find(x => (d.network ? [x.name, x.id].some(n => n && n.toLowerCase() === d.network!.toLowerCase()) : !!x.prefix && (d.ip ?? '').startsWith(`${x.prefix}.`)));
  const ipIdx = new Map<string, DeviceRaw>();
  for (const d of list ?? []) if (d.ip) { const o = ipIdx.get(d.ip); if (!o || (d.lastActive ?? 0) > (o.lastActive ?? 0)) ipIdx.set(d.ip, d); }
  const used = new Set<string>();
  const take = (ip: string) => { const d = ipIdx.get(ip); if (d) used.add(d.mac); return d; };
  const fwStatus = (ds: DeviceRaw[]): Status => (!list || !ds.length ? 'unknown' : ds.some(online) ? 'up' : 'down');
  const last = (ds: DeviceRaw[]) => { const t = ds.map(d => d.lastActive).filter(fin); return t.length ? Math.max(...t) : null; };

  const infraRows: DeviceRow[] = arr(infra).filter(x => x?.ip).map(x => {
    const d = take(x.ip), ds = d ? [d] : [];
    return { key: d?.mac ?? `cfg-${slug(x.name)}`, name: x.name, ip: x.ip, sub: x.sub, vendor: d?.vendor ?? '', mac: d?.mac ?? '', status: x.status !== 'unknown' ? x.status : fwStatus(ds), lastActive: last(ds) };
  });
  const homeRows: DeviceRow[] = arr(cfg.devices).filter(c => c?.name).map(c => {
    const ips = (String(c.ip ?? '').match(/(\d{1,3}\.){3}\d{1,3}|\.\d{1,3}/g) ?? []).map(full);
    const ds = ips.map(take).filter((d): d is DeviceRaw => !!d);
    return { key: ds[0]?.mac ?? `cfg-${slug(c.name)}`, name: c.name, ip: ips.join(' · '), sub: c.note ?? '', vendor: ds[0]?.vendor ?? '', mac: ds.map(d => d.mac).join(' · '), status: fwStatus(ds), lastActive: last(ds) };
  });
  if (!list) return { live: false, at: null, counts: null, groups: [{ id: 'infra', title: 'Servers & network', rows: infraRows }, { id: 'home', title: 'Smart home', rows: homeRows }] };

  const row = (d: DeviceRaw): DeviceRow => {
    const named = d.name || '', who = d.vendor || d.brand;
    const odd = d.network && !/^lan$/i.test(d.network) && !segOf(d) ? d.network : '';
    return {
      key: d.mac, name: named || who || d.mac, ip: d.ip || '', sub: [odd, named ? who : '', d.type].filter(Boolean).join(' · '), vendor: who || '', mac: d.mac,
      status: online(d) ? 'up' : 'down', lastActive: fin(d.lastActive) ? d.lastActive : null,
    };
  };
  const nameKey = (d: DeviceRaw) => (d.name ? d.name.toLowerCase().replace(/[\u2018\u2019]/g, "'").trim() : '');
  const dedupe = (ds: DeviceRaw[]) => {
    const best = new Map<string, DeviceRaw>();
    for (const d of ds) { const k = nameKey(d) || `mac:${d.mac}`, o = best.get(k); if (!o || (d.lastActive ?? 0) > (o.lastActive ?? 0)) best.set(k, d); }
    return [...best.values()];
  };
  const usedNames = new Set((list ?? []).filter(d => used.has(d.mac)).map(nameKey).filter(Boolean));
  const listed = (d: DeviceRaw) => known(d) && !used.has(d.mac) && !usedNames.has(nameKey(d));
  const sorted = (ds: DeviceRaw[]) => ds.map(row).sort((a, b) => (a.status === 'up' ? 0 : 1) - (b.status === 'up' ? 0 : 1) || byIp(a, b) || a.name.localeCompare(b.name));
  const lan = dedupe(list.filter(d => !segOf(d))), bySeg = segs.map(x => ({ x, ds: dedupe(list.filter(d => segOf(d) === x)) }));
  return {
    live: true, at: fin(raw.devices?.at) ? raw.devices!.at : null,
    counts: {
      lanOnline: lan.filter(online).length, lanKnown: lan.filter(known).length,
      segments: bySeg.map(({ x, ds }) => ({ id: x.id, name: x.name, online: ds.filter(online).length, known: ds.filter(known).length })),
      older: [...lan, ...bySeg.flatMap(b => b.ds)].filter(d => !known(d)).length,
    },
    groups: [
      { id: 'infra', title: 'Servers & network', rows: infraRows },
      { id: 'home', title: 'Smart home', rows: homeRows },
      { id: 'lan', title: 'Other LAN', rows: sorted(lan.filter(listed)) },
      ...bySeg.map(({ x, ds }) => ({ id: `seg:${x.id}`, title: x.name, rows: sorted(ds.filter(listed)) })),
    ],
  };
}
