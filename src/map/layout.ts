// Network map geometry, generated from the hosts and their leaves (no hard-coded positions).
// Canvas 972×650. Hosts: equal 190px nodes, up to four a row, evenly spaced and symmetric under the switch (x 486);
// a fifth host starts a second row, fed by a bus down the left edge.
// Leaves: a spine at host-left + 18 from y 382; rows from y 418 at a 32px pitch; pills at spine + 12.
// Up to 7 leaves: one column. Up to 8: one column at a 26px pitch with compact pills, so the last
// row still clears the legend. More: two columns, each capped to half the room before the next
// host's pills (names ellipsize) so a busy host never runs into its neighbour. The canvas grows past 650
// when the lowest pill would reach the legend (e.g. 7 guests at the 32px pitch).
import type { HostView, LeafView } from '../../shared/types.ts';

export const MAP = { W: 972, H: 650, GX: 486, HOST_W: 190, HOST_TOP: 290, SPINE_TOP: 382, LEAF_Y: 418, PITCH: 32, COMPACT_PITCH: 26, COL2: 122, MAX_ONE_COL: 7, MAX_COMPACT: 8, PER_ROW: 4, BUS_X: 8, BUS_Y: 244 } as const;
/** The upstream boxes, top to bottom: the Internet pill, the gateway, the switch (y from, to). */
export const CHAIN_Y = { internet: [14, 42], gateway: [78, 134], switch: [172, 228] } as const;

/** top: the host node's top; spineTop / leafY: where its leaves' spine starts and its first pill sits. */
export interface PlacedHost { host: HostView; cx: number; left: number; top: number; spineTop: number; leafY: number; curve: string }
/** maxW: pill width cap (two-column hosts), null = natural width. compact: 22px pill instead of 28px. key: the pill's
 *  React key, `host:leaf`, so a leaf coming or going on one host never re-keys the pills of another (a duplicate leaf
 *  key on one host gets #2, #3). */
export interface PlacedLeaf { leaf: LeafView; hostId: string; key: string; x: number; y: number; maxW: number | null; compact: boolean }
export interface MapLayout { hosts: PlacedHost[]; leaves: PlacedLeaf[]; trunkD: string; spines: Record<string, string>; leafD: string; H: number }
/** room the legend needs under the lowest pill: its 14px bottom offset, its line and a gap */
const LEGEND_ROOM = 44;
/** a later row's bus sits this far above its hosts */
const BUS_ABOVE = 34;

/** The vertical trunk from the Internet pill to the fan-out at y 228, broken where a gateway or switch box sits. */
export function trunkOf(chain: { gateway?: boolean; switch?: boolean } = { gateway: true, switch: true }) {
  let y: number = CHAIN_Y.internet[1], d = '';
  for (const k of ['gateway', 'switch'] as const) if (chain[k]) { d += ` M${MAP.GX},${y} L${MAP.GX},${CHAIN_Y[k][0]}`; y = CHAIN_Y[k][1]; }
  if (y < CHAIN_Y.switch[1]) d += ` M${MAP.GX},${y} L${MAP.GX},${CHAIN_Y.switch[1]}`;
  return d.trim();
}

/** The trunk's pieces between the boxes (for the packets that run along it). */
export const chainSegments = (chain?: { gateway?: boolean; switch?: boolean }) => trunkOf(chain).split(/ (?=M)/).filter(Boolean);

/** Places hosts in rows of up to four under the fan-out (the first row hangs off it, later rows off a bus that runs
 *  down the left edge), and each host's leaves under it. */
export function layoutMap(hosts: HostView[], chain?: { gateway?: boolean; switch?: boolean }): MapLayout {
  const n = hosts.length, rowsN = Math.max(1, Math.ceil(n / MAP.PER_ROW));
  let trunkD = trunkOf(chain);
  const placed: PlacedHost[] = [];
  const leaves: PlacedLeaf[] = [];
  const spines: Record<string, string> = {};
  let top: number = MAP.HOST_TOP, lowest = 0;
  for (let r = 0; r < rowsN; r++) {
    const rowHosts = hosts.slice(r * MAP.PER_ROW, (r + 1) * MAP.PER_ROW), k = rowHosts.length;
    const step = k > 1 ? Math.min(247, Math.floor((MAP.W - 40 - MAP.HOST_W) / (k - 1))) : 0;
    const busY = top - BUS_ABOVE;
    if (r > 0) trunkD += ` M${MAP.GX},${MAP.BUS_Y} L${MAP.BUS_X},${MAP.BUS_Y} L${MAP.BUS_X},${busY}`;
    const row: PlacedHost[] = rowHosts.map((host, i) => {
      const cx = Math.floor(MAP.GX + (i - (k - 1) / 2) * step);
      const curve = r === 0
        ? `M${MAP.GX},228 C${MAP.GX},262 ${cx},258 ${cx},${top}`
        : `M${MAP.GX},${MAP.BUS_Y} L${MAP.BUS_X},${MAP.BUS_Y} L${MAP.BUS_X},${busY} L${cx},${busY} L${cx},${top}`;
      trunkD += ' ' + (r === 0 ? curve : `M${MAP.BUS_X},${busY} L${cx},${busY} L${cx},${top}`);
      return { host, cx, left: cx - MAP.HOST_W / 2, top, spineTop: top + (MAP.SPINE_TOP - MAP.HOST_TOP), leafY: top + (MAP.LEAF_Y - MAP.HOST_TOP), curve };
    });
    row.forEach((p, i) => {
      const items = p.host.leaves, cnt = items.length;
      if (!cnt) return;
      const sx = p.left + 18, x0 = sx + 12;
      // room until the next host's pills (or the canvas edge), minus a gap
      const room = (i < row.length - 1 ? row[i + 1].left + 30 : MAP.W) - x0 - 10;
      const compact = cnt > MAP.MAX_ONE_COL && cnt <= MAP.MAX_COMPACT, two = cnt > MAP.MAX_COMPACT;
      const rows = two ? Math.ceil(cnt / 2) : cnt, pitch = compact || two ? MAP.COMPACT_PITCH : MAP.PITCH;
      const col2 = Math.min(MAP.COL2, Math.floor(room / 2));
      let d = `M${sx},${p.spineTop} L${sx},${p.leafY + (rows - 1) * pitch}`;
      const seen = new Map<string, number>();
      items.forEach((leaf, j) => {
        const dup = (seen.get(leaf.key) ?? 0) + 1;
        seen.set(leaf.key, dup);
        const rr = two ? j % rows : j, c = two ? Math.floor(j / rows) : 0;
        const y = p.leafY + rr * pitch, x = x0 + c * col2;
        if (c === 0) d += ` M${sx},${y} L${x},${y}`;
        leaves.push({ leaf, hostId: p.host.id, key: `${p.host.id}:${leaf.key}${dup > 1 ? `#${dup}` : ''}`, x, y, compact: compact || two, maxW: two ? (c === 0 ? col2 - 8 : room - col2) : Math.max(room, 120) });
      });
      spines[p.host.id] = d;
    });
    placed.push(...row);
    // the next row starts under this one's lowest pill (or its host nodes), leaving room for its bus
    const rowLow = Math.max(top + 80, ...leaves.filter(l => row.some(p => p.host.id === l.hostId)).map(l => l.y + (l.compact ? 11 : 14)));
    lowest = Math.max(lowest, rowLow);
    top = rowLow + 40 + BUS_ABOVE;
  }
  return { hosts: placed, leaves, trunkD, spines, leafD: Object.values(spines).join(' '), H: Math.max(MAP.H, lowest + LEGEND_ROOM) };
}
