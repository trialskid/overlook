// The Links tab, editable from the page: the only write path on the site, and it writes only
// its own DATA_DIR/links.json (never the homelab).
//   GET /api/links   the list as saved (LinksDoc), for the editor
//   PUT /api/links   { groups, baseUpdatedAt } replaces the whole list → { ok, updatedAt } | { ok: false, error }
// homelab.json `links` is only the seed: it is shown until the first save creates links.json, and after that the
// file wins (editing homelab.json `links` changes nothing). Every save copies the old file to
// links.json.bak-YYYYMMDD-HHMMSS first (newest 20 kept) and writes atomically (tmp + rename). A links.json that
// can't be read is logged once and the seed is shown, with linksMeta.error saying so.
import fs from 'node:fs';
import path from 'node:path';
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { clientOf } from './auth.ts';
import { LINK_LIMITS, seedLinks, validateLinks } from '../shared/links.ts';
import type { HomelabConfig, LinkGroup, LinksDoc } from '../shared/types.ts';

// DATA_DIR is /data in the image; without it (dev, mock) ./data, like kuma-history-v2.json and ntfy-activity.json
const dir = () => process.env.DATA_DIR?.trim() || 'data';
const file = () => path.join(dir(), 'links.json');
const KEEP = 20;
const BAK = /^links\.json\.bak-\d{8}-\d{6}(-\d+)?$/;
export const LINKS_UNREADABLE = 'Saved links could not be read, so these are the defaults from homelab.json. Saving replaces them (the unreadable file is backed up first).';

/** the last read of links.json, keyed by path + mtime + size, so a 10 s rebuild doesn't parse it every time */
let cache: { key: string; groups: LinkGroup[] | null; updatedAt: number | null } | null = null;
let warned = '';
const stamp = (f: string) => { try { const s = fs.statSync(f); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return null; } };

export function readLinks(cfg: HomelabConfig): LinksDoc {
  const f = file(), key = stamp(f);
  if (!key) return { groups: seedLinks(cfg), updatedAt: null, fromFile: false, error: null }; // never saved: the seed follows homelab.json reloads
  if (cache?.key !== key) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j?.version !== 1) throw new Error(`unknown version ${JSON.stringify(j?.version)}`);
      if (!Number.isFinite(j.updatedAt)) throw new Error('no updatedAt');
      const v = validateLinks(j.groups);
      if (!v.ok) throw new Error(v.error);
      cache = { key, groups: v.groups, updatedAt: j.updatedAt };
    } catch (e) {
      if (warned !== key) { warned = key; console.warn(`[links] ${f} not usable, showing homelab.json's links: ${(e as Error).message}`); }
      cache = { key, groups: null, updatedAt: null };
    }
  }
  return cache.groups ? { groups: cache.groups, updatedAt: cache.updatedAt, fromFile: true, error: null } : { groups: seedLinks(cfg), updatedAt: null, fromFile: false, error: LINKS_UNREADABLE };
}

