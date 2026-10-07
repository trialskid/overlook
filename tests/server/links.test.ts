// The Links tab's editor: storage (seed, file, backups, atomic write, unreadable file), validation, and the HTTP
// gates in front of PUT /api/links (method, login, CSRF, rate limit, conflict). Everything under a temp DATA_DIR.
// Run: node --import tsx --test tests/server/links.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-links-'));
let n = 0;
/** a fresh, empty DATA_DIR for one test */
const freshDir = () => { const d = path.join(root, `t${++n}`); process.env.DATA_DIR = d; return d; };
freshDir();
process.env.CC_SESSION_SECRET = 'test-secret';
process.env.CC_LOGIN_BCRYPT = bcrypt.hashSync('pw', 4);
process.env.CC_TRUST_PROXY = '1'; // the rate limit keys on X-Forwarded-For only behind a trusted proxy (server/auth.ts)
const { gates } = await import('../../server/gates.ts');
const { linksRoutes, readLinks, saveLinks, LINKS_UNREADABLE } = await import('../../server/links.ts');
const { makeSession } = await import('../../server/auth.ts');
const { config } = await import('../../server/config.ts');
const { derive } = await import('../../server/derive.ts');
const { emptyRaw } = await import('../../server/raw.ts');
const { seedLinks, urlProblem, validateLinks, LINK_LIMITS } = await import('../../shared/links.ts');
import type { LinkGroup, Snapshot } from '../../shared/types.ts';

const OPTS = { mock: false, incident: false, build: 'test' };
const snapshot = () => derive(emptyRaw(), [], { ...OPTS, links: readLinks(config) });
let snap: Snapshot = snapshot(), saves = 0;
const app = new Hono();
gates(app);
linksRoutes(app, { cfg: () => config, onSave: () => { saves++; snap = snapshot(); } });
app.get('/api/snapshot', c => c.json(snap));
app.get('/api/*', c => c.json({ error: 'not found' }, 404));

const cookie = `cc_session=${makeSession()}`;
let ip = 0;
const HOST = 'homepage.lab.example.com', ORIGIN = `https://${HOST}`;
const req = (method: string, p: string, body?: unknown, h: Record<string, string | undefined> = {}) => {
  const headers = Object.fromEntries(Object.entries({
    host: HOST, origin: ORIGIN, 'x-cc-edit': '1', 'content-type': 'application/json', cookie, 'x-forwarded-for': `10.0.${ip >> 8}.${++ip & 255}`, ...h,
  }).filter(([, v]) => v !== undefined)) as Record<string, string>;
  return app.request(`http://${HOST}${p}`, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
};
const put = (body: unknown, h: Record<string, string | undefined> = {}) => req('PUT', '/api/links', body, h);
const GROUPS: LinkGroup[] = [{ name: 'Mine', items: [{ name: 'Photos', url: 'photos.example.com' }, { name: 'Meal', url: 'http://10.20.0.86:3000' }] }, { name: 'Empty', items: [] }];
const file = (d: string) => path.join(d, 'links.json');
const backups = (d: string) => fs.readdirSync(d).filter(x => x.startsWith('links.json.bak-')).sort();

test('no links.json: the seed from homelab.json, shown as before', () => {
  freshDir();
  const doc = readLinks(config);
  assert.deepEqual(doc, { groups: seedLinks(config), updatedAt: null, fromFile: false, error: null });
  const s = snapshot();
  assert.equal(s.links.length, Object.keys(config.links).length);
  const wiki = s.links.find(g => g.group === 'Documentation')!.items.find(l => l.name === 'Proxmox Wiki')!;
  assert.deepEqual(wiki, { name: 'Proxmox Wiki', domain: 'pve.proxmox.com', url: 'https://pve.proxmox.com' }); // a bare domain gets https
  const router = s.links.find(g => g.group === 'Tools')!.items.find(l => l.name === 'Router')!;
  assert.deepEqual(router, { name: 'Router', domain: '10.20.0.1', url: 'http://10.20.0.1' }); // a LAN URL keeps its scheme
  assert.deepEqual(s.linksMeta, { updatedAt: null, fromFile: false, error: null });
  // every seeded link passes the editor's rules, so saving it unchanged works
  assert.ok(validateLinks(seedLinks(config)).ok);
});

test('the first save creates links.json; after that the file wins over homelab.json', () => {
  const d = freshDir();
  const at = saveLinks(GROUPS, null, Date.UTC(2026, 9, 6, 18));
  const j = JSON.parse(fs.readFileSync(file(d), 'utf8'));
  assert.deepEqual(j, { version: 1, updatedAt: at, groups: GROUPS });
  assert.deepEqual(backups(d), []); // nothing to back up on the first save
  const doc = readLinks({ ...config, links: { Other: [['X', 'x.com']] } });
  assert.deepEqual(doc, { groups: GROUPS, updatedAt: at, fromFile: true, error: null });
  assert.deepEqual(derive(emptyRaw(), [], { ...OPTS, links: doc }).links.map(g => g.group), ['Mine', 'Empty']);
});

test('every save backs the old file up first; the newest 20 backups are kept', () => {
  const d = freshDir();
  const t0 = new Date(2026, 9, 6, 12, 0, 0).getTime(); // local time, like the backup names
  let prev: number | null = null;
  for (let i = 0; i < 25; i++) prev = saveLinks([{ name: `G${i}`, items: [] }], prev, t0 + i * 1000);
  const b = backups(d);
  assert.equal(b.length, 20);
  // saves 1..24 made a backup each (of saves 0..23); the 4 oldest are gone
  assert.equal(b[0], 'links.json.bak-20261006-120005');
  assert.equal(b[19], 'links.json.bak-20261006-120024');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, b[19]), 'utf8')).groups[0].name, 'G23');
  assert.equal(readLinks(config).groups[0].name, 'G24');
  // two saves in the same second keep both backups
  prev = saveLinks([{ name: 'A', items: [] }], prev, t0 + 30_000);
  saveLinks([{ name: 'B', items: [] }], prev, t0 + 30_000);
  assert.ok(backups(d).includes('links.json.bak-20261006-120030') && backups(d).includes('links.json.bak-20261006-120030-1'));
  assert.equal(backups(d).length, 20);
});

