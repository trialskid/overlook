import type { Raw } from '../raw.ts';

/** One adapter per source. `configured()` false → the widget shows "not connected"; a throw → "error". Never a crash. */
export interface Adapter {
  name: string;
  /** shown on the page (Health → Sources), e.g. 'Prometheus · Home Assistant' */
  label: string;
  /** poll interval, ms */
  every: number;
  /** data older than this is dropped before derive (default max(3 × every, 90 s)) */
  maxAge?: number;
  /** when not configured: what it needs, shown on the page */
  needs?: string;
  configured(): boolean;
  /** Returns this adapter's whole slice. index.ts replaces (never merges into) the adapter's previous part. */
  run(): Promise<Partial<Raw>>;
}

export const env = (k: string) => process.env[k]?.trim() || '';
export const trimUrl = (u: string) => u.replace(/\/+$/, '');
export const maxAgeOf = (a: Adapter) => a.maxAge ?? Math.max(3 * a.every, 90_000);
