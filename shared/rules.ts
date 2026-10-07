// Thresholds shared by derive (Needs attention) and the page (bar colours), so a bar is amber or red only when
// the matching attention item exists. Values are compared unrounded; only the text is rounded.
import type { Res, Tone } from './types.ts';

const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
/** used/total in percent, unrounded; null when either is missing */
export const ratioPct = (used: number | null | undefined, total: number | null | undefined) => (fin(used) && fin(total) && total > 0 ? (100 * used) / total : null);

/** homelab.json attentionRules defaults (the page doesn't get attentionRules; the config keeps these values) */
export const DISK_WARN = 85, DISK_DANGER = 95, HOST_RAM_WARN = 90;

/** Disks, the array and root filesystems: amber from `warn` %, red above `danger` % (strictly, like Grafana's 'gt'). */
export function diskTone(used: number | null | undefined, total: number | null | undefined, warn = DISK_WARN, danger = DISK_DANGER): Tone {
  const p = ratioPct(used, total);
  return p == null ? 'ok' : p > danger ? 'danger' : p >= warn ? 'warn' : 'ok';
}

type Mem = Pick<Res, 'memUsed' | 'memTotal' | 'swapUsed' | 'swapTotal'> | null | undefined;
/** Grafana's 'Swap High with Low Memory Headroom': swap more than half used while memory is 80 %+ used. Full swap
 *  next to free memory is swap the kernel kept, not pressure (the Docker LXCs sit at 90-100 % swap most days). */
export function memPressure(r: Mem): boolean {
  const s = ratioPct(r?.swapUsed, r?.swapTotal), m = ratioPct(r?.memUsed, r?.memTotal);
  return s != null && m != null && s > 50 && m >= 80;
}
/** Memory and swap bars: amber for a host at 90 %+ memory (derive's RAM item) or under memory pressure, never red. */
export function memTone(r: Mem, host: boolean): Tone {
  return memPressure(r) || (host && (ratioPct(r?.memUsed, r?.memTotal) ?? 0) >= HOST_RAM_WARN) ? 'warn' : 'ok';
}