test('atomic write: tmp file + rename; a failed write leaves the old file and no tmp', () => {
  const d = freshDir();
  const first = saveLinks(GROUPS, null);
  const before = fs.readFileSync(file(d), 'utf8');
  const rename = fs.renameSync, renames: [string, string][] = [];
  fs.renameSync = ((a: string, b: string) => { renames.push([a, b]); return rename(a, b); }) as typeof fs.renameSync;
  try { saveLinks([{ name: 'New', items: [] }], first); } finally { fs.renameSync = rename; }
  assert.equal(renames.length, 1);
  assert.match(renames[0][0], /links\.json\.tmp-\d+$/);
  assert.equal(renames[0][1], file(d));
  const now = fs.readFileSync(file(d), 'utf8');
  const write = fs.writeFileSync;
  fs.writeFileSync = (() => { throw new Error('disk full'); }) as typeof fs.writeFileSync;
  try { assert.throws(() => saveLinks([{ name: 'Lost', items: [] }], null), /disk full/); } finally { fs.writeFileSync = write; }
  assert.equal(fs.readFileSync(file(d), 'utf8'), now);
  assert.notEqual(now, before);
  assert.deepEqual(fs.readdirSync(d).filter(x => x.includes('.tmp')), []);
});

test('an unreadable links.json: the seed, a quiet flag, logged once; saving over it backs it up', async () => {
  const d = freshDir();
  fs.mkdirSync(d, { recursive: true });
  for (const bad of ['{nope', JSON.stringify({ version: 1, updatedAt: 1, groups: [{ name: 'X', items: [{ name: 'Evil', url: 'javascript:alert(1)' }] }] }), JSON.stringify({ version: 2, updatedAt: 1, groups: GROUPS })]) {
    fs.writeFileSync(file(d), bad);
    const warn = console.warn, logged: string[] = [];
    console.warn = (m: string) => { logged.push(m); };
    try {
      const doc = readLinks(config);
      assert.deepEqual(doc, { groups: seedLinks(config), updatedAt: null, fromFile: false, error: LINKS_UNREADABLE });
      readLinks(config); readLinks(config);
      assert.equal(derive(emptyRaw(), [], { ...OPTS, links: doc }).linksMeta.error, LINKS_UNREADABLE);
    } finally { console.warn = warn; }
    assert.equal(logged.length, 1);
    assert.match(logged[0], /links\.json not usable/);
    fs.rmSync(file(d)); await new Promise(r => setTimeout(r, 5)); // a new mtime for the next round
  }
  fs.writeFileSync(file(d), '{nope');
  const r = await put({ groups: GROUPS, baseUpdatedAt: null });
  assert.equal(r.status, 200);
  assert.equal(fs.readFileSync(path.join(d, backups(d)[0]), 'utf8'), '{nope');
  assert.equal(readLinks(config).fromFile, true);
});

