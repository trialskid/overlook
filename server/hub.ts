// Adapter state, freshness and Raw composition (v3.1 rules 1, 2 and 6). index.ts owns the timers and
// the HTTP side; everything here takes `now` so the tests can drive it without a server.
import { emptyRaw, MERGE_KEYS, type Raw } from './raw.ts';
import { maxAgeOf, type Adapter } from './adapters/types.ts';
import { redact } from './http.ts';
import type { SourceView } from '../shared/types.ts';

export interface AdapterState {
  /** the adapter's whole slice from its last good run (replaced, never merged into) */
  part: Partial<Raw> | null;
  lastOk: number | null; lastErrAt: number | null; err: string | null; errCount: number; inFlight: boolean;
}
/** enabled: false for an adapter whose modules are all off (server/modules.ts): never polled, not composed, not listed. */
type Opts = { mock?: boolean; dev?: boolean; log?: (msg: string) => void; now?: () => number; enabled?: (a: Adapter) => boolean };

const MERGE = new Set<string>(MERGE_KEYS);
/** No URLs with keys, no stack, one line: this text reaches the page (Health → Sources). */
export const shortErr = (e: unknown) => redact(String((e as Error)?.message ?? e).split('\n')[0]).slice(0, 160);
const sameErr = (m: string) => m.replace(/\d+(\.\d+)? ?ms\b/g, '');
/** A run gets at least 20 s and never more than one interval past its own. */
export const timeoutOf = (a: Adapter) => Math.max(a.every, 20_000);
/** /healthz: how long the snapshot loop or every source may fail before the container reports unhealthy. */
export const HEALTH_GRACE = 120_000;

export class Hub {
  readonly state = new Map<string, AdapterState>();
  readonly startedAt: number;
  private clashes = new Set<string>();
  private log: (msg: string) => void;
  private now: () => number;

  /** read on every use: a config reload can turn a module on or off */
  enabled(a: Adapter) { return this.o.enabled?.(a) ?? true; }

  constructor(readonly adapters: Adapter[], private o: Opts = {}) {
    this.log = o.log ?? (m => console.warn(m));
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
    for (const a of adapters) this.state.set(a.name, { part: null, lastOk: null, lastErrAt: null, err: null, errCount: 0, inFlight: false });
  }

