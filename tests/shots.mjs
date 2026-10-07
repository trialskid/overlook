// Screenshots of every tab and state at 1440, 1152 and 390 (plus 1920 and two tablet sizes) against a running server
// (default :8790, start it with: npm run build && MOCK=1 NODE_ENV=production ALLOW_SIMULATE=1 PORT=8790 node dist/server/index.js;
// MOCK_CALM=1 for the calm Overview, the default mock is amber).
// Output: test-results/shots/ (or OUT=<dir>/). Fails on any console error or failed layout check.
import fs from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const OUT = process.env.OUT ? process.env.OUT.replace(/\/?$/, '/') : new URL('../test-results/shots/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const errors = [];
const tone = async q => (await (await fetch(`${BASE}/api/snapshot${q}`)).json()).status.tone;
const [toneNow, toneInc] = [await tone(''), await tone('?simulateIncident=1')];
// the lab's own names to click: a guest and the second host, and the guest that runs the simulated incident's UI
const lab = await (await fetch(`${BASE}/api/snapshot`)).json(), inc = await (await fetch(`${BASE}/api/snapshot?simulateIncident=1`)).json();
const GUEST = (lab.guests.find(g => g.kind === 'lxc') ?? lab.guests[0]).name, HOST2 = (lab.hosts[1] ?? lab.hosts[0]).name, HOST1 = lab.hosts[0].name;
const incUi = inc.uis.find(u => u.status === 'down'), INC_GUEST = inc.guests.find(g => g.id === incUi?.owner?.id)?.name ?? GUEST;
console.log(`tones: normal ${toneNow}, simulateIncident ${toneInc}`);
const b = await chromium.launch();
const watch = p => {
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type() === 'error' && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
  p.on('response', r => r.status() >= 400 && errors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`)); // names the URL, unlike the console line
  return p;
};
const page = async (opts, q = '') => {
  const p = watch(await b.newPage(opts));
  await p.goto(BASE + '/' + q); await p.waitForSelector('[role=tablist]'); await p.waitForTimeout(600);
  return p;
};
const shot = (p, name, full = true) => p.screenshot({ path: `${OUT}${name}.png`, fullPage: full });
const check = (ok, what) => { if (!ok) errors.push(`check failed: ${what}`); };
/** review Phase 5: which shape leads, in page order */
const shape = p => p.evaluate(() => {
  const root = document.querySelector('[data-shape]');
  return { shape: root?.dataset.shape ?? null, order: root ? [...root.querySelectorAll(':scope > [data-section]')].map(e => e.dataset.section) : [], map: !!document.querySelector('svg circle.packet') };
});
const D = { viewport: { width: 1440, height: 900 } };
// the failure path in the band (review 3d) draws once on load: shoot it finished
const SETTLE = 3000;

// ---- 1440: the four tabs (review Phase 5: Links became Overview's Bookmarks, Devices a Health section)
const d = await page(D); await d.waitForTimeout(SETTLE);
for (const t of ['Overview', 'Health', 'Media', 'House']) { await d.getByRole('tab', { name: t }).click(); await d.waitForTimeout(300); await shot(d, `d-${t}`); }
// Download activity: switching qBittorrent ↔ NZBGet moves nothing above the chart (the header's parts and the chart's box)
await d.getByRole('tab', { name: 'Media' }).click(); await d.waitForTimeout(300);
const dlBoxes = () => d.evaluate(() => {
  const head = document.querySelector('[aria-label="Download chart source"]').parentElement;
  return [...head.children, head.nextElementSibling].map(e => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(','); }).join(' ');
});
const dlBefore = await dlBoxes();
await d.getByRole('radio', { name: 'NZBGet' }).click(); await d.waitForTimeout(300); await shot(d, 'd-Media-nzbget');
const dlAfter = await dlBoxes();
if (dlAfter !== dlBefore) errors.push(`Download activity moved when switching to NZBGet: ${dlBefore} → ${dlAfter}`);
await d.getByRole('radio', { name: 'qBittorrent' }).click(); await d.waitForTimeout(200);
// Health › Devices, from the index
await d.getByRole('tab', { name: 'Health' }).click(); await d.waitForTimeout(300);
await d.getByRole('button', { name: /^Devices: / }).click(); await d.waitForTimeout(900); await shot(d, 'd-Health-devices', false);

// ---- 1440 Overview, normal: Open leads (green: nothing above it; amber: the one amber line)
await d.getByRole('tab', { name: 'Overview' }).click(); await d.waitForTimeout(300);
{
  const s = await shape(d);
  if (toneNow === 'danger') check(s.shape === 'incident' && s.order[0] === 'band', `red: the band leads (${s.order})`);
  else check(s.shape === 'calm' && s.order[0] === (toneNow === 'warn' ? 'amber' : 'open') && !s.order.includes('band'), `${toneNow}: Open leads (${s.order})`);
  check(s.order.indexOf('open') < s.order.indexOf('network') && s.order.indexOf('network') < s.order.indexOf('glance') && s.order.at(-1) === 'bookmarks', `section order (${s.order})`);
}
// amber: the line under the header; two or more items unfold from it, one shows its detail and action in place
if (toneNow === 'warn') {
  await shot(d, 'd-amber', false);
  const more = d.getByRole('button', { name: /to look at/ });
  if (await more.count()) { await more.click(); await d.waitForTimeout(300); await shot(d, 'd-amber-open', false); await more.click(); }
  else check(await d.evaluate(() => !!document.querySelector('[data-section=amber] a')), 'one amber item: its action is in the line');
}
// one search over services and bookmarks
await d.getByRole('textbox', { name: 'Search services and bookmarks' }).fill('hom'); await d.waitForTimeout(300); await shot(d, 'd-open-search', false);
await d.getByRole('textbox', { name: 'Search services and bookmarks' }).press('Escape'); await d.waitForTimeout(200);
await d.getByRole('button', { name: /^Bookmarks · \d+/ }).click(); await d.waitForTimeout(900); await shot(d, 'd-bookmarks', false);
await d.evaluate(() => scrollTo(0, 0));
// the full map, in place
await d.getByRole('button', { name: /^Full map/ }).click(); await d.waitForTimeout(400); await shot(d, 'd-fullmap');
await d.getByRole('button', { name: GUEST, exact: true }).click(); await d.waitForTimeout(300);
await d.evaluate(() => document.getElementById('overview-map').scrollIntoView()); await shot(d, 'd-fullmap-sel', false);
await d.getByRole('button', { name: /^Hide map/ }).click(); await d.waitForTimeout(200);
await d.evaluate(() => scrollTo(0, 0));
await d.keyboard.press('Meta+k'); await d.waitForTimeout(200); await d.keyboard.type('dock'); await d.waitForTimeout(200); await shot(d, 'd-palette', false);
await d.keyboard.press('Escape');
// '/' opens the same palette (review finding 10)
await d.keyboard.press('/'); await d.waitForTimeout(200); await shot(d, 'd-slash', false); await d.keyboard.press('Escape');
// ⌘K to an online Other LAN device: the folded list opens, so its row is there to land on
{
  const snapNow = await (await fetch(`${BASE}/api/snapshot`)).json();
  const lanUp = snapNow.devices.groups.find(g => g.id === 'lan')?.rows.find(r => r.status === 'up');
  if (lanUp) {
    await d.keyboard.press('Meta+k'); await d.waitForTimeout(200); await d.keyboard.type(lanUp.name); await d.waitForTimeout(200); await d.keyboard.press('Enter'); await d.waitForTimeout(700);
    check(await d.evaluate(k => !!document.getElementById(`dev-${k}`), lanUp.key), `⌘K to ${lanUp.name}: its row is on the page`);
    await d.getByRole('tab', { name: 'Overview' }).click(); await d.waitForTimeout(200);
  }
}

// ---- 1440 Overview, incident: the band leads, the trace draws to Gitea, Open and the network band follow
const di = await page(D, '?simulateIncident=1'); await di.waitForTimeout(SETTLE); await shot(di, 'd-incident');
{
  const s = await shape(di);
  check(s.shape === 'incident' && s.order[0] === 'band' && s.order[1] === 'open' && s.order[2] === 'network', `incident: band, Open, network (${s.order})`);
  const op = await di.evaluate(() => ({
    off: [...document.querySelectorAll('[data-host][data-off] > button')].map(e => getComputedStyle(e).opacity),
    fail: [...document.querySelectorAll('[data-fail]')].map(e => getComputedStyle(e).opacity),
    trace: document.querySelector('[data-section=band] [role=list]')?.getAttribute('aria-label'),
  }));
  check(op.off.length > 0 && op.off.every(o => o === '0.32'), `off-path hosts at .32 (${op.off})`);
  check(op.fail.length > 0 && op.fail.every(o => o === '1'), `a failing chip never dims (${op.fail})`);
  check(/^Path to /.test(op.trace ?? ''), `the trace draws to the failing UI (${op.trace})`);
}
await di.getByRole('button', { name: /^Full map/ }).click(); await di.waitForTimeout(400); await shot(di, 'd-incident-fullmap');
await di.getByRole('tab', { name: 'Health' }).click(); await di.waitForTimeout(300); await shot(di, 'd-incident-health');

// ---- ?overview=classic: today's Overview before Phase 5, with its map and side panel
const dc = await page(D, '?overview=classic'); await shot(dc, 'd-classic');
{ const s = await shape(dc); check(s.shape === null && s.map, 'classic: no Phase 5 shape, the map is there'); }
await dc.getByRole('button', { name: GUEST, exact: true }).click(); await dc.waitForTimeout(300); await shot(dc, 'd-sel-guest', false);
await dc.getByRole('button', { name: `${HOST2} details` }).click(); await dc.waitForTimeout(300); await shot(dc, 'd-sel-host', false);
const dci = await page(D, '?overview=classic&simulateIncident=1'); await dci.waitForTimeout(SETTLE); await shot(dci, 'd-classic-incident');
await dci.getByRole('button', { name: INC_GUEST, exact: true }).click(); await dci.waitForTimeout(300); await shot(dci, 'd-incident-sel-guest', false);

// ---- the desktop composition at its smallest (zoom 0.8), both states, and on a big screen (scaled up to fill 1920)
for (const [name, q] of [['d-1152', ''], ['d-1152-incident', '?simulateIncident=1']]) { const p = await page({ viewport: { width: 1152, height: 1000 } }, q); await p.waitForTimeout(SETTLE); await shot(p, name); }
{ const p = await page({ viewport: { width: 1920, height: 1000 } }, '?simulateIncident=1'); await p.waitForTimeout(SETTLE); await shot(p, 'd-1920', false); }

// ---- recovery (3d): the same page, its stream switched to the healthy data, replays the path in green
{
  const p = watch(await b.newPage(D));
  // the page's EventSource, so the script can drop it (offline emulation leaves an open stream alone); the page then
  // reconnects as it would after any outage, to a stream that no longer simulates the incident
  await p.addInitScript(() => { const O = window.EventSource; window.__es = []; window.EventSource = class extends O { constructor(...a) { super(...a); window.__es.push(this); } }; });
  await p.goto(`${BASE}/?simulateIncident=1`); await p.waitForSelector('[data-section=band]'); await p.waitForTimeout(SETTLE);
  await p.route('**/api/stream?simulateIncident=1', r => r.continue({ url: `${BASE}/api/stream` }));
  await p.evaluate(() => window.__es.forEach(e => e.close()));
  const back = await p.waitForSelector('[data-section=recovered]', { timeout: 15000 }).then(() => true, () => false);
  if (back) { await p.waitForTimeout(1600); await shot(p, 'd-recovered', false); } else errors.push('recovery: no green replay after the incident cleared');
  await p.close();
}

// ---- phone (390): the five tabs; the incident hero
const mopts = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const m = await page(mopts);
await shot(m, 'm-Overview');
// the phone's five tabs; Devices opens from Health's 'LAN devices' row
for (const t of ['Health', 'Open', 'Media', 'House']) { await m.getByRole('tab', { name: t }).tap(); await m.waitForTimeout(300); await shot(m, `m-${t}`); }
await m.getByRole('tab', { name: 'Health' }).tap(); await m.getByRole('button', { name: /^LAN devices/ }).tap(); await m.waitForTimeout(300); await shot(m, 'm-Devices');
await m.getByRole('tab', { name: 'Overview' }).tap();
await m.getByRole('button', { name: new RegExp(INC_GUEST) }).first().tap(); await m.waitForTimeout(300); await shot(m, 'm-guest');
await m.getByRole('button', { name: new RegExp(HOST1) }).first().tap();
await m.getByRole('button', { name: 'Search and launch' }).tap(); await m.waitForTimeout(300); await shot(m, 'm-open-search', false);
const mi = await page(mopts, '?simulateIncident=1'); await shot(mi, 'm-incident', false); await shot(mi, 'm-incident-full');
check(await mi.evaluate(() => !!document.querySelector('[data-hero=incident]')), 'phone incident: the hero is the incident');
for (const t of ['Health', 'Open']) { await mi.getByRole('tab', { name: t }).tap(); await mi.waitForTimeout(300); await shot(mi, `m-incident-${t}`); }
const mc = await page(mopts, '?overview=classic&simulateIncident=1'); await shot(mc, 'm-classic-incident', false);
check(await mc.evaluate(() => !document.querySelector('[data-hero=incident]')), 'phone classic: today\'s hero');
// tablets: portrait (and anything under 1152) gets the phone layout, a wide landscape one the desktop scaled to fit
const tp = await page({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true }); await shot(tp, 't-820', false);
const tl = await page({ viewport: { width: 1180, height: 820 } }); await shot(tl, 't-1180', false);
await b.close();
console.log(errors.length ? `errors:\n${errors.join('\n')}` : 'no console errors, every check passed');
process.exit(errors.length ? 1 : 0);