test('validation: plain-English refusals, trimmed values', () => {
  const v = (groups: unknown) => validateLinks(groups);
  const g = (items: { name: string; url: string }[], name = 'G') => [{ name, items }];
  const bad = (groups: unknown, re: RegExp) => { const r = v(groups); assert.ok(!r.ok, JSON.stringify(groups)); assert.match((r as { error: string }).error, re); };
  for (const u of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd', 'mailto:a@b.c', 'ftp://x.com', 'http:/x.com', '//x.com'])
    bad(g([{ name: 'x', url: u }]), /URL (only http|not a web address)/);
  for (const u of ['exa mple.com', 'x.com/a b', 'x.com\n/a', '-x.com', 'x..com', 'user@x.com', 'https://', ''])
    bad(g([{ name: 'x', url: u }]), /URL (not a web address|needs a URL)/);
  for (const u of ['x.com', 'photos.example.com', 'github.com/awesome-selfhosted/awesome-selfhosted', 'http://10.20.0.86:3000', 'HTTPS://X.com/a?b=c#d', 'localhost:8080/x', 'storage.example.net/storage'])
    assert.ok(urlProblem(u) === null, u);
  bad(g([{ name: 'x', url: 'x'.repeat(290) + '.com/aaaaaaaaaaaa' }]), /over 300 characters/);
  bad(g([{ name: '   ', url: 'x.com' }]), /link 1: needs a name/);
  bad(g([{ name: 'n'.repeat(61), url: 'x.com' }]), /over 60 characters/);
  bad(g([], ' '), /Category 1: needs a name/);
  bad(g([], 'c'.repeat(41)), /over 40 characters/);
  bad([{ name: 'Tools', items: [] }, { name: ' tools ', items: [] }], /Category 2 \(“tools”\): another category already has this name/);
  bad([], /at least one category/);
  bad(Array.from({ length: 61 }, (_, i) => ({ name: `G${i}`, items: [] })), /Too many categories \(61; at most 60\)/);
  bad(Array.from({ length: 4 }, (_, i) => ({ name: `G${i}`, items: Array.from({ length: 76 }, (_, j) => ({ name: `L${j}`, url: 'x.com' })) })), /Too many links \(304; at most 300\)/);
  bad({ groups: [] }, /No list/);
  bad([{ name: 'G' }], /is not a category/);
  const ok = v([{ name: '  Tools ', items: [{ name: ' Speed ', url: ' speedtest.net ', extra: 1 }] }]);
  assert.deepEqual(ok, { ok: true, groups: [{ name: 'Tools', items: [{ name: 'Speed', url: 'speedtest.net' }] }] });
  assert.ok(v(Array.from({ length: 60 }, (_, i) => ({ name: `G${i}`, items: i < 5 ? Array.from({ length: 60 }, (_, j) => ({ name: `L${j}`, url: 'x.com' })) : [] }))).ok);
});

test('method gate: the only writes are POST /login, POST /logout and PUT /api/links', async () => {
  freshDir();
  for (const [m, p] of [['PUT', '/api/snapshot'], ['POST', '/api/links'], ['DELETE', '/api/links'], ['PATCH', '/api/links'], ['OPTIONS', '/api/links'], ['PUT', '/api/links/'], ['PUT', '/login'], ['DELETE', '/'], ['POST', '/api/stream']]) {
    const r = await req(m, p, m === 'OPTIONS' ? undefined : { groups: GROUPS, baseUpdatedAt: null });
    assert.equal(r.status, 405, `${m} ${p}`);
    assert.equal(await r.text(), 'read-only');
  }
  assert.equal((await req('POST', '/logout')).status, 303);
  assert.equal((await req('GET', '/api/links')).status, 200);
});

test('PUT /api/links: login, then same-origin, then validation', async () => {
  freshDir();
  const body = { groups: GROUPS, baseUpdatedAt: null };
  let r = await put(body, { cookie: undefined });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'sign in' });
  assert.equal((await req('GET', '/api/links', undefined, { cookie: undefined })).status, 401);
  for (const h of [{ 'x-cc-edit': undefined }, { 'x-cc-edit': '0' }, { origin: 'https://evil.example' }, { origin: undefined }, { origin: 'null' },
    { origin: 'https://homepage.lab.example.com.evil.example' }, { origin: 'http://homepage.lab.example.com:8080' }, { host: '10.20.0.205:4466' }]) {
    r = await put(body, h);
    assert.equal(r.status, 403, JSON.stringify(h));
    assert.equal((await r.json()).ok, false);
  }
  assert.ok(!fs.existsSync(file(process.env.DATA_DIR!)));
  r = await put(body, { 'content-type': 'text/plain' });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /application\/json/);
  r = await put(JSON.stringify({ groups: GROUPS, baseUpdatedAt: null, pad: 'x'.repeat(LINK_LIMITS.bodyBytes) }));
  assert.equal(r.status, 400); assert.match((await r.json()).error, /over 64 KB/);
  r = await put('{"groups":');
  assert.equal(r.status, 400); assert.match((await r.json()).error, /not valid JSON/);
  r = await put({ groups: GROUPS });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /baseUpdatedAt/);
  r = await put({ groups: [{ name: 'X', items: [{ name: 'Evil', url: 'javascript:alert(1)' }] }], baseUpdatedAt: null });
  assert.equal(r.status, 400); assert.match((await r.json()).error, /Category 1 \(“X”\), link 1 \(“Evil”\): URL only http/);
  assert.ok(!fs.existsSync(file(process.env.DATA_DIR!)));
  // behind Caddy with a rewritten Host: X-Forwarded-Host names the site
  r = await put(body, { host: '10.20.0.205:4466', 'x-forwarded-host': HOST });
  assert.equal(r.status, 200);
});

