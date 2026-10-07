// ntfy (.205:5080): its health, plus the notifications on the alert topics (reader token, GET only).
// ntfy's cache keeps 24 h, so what we've seen is kept in DATA_DIR/ntfy-activity.json for 14 days. It
// feeds the side panel's recent notifications and the jobs whose only signal is an ntfy message.
// Each poll asks only for what's new (since=<newest id seen>); a failed poll throws, so the panel says
// "not answering" instead of showing an old list as current.
import fs from 'node:fs';
import path from 'node:path';
import { getJSON, getText } from '../http.ts';
import { config } from '../config.ts';
import { env, trimUrl, type Adapter } from './types.ts';
import type { JobRaw, Raw } from '../raw.ts';
import type { JobConfig, Status } from '../../shared/types.ts';

const DAY = 86400e3, KEEP = 14 * DAY, CAP = 500, V = 1;
interface Msg { id: string; at: number; topic: string; title: string; body: string; priority: number; tags: string[] }
/** last: newest message id seen. from: per topic, since when our kept history is complete. polled: last good poll. */
interface Store { v: number; last: string | null; from: Record<string, number>; polled: number; msgs: Msg[] }

const file = () => path.join(env('DATA_DIR') || 'data', 'ntfy-activity.json');
const blank = (): Store => ({ v: V, last: null, from: {}, polled: 0, msgs: [] });
let store = blank();
try { const s = JSON.parse(fs.readFileSync(file(), 'utf8')); if (s?.v === V && Array.isArray(s.msgs)) store = { ...blank(), ...s }; } catch { /* first run */ }
let dirty = false, lastSave = 0;
export function saveNtfyActivity() {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file() + '.tmp', JSON.stringify(store)); fs.renameSync(file() + '.tmp', file());
    dirty = false; lastSave = Date.now();
  } catch (e) { console.warn(`[ntfy] activity not saved: ${(e as Error).message}`); }
}

const topics = () => env('NTFY_TOPICS').split(',').map(t => t.trim()).filter(Boolean);
const clip = (s: unknown, n: number) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

async function poll(base: string, now: number) {
  const ts = topics();
  // after a gap longer than ntfy's cache (CC down for a day), anything older than 24 h may be missing
  if (now - store.polled > 23 * 3600e3) { store.last = null; for (const t of ts) store.from[t] = now - DAY; }
  for (const t of ts) store.from[t] ??= now - DAY; // a newly added topic: complete from its first poll's 24 h
  const body = await getText(`${base}/${ts.map(encodeURIComponent).join(',')}/json?poll=1&since=${store.last ?? '24h'}`, { headers: { Authorization: `Bearer ${env('NTFY_TOKEN')}` }, timeout: 10_000 });
  const seen = new Set(store.msgs.map(m => m.id));
  for (const line of body.split('\n')) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    if (e?.event !== 'message' || !e.id || seen.has(e.id)) continue;
    seen.add(e.id);
    store.msgs.push({ id: String(e.id), at: Number(e.time) * 1000, topic: String(e.topic), title: clip(e.title, 200), body: clip(e.message, 300), priority: Number(e.priority) || 3, tags: Array.isArray(e.tags) ? e.tags.map(String).slice(0, 8) : [] });
    store.last = String(e.id); // ntfy returns oldest first, so the last one is the newest
    dirty = true;
  }
  store.msgs = store.msgs.filter(m => now - m.at <= KEEP).sort((a, b) => b.at - a.at).slice(0, CAP);
  for (const t of Object.keys(store.from)) store.from[t] = Math.max(store.from[t], now - KEEP);
  store.polled = now;
}

// ---- jobs whose only signal is ntfy: the newest matching message on the topic marks the last run
const FAIL = /fail|error|✗|❌|unhealthy/i, OK = /\bok\b|success|pass|✓|✅|healthy/i;
/** the title decides when it can; the body only when the title says nothing either way */
const verdict = (m: Msg): boolean | null => {
  for (const t of [m.title, m.body]) { if (FAIL.test(t)) return false; if (OK.test(t)) return true; }
  return null;
};
const dayStart = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const regex = (s?: string) => { try { return s ? new RegExp(s, 'i') : null; } catch { return null; } };

function job(j: JobConfig, now: number): JobRaw {
  const re = regex(j.match);
  const hits = store.msgs.filter(m => m.topic === j.topic && (!re || re.test(m.title || m.body)));
  const newest = hits[0], good = hits.find(m => verdict(m) !== false);
  const daily = /daily|nightly|hourly|every/i.test(j.schedule) && !/weekly/i.test(j.schedule);
  const from = store.from[j.topic!] ?? now, today = dayStart(now);
  const days: Status[] = Array.from({ length: 14 }, (_, i) => {
    const a = dayStart(today - (13 - i) * DAY + 12 * 3600e3), b = dayStart(a + DAY + 12 * 3600e3); // DST-safe day edges
    const that = hits.filter(m => m.at >= a && m.at < b);
    if (that.some(m => verdict(m) === false)) return 'down';
    if (that.length) return 'up';
    return daily && a >= from && b <= now ? 'degraded' : 'unknown'; // no message on a day we fully saw
  });
  return { lastAt: good?.at ?? null, ok: newest ? verdict(newest) : null, detail: newest ? clip(newest.title || newest.body, 120) : topics().includes(j.topic!) ? 'no message in the kept history' : `topic '${j.topic}' is not in NTFY_TOPICS`, days };
}

export const ntfy: Adapter = {
  name: 'ntfy',
  label: 'ntfy',
  every: 60_000,
  needs: 'the ntfy URL (NTFY_URL), plus a reader token and topics (NTFY_TOKEN, NTFY_TOPICS) for notifications',
  configured: () => !!env('NTFY_URL'),
  async run() {
    const base = trimUrl(env('NTFY_URL')), now = Date.now();
    const h = await getJSON(`${base}/v1/health`).catch(() => null);
    const out: Partial<Raw> = { ntfyUp: h?.healthy === true };
    if (!env('NTFY_TOKEN') || !topics().length) return out; // health only: no reader token, no feed
    await poll(base, now);
    if (dirty && now - lastSave > 5 * 60e3) saveNtfyActivity();
    out.activity = store.msgs.map(({ at, topic, title, body, priority, tags }) => ({ at, topic, title, body, priority, tags }));
    const jobs: Record<string, JobRaw> = {};
    for (const j of config.jobs) if (j.signal === 'ntfy' && j.topic) jobs[j.id] = job(j, now);
    out.jobs = jobs;
    return out;
  },
};
