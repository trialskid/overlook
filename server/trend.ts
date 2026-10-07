// Media → Library health's direction (review finding 17). The server samples the five backlog counts at most once
// per local calendar day (homelab.json `timezone`, else TZ) and the Snapshot's media.delta7 is each count now minus
// its sample from 7 days before. Samples live in DATA_DIR/library-history.json (30 days), written atomically (tmp +
// rename, like links.json), so a restart or a redeploy keeps the trend. A count whose source isn't fresh is never
// sampled, and a count the page can't show has no change either (both read '—').
import fs from 'node:fs';
import path from 'node:path';
import { LIBRARY_KEYS, type LibraryKey } from '../shared/types.ts';
import type { Raw } from './raw.ts';

export type LibraryCounts = Record<LibraryKey, number | null>;
/** local day ('2026-10-06') → the counts sampled that day */
export type LibraryHistory = Record<string, Partial<Record<LibraryKey, number>>>;
const V = 1, KEEP_DAYS = 30, DAY = /^\d{4}-\d{2}-\d{2}$/;
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar day of `t`, moved by `days` (noon, so a DST change never lands on the wrong date). */
export function dayKey(t: number, days = 0) {
  const d = new Date(t), x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, 12);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

/** The five counts as the page shows them; with `fresh`, only those whose source answered on its last poll. */
export function libraryCounts(raw: Raw, fresh: (source: string) => boolean = () => true): LibraryCounts {
  const n = (v: number | null | undefined, src: string) => (num(v) && fresh(src) ? v : null);
  return {
    bazarr: n(raw.bazarr?.episodes, 'bazarr'),
    sonarrWanted: n(raw.sonarr?.wanted, 'prom-media'),
    radarrMissing: n(raw.radarr?.missing, 'prom-media'),
    radarrWanted: n(raw.radarr?.wanted, 'prom-media'),
    chaptarrMissing: n(raw.chaptarr?.missing, 'chaptarr'),
  };
}

function read(file: string): LibraryHistory {
  let j: { version?: unknown; days?: unknown };
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[trend] ${file} not readable, starting a new history: ${(e as Error).message}`);
    return {};
  }
  if (j?.version !== V || !j.days || typeof j.days !== 'object') { console.warn(`[trend] ${file} has an unknown shape, starting a new history`); return {}; }
  const days: LibraryHistory = {};
  for (const [d, c] of Object.entries(j.days as Record<string, Record<string, unknown>>)) {
    if (!DAY.test(d) || !c || typeof c !== 'object') continue;
    const keep = Object.fromEntries(LIBRARY_KEYS.filter(k => num(c[k])).map(k => [k, c[k] as number]));
    if (Object.keys(keep).length) days[d] = keep;
  }
  return days;
}

export class LibraryTrend {
  private days: LibraryHistory;
  /** file null: kept in memory only (MOCK, tests), starting from `seed` */
  constructor(private readonly file: string | null, seed: LibraryHistory = {}) {
    this.days = file ? read(file) : structuredClone(seed);
  }

  /** Samples each count the first time it's seen on a local day (nulls are skipped), drops days past 30, and saves
   *  when anything was added. Never throws: a failed save is logged and the samples stay in memory. */
  record(c: LibraryCounts, now = Date.now()): boolean {
    const today = dayKey(now), entry = (this.days[today] ??= {});
    let added = false;
    for (const k of LIBRARY_KEYS) if (num(c[k]) && entry[k] == null) { entry[k] = c[k]; added = true; }
    if (!Object.keys(entry).length) delete this.days[today];
    if (!added) return false;
    const oldest = dayKey(now, 1 - KEEP_DAYS);
    for (const d of Object.keys(this.days)) if (d < oldest) delete this.days[d];
    return this.save();
  }

  /** Each count minus its sample from 7 local days before; null without that sample or without a count now. */
  delta7(c: LibraryCounts, now = Date.now()): LibraryCounts {
    const then = this.days[dayKey(now, -7)];
    return Object.fromEntries(LIBRARY_KEYS.map(k => [k, num(c[k]) && then?.[k] != null ? c[k]! - then[k]! : null])) as LibraryCounts;
  }

  history(): LibraryHistory { return structuredClone(this.days); }

  private save(): boolean {
    if (!this.file) return true;
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: V, days: this.days }) + '\n');
      fs.renameSync(tmp, this.file); // never a half-written history
      return true;
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      console.warn(`[trend] library history not saved: ${(e as Error).message}`);
      return false;
    }
  }
}