  /** One poll, skipped while the previous one is in flight. A run that times out is abandoned (Promise.race drops
   *  its late answer), so one hung request can't wedge the adapter. */
  async tick(a: Adapter): Promise<'ok' | 'error' | 'skipped'> {
    const s = this.state.get(a.name)!;
    if (s.inFlight || !this.enabled(a) || !a.configured()) return 'skipped';
    s.inFlight = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const part = await Promise.race([
        a.run(),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('timed out')), timeoutOf(a)); }),
      ]);
      if (s.errCount) this.log(`[${a.name}] ok again after ${s.errCount} failed run${s.errCount === 1 ? '' : 's'}`);
      s.part = part ?? {}; s.lastOk = this.now(); s.errCount = 0;
      return 'ok';
    } catch (e) {
      const msg = shortErr(e);
      // once per distinct error, not every poll ('after 0 ms' vs 'after 1 ms' is the same error)
      if (!s.errCount || sameErr(msg) !== sameErr(s.err ?? '')) this.log(`[${a.name}] ${msg}`);
      s.err = msg; s.lastErrAt = this.now(); s.errCount++;
      return 'error';
    } finally {
      clearTimeout(timer);
      s.inFlight = false;
    }
  }

  fresh(a: Adapter, now = this.now()) {
    const s = this.state.get(a.name)!;
    return s.lastOk != null && now - s.lastOk <= maxAgeOf(a);
  }

  /** Raw from the fresh parts only, in ADAPTERS order. MERGE_KEYS merge per entry; every other key has one owner. */
  compose(now = this.now()): Raw {
    const raw = emptyRaw() as unknown as Record<string, unknown>;
    const owner: Record<string, string> = {};
    for (const a of this.adapters) {
      const part = this.state.get(a.name)!.part;
      if (!part || !this.enabled(a) || !a.configured() || !this.fresh(a, now)) continue;
      for (const [k, v] of Object.entries(part)) {
        if (v === undefined) continue;
        if (MERGE.has(k)) {
          // null from one adapter must not erase another's entries
          if (v) raw[k] = { ...(raw[k] as object | null), ...(v as object) };
          continue;
        }
        if (owner[k] && this.o.dev && !this.clashes.has(k)) { this.clashes.add(k); this.log(`[hub] ${owner[k]} and ${a.name} both write raw.${k}; ${a.name} wins`); }
        raw[k] = v; owner[k] = a.name;
      }
    }
    return raw as unknown as Raw;
  }

  sourceViews(now = this.now()): SourceView[] {
    return this.adapters.filter(a => this.enabled(a)).map((a): SourceView => {
      const s = this.state.get(a.name)!;
      const base = { name: a.name, label: a.label, everySec: a.every / 1000, maxAgeSec: maxAgeOf(a) / 1000 };
      // mock: answered on the poll interval's last beat, so the Sources heartbeats (review 3c) have something to draw
      if (this.o.mock) { const lastOk = Math.floor(now / a.every) * a.every; return { ...base, conn: 'mock', lastOk, ageSec: Math.round((now - lastOk) / 1000), error: null }; }
      if (!a.configured()) return { ...base, conn: 'not-connected', lastOk: null, ageSec: null, error: null, ...(a.needs ? { needs: a.needs } : {}) };
      // the latest attempt failed (data may still be fresh enough to show)
      const failing = s.lastErrAt != null && (s.lastOk == null || s.lastErrAt > s.lastOk);
      const error = failing ? s.err : s.lastOk == null ? 'no answer yet' : this.fresh(a, now) ? null : s.inFlight ? 'still waiting for an answer' : 'no recent answer';
      return {
        ...base,
        conn: this.fresh(a, now) ? 'ok' : s.lastOk != null ? 'stale' : 'error',
        lastOk: s.lastOk, ageSec: s.lastOk == null ? null : Math.round((now - s.lastOk) / 1000), error,
      };
    });
  }

  /** Why every configured source counts as down for longer than HEALTH_GRACE, or null. */
  allFailing(now = this.now()): string | null {
    if (this.o.mock || now - this.startedAt <= HEALTH_GRACE) return null;
    const on = this.adapters.filter(a => this.enabled(a) && a.configured());
    if (!on.length) return null; // nothing to watch is a config choice, not a failure
    const downFor = (a: Adapter) => { const s = this.state.get(a.name)!; return now - (s.lastOk == null ? this.startedAt : s.lastOk + maxAgeOf(a)); };
    return on.every(a => !this.fresh(a, now) && downFor(a) > HEALTH_GRACE) ? `all ${on.length} sources stale or failing` : null;
  }
}

/** rebuild() guard: a throw keeps the last good value, is logged once per distinct message and recorded. */
export class Guard<T> {
  last: T | null = null;
  lastOk: number | null = null;
  lastError: string | null = null;
  lastErrorAt: number | null = null;
  private seen = new Set<string>();
  constructor(private name: string, private log: (msg: string) => void = m => console.error(m)) {}

  run(build: () => T, now = Date.now()): T | null {
    try {
      this.last = build(); this.lastOk = now; this.lastError = null;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).split('\n')[0].slice(0, 200);
      if (!this.seen.has(msg)) {
        if (this.seen.size > 50) this.seen.clear();
        this.seen.add(msg);
        this.log(`[${this.name}] ${(e as Error)?.stack ?? msg}`);
      }
      this.lastError = msg; this.lastErrorAt = now;
    }
    return this.last;
  }
}

/** /healthz: null = healthy, else a short reason for the 503. */
export function healthReason(now: number, hub: Hub, rebuildOk: number | null): string | null {
  if (now - hub.startedAt > HEALTH_GRACE && now - (rebuildOk ?? hub.startedAt) > HEALTH_GRACE)
    return rebuildOk == null ? 'no snapshot built yet' : `last snapshot ${Math.round((now - rebuildOk) / 1000)} s old`;
  return hub.allFailing(now);
}