const pad = (n: number) => String(n).padStart(2, '0');
const tsName = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** Backs up the current file (if any), keeps the newest KEEP backups, writes atomically. Returns the new updatedAt. */
export function saveLinks(groups: LinkGroup[], prev: number | null, now = Date.now()): number {
  const d = dir(), f = file();
  fs.mkdirSync(d, { recursive: true });
  if (fs.existsSync(f)) {
    // two saves in one second: links.json.bak-…-120000, then …-120000-1
    let bak = path.join(d, `links.json.bak-${tsName(new Date(now))}`);
    for (let i = 1; fs.existsSync(bak); i++) bak = bak.replace(/(-\d{6})(-\d+)?$/, `$1-${i}`);
    fs.copyFileSync(f, bak);
    const old = fs.readdirSync(d).filter(n => BAK.test(n))
      .map(n => ({ n, t: fs.statSync(path.join(d, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t || b.n.localeCompare(a.n, undefined, { numeric: true }));
    for (const { n } of old.slice(KEEP)) fs.rmSync(path.join(d, n), { force: true });
  }
  const updatedAt = Math.max(now, (prev ?? 0) + 1); // always moves, so a save in the same ms still reads as a change
  const tmp = `${f}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt, groups }, null, 2) + '\n');
    fs.renameSync(tmp, f); // never a half-written links.json
  } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
  cache = null;
  return updatedAt;
}

// ---- PUT guards
/** Cross-site writes: the custom header can't be sent cross-origin without a CORS preflight (which this server never
 *  answers: OPTIONS is 405), and the browser-set Origin must name this site. Caddy passes the browser's Host through
 *  unchanged and adds X-Forwarded-Host with the same name (overlook.lab.example.com); either may match, so a later
 *  `header_up Host` in Caddy doesn't break saving. Neither can be set by another site's page. */
const norm = (h: string | undefined) => (h ?? '').split(',')[0].trim().toLowerCase().replace(/:(80|443)$/, '');
export function sameOrigin(c: Context): boolean {
  if (c.req.header('x-cc-edit') !== '1') return false;
  const o = c.req.header('origin');
  let host: string;
  try { host = norm(new URL(o ?? '').host); } catch { return false; }
  return !!host && [c.req.header('host'), c.req.header('x-forwarded-host')].some(h => norm(h) === host);
}
/** 30 saves per client in 10 min (X-Forwarded-For is Caddy's, as for the login's limit) */
const saves = new Map<string, number[]>();
const WINDOW = 10 * 60e3, MAX_SAVES = 30;
function overLimit(ip: string, now: number) {
  const t = (saves.get(ip) ?? []).filter(x => now - x < WINDOW);
  if (saves.size > 1000) saves.clear();
  if (t.length >= MAX_SAVES) { saves.set(ip, t); return true; }
  t.push(now); saves.set(ip, t);
  return false;
}

const fail = (c: Context, status: 400 | 403 | 409 | 429 | 500, error: string, extra: object = {}) => c.json({ ok: false, error, ...extra }, status);

/** Mounted after the login gate (server/gates.ts), so both routes need a signed-in device. */
export function linksRoutes(app: Hono, o: { cfg: () => HomelabConfig; onSave: () => void }) {
  app.get('/api/links', c => { c.header('Cache-Control', 'no-store'); return c.json(readLinks(o.cfg())); });
  app.put('/api/links',
    async (c, next) => {
      if (!sameOrigin(c)) return fail(c, 403, 'Refused: this save did not come from the Command Center page.');
      if (overLimit(clientOf(c), Date.now())) return fail(c, 429, 'Too many saves. Wait a few minutes.');
      if (!/^application\/json\s*(;|$)/i.test(c.req.header('content-type') ?? '')) return fail(c, 400, 'Send the links as JSON (Content-Type: application/json).');
      await next();
    },
    bodyLimit({ maxSize: LINK_LIMITS.bodyBytes, onError: c => fail(c, 400, 'Too much data (over 64 KB).') }),
    async c => {
      let body: { groups?: unknown; baseUpdatedAt?: unknown };
      try { body = await c.req.json(); } catch { return fail(c, 400, 'That was not valid JSON.'); }
      const base = body?.baseUpdatedAt;
      if (base !== null && !Number.isFinite(base)) return fail(c, 400, 'baseUpdatedAt must be a number or null.');
      const v = validateLinks(body.groups);
      if (!v.ok) return fail(c, 400, v.error);
      const cur = readLinks(o.cfg());
      if (base !== cur.updatedAt) return fail(c, 409, 'Links were changed on another device.', { current: cur });
      let updatedAt: number;
      try { updatedAt = saveLinks(v.groups, cur.updatedAt); } catch (e) {
        console.error(`[links] save failed: ${(e as Error).message}`);
        return fail(c, 500, 'The server could not save the links (see its log). Nothing was changed.');
      }
      console.log(`[links] saved by ${clientOf(c)}: ${v.groups.length} categor${v.groups.length === 1 ? 'y' : 'ies'}, ${v.groups.reduce((a, g) => a + g.items.length, 0)} links`);
      o.onSave();
      return c.json({ ok: true, updatedAt });
    });
}