test('PUT /api/links: saves, pushes a new snapshot, and refuses a stale base with the current list (409)', async () => {
  const d = freshDir();
  snap = snapshot();
  assert.notDeepEqual(snap.links.map(g => g.group), ['Mine', 'Empty']);
  const before = saves;
  let r = await put({ groups: GROUPS, baseUpdatedAt: null });
  assert.equal(r.status, 200);
  const { ok, updatedAt } = await r.json();
  assert.ok(ok && Number.isFinite(updatedAt));
  assert.equal(saves, before + 1);
  const s: Snapshot = await (await req('GET', '/api/snapshot')).json();
  assert.deepEqual(s.links, [{ group: 'Mine', items: [{ name: 'Photos', domain: 'photos.example.com', url: 'https://photos.example.com' }, { name: 'Meal', domain: '10.20.0.86:3000', url: 'http://10.20.0.86:3000' }] }, { group: 'Empty', items: [] }]);
  assert.deepEqual(s.linksMeta, { updatedAt, fromFile: true, error: null });
  assert.deepEqual(await (await req('GET', '/api/links')).json(), { groups: GROUPS, updatedAt, fromFile: true, error: null });
  // another device saved meanwhile: this one still holds null (or an older stamp)
  for (const base of [null, updatedAt - 1]) {
    r = await put({ groups: [{ name: 'Mine', items: [] }], baseUpdatedAt: base });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.deepEqual(j.current, { groups: GROUPS, updatedAt, fromFile: true, error: null });
  }
  assert.equal(saves, before + 1);
  r = await put({ groups: [{ name: 'Mine', items: [] }], baseUpdatedAt: updatedAt });
  assert.equal(r.status, 200);
  assert.equal(backups(d).length, 1);
});

test('rate limit: 30 saves per client in 10 minutes', async () => {
  freshDir();
  const me = { 'x-forwarded-for': '10.9.9.9, 10.20.0.203' };
  for (let i = 0; i < 30; i++) assert.equal((await put({ groups: 'nope', baseUpdatedAt: null }, me)).status, 400);
  const r = await put({ groups: GROUPS, baseUpdatedAt: null }, me);
  assert.equal(r.status, 429);
  assert.match((await r.json()).error, /Too many saves/);
  assert.equal((await put({ groups: GROUPS, baseUpdatedAt: null }, { 'x-forwarded-for': '10.9.9.10' })).status, 200);
});
