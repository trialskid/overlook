// ⌘K / Ctrl+K palette: indexes tabs, hosts, guests, web UIs, apps (with their public URLs), public
// endpoints, links, devices, jobs and the network gear. Matches name, label, services, domain and
// a few aliases; every word of the query must match. ↑/↓ move, ↵ runs, esc closes. A modal dialog: Tab stays
// inside it, ↵ on a focused button presses that button, and closing hands focus back to whatever opened it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { classicOverview, useApp, type MTab, type Tab, type UiState } from './state.tsx';
import { on, visibleMTabs, visibleTabs } from './lib/modules.ts';
import { GUEST_HUE, fullIp, hueOf, monoOf, tint } from './lib/util.ts';
import { SearchIcon, mono } from './lib/ui.tsx';
import { aliasOf, matches, serviceOf, shortUrl } from './lib/search.ts';
import { MOBILE_MAX } from './App.tsx';

type Kind = 'TAB' | 'HOST' | 'GUEST' | 'WEB UI' | 'APP' | 'PUBLIC' | 'LINK' | 'DEVICE' | 'JOB' | 'NETWORK';
interface Item { key: string; name: string; meta: string; kind: Kind; mono: string; hue: number; hay: string; run: () => void }
const KIND_RANK: Record<Kind, number> = { HOST: 0, GUEST: 1, 'WEB UI': 2, APP: 3, PUBLIC: 4, NETWORK: 5, JOB: 6, DEVICE: 7, LINK: 8, TAB: 9 };

export function CommandPalette() {
  const { snap, set } = useApp();
  const [q, setQ] = useState('');
  const [ci, setCi] = useState(0);
  const dialog = useRef<HTMLDivElement>(null);
  // the element that opened the palette (a 'Search everything' button, or wherever ⌘K was pressed) gets focus back
  // on close; read during the first render, before the input's autoFocus takes it
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const close = () => { set({ cmdOpen: false }); if (opener?.isConnected) opener.focus(); };

  const all = useMemo<Item[]>(() => {
    const mobile = innerWidth < MOBILE_MAX;
    const go = (p: Partial<UiState> | ((s: UiState) => Partial<UiState>), anchor?: string) => () => {
      set(s => ({ cmdOpen: false, ...(typeof p === 'function' ? p(s) : p) }));
      // after the tab renders, bring the row into view
      if (anchor) setTimeout(() => document.getElementById(anchor)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    };
    const tab = (t: Tab, anchor?: string) => go({ dTab: t, mTab: t, mScreen: 'home', selection: null }, anchor);
    // review Phase 5: on the desktop Overview a host or guest shows on the full map, opened in place (classic: the map is always there)
    const onMap = !mobile && !classicOverview();
    const openUrl = (u: string) => () => { open(u, '_blank', 'noopener'); set({ cmdOpen: false }); };
    const item = (i: Omit<Item, 'hay'>, extra = '') => ({ ...i, hay: `${i.name} ${i.meta} ${extra} ${aliasOf(i.name)}`.toLowerCase() });
    const appHosts = new Set(snap.apps.flatMap(a => [a.url, a.publicUrl].filter((u): u is string => !!u).map(u => shortUrl(u))));
    return [
      // the phone has its own tabs (Open; Devices under Health)
      ...((mobile ? [...visibleMTabs(snap), 'Devices'] : visibleTabs(snap)) as readonly MTab[]).map(t => item({ key: `tab-${t}`, name: `Go to ${t}`, meta: 'tab', kind: 'TAB', mono: '→', hue: 220,
        run: t === 'Open' || t === 'Devices' ? go({ mTab: t, mScreen: 'home', selection: null }) : tab(t) }, t === 'House' ? 'home' : '')),
      // review Phase 5: the former Links and Devices tabs, where they live now on the desktop
      ...(mobile ? [] : [
        item({ key: 'tab-devices', name: 'Devices', meta: 'Health · LAN, infra and smart home', kind: 'TAB', mono: '→', hue: 220, run: tab('Health', 'health-devices') }, 'devices lan router'),
        ...(classicOverview() ? [] : [item({ key: 'tab-bookmarks', name: 'Bookmarks', meta: 'Overview · links, edit', kind: 'TAB', mono: '→', hue: 220, run: tab('Overview', 'overview-bookmarks') }, 'links')]),
      ]),
      ...snap.hosts.map(h => item({ key: `host-${h.id}`, name: h.name, meta: `${h.ip} · ${h.os}`, kind: 'HOST', mono: h.mono, hue: h.hue,
        run: go(s => ({ dTab: 'Overview', mTab: 'Overview', mScreen: 'home', selection: { kind: 'host', id: h.id }, openHosts: mobile ? new Set([...s.openHosts, h.id]) : s.openHosts, ...(onMap ? { mapOpen: true } : {}) }), onMap ? 'overview-map' : undefined) },
      `${h.id} ${h.hw} ${h.leaves.map(l => l.name).join(' ')} ${aliasOf(h.id)}`)),
      ...snap.guests.map(g => item({ key: `guest-${g.host}-${g.vmid}`, name: g.name, meta: `${g.kind === 'vm' ? 'VM' : 'LXC'} ${g.vmid} · ${g.ip ? fullIp(g.ip) : 'no IP'}`, kind: 'GUEST', mono: String(g.vmid), hue: GUEST_HUE[g.kind],
        run: go({ dTab: 'Overview', mTab: 'Overview', selection: { kind: 'guest', id: g.id }, mScreen: mobile ? 'guest' : 'home', mobileGuestId: g.id, ...(onMap ? { mapOpen: true } : {}) }, onMap ? 'overview-map' : undefined) },
      `${g.services.join(' ')} ${g.devices.join(' ')} ${g.type}`)),
      ...snap.uis.map(u => { const url = u.url; return item({ key: `ui-${u.name}`, name: shortUrl(url), meta: [serviceOf(snap, u), u.target].filter(Boolean).join(' · '), kind: 'WEB UI', mono: u.name.slice(0, 2).toUpperCase(), hue: hueOf(u.name), run: openUrl(url) }, `${u.name} ${aliasOf(u.name)}`); }),
      ...snap.apps.flatMap(a => [a.url && { url: a.url, pub: false }, a.publicUrl && { url: a.publicUrl, pub: true }].filter((x): x is { url: string; pub: boolean } => !!x).map(x =>
        item({ key: `app-${a.name}-${x.pub ? 'pub' : 'lan'}`, name: x.pub ? `${a.label} (public)` : a.label, meta: `${shortUrl(x.url)}${a.note ? ` · ${a.note}` : ''}`, kind: 'APP', mono: monoOf(a.label), hue: hueOf(a.name), run: openUrl(x.url) }, `${a.name} ${aliasOf(a.name)}`))),
      ...snap.health.exposure.filter(x => x.via !== 'port-forward' && !appHosts.has(x.host)).map(x =>
        item({ key: `pub-${x.host}`, name: x.host, meta: `${x.name} · ${x.origin}${x.access ? ` · ${x.access}` : ''}`, kind: 'PUBLIC', mono: monoOf(x.name), hue: 25, run: openUrl(x.url) }, `${x.via} public internet`)),
      ...snap.links.flatMap(g => g.items.map((l, i) => item({ key: `link-${g.group}-${i}`, name: l.name, meta: `${l.domain} · ${g.group}`, kind: 'LINK', mono: monoOf(l.name), hue: hueOf(l.name, 41), run: openUrl(l.url) }, l.url))),
      // Devices rows (Health › Devices; the infra ones are already here as hosts, guests and network gear); a segment's row unfolds its list
      ...snap.devices.groups.filter(g => g.id !== 'infra').flatMap(g => g.rows.map(r => item({
        key: `dev-${g.id}-${r.key}`, name: r.name, meta: [g.title, r.ip, r.sub].filter(Boolean).join(' · '), kind: 'DEVICE', mono: monoOf(r.name.replace(/[^A-Za-z]/g, '')) || '··', hue: hueOf(r.name),
        // its list unfolded first (a segment's, and Other LAN that folds to its offline rows), so the row is there to scroll to
        run: go({ dTab: 'Health', mTab: 'Devices', mScreen: 'home', selection: null, deviceQuery: '', ...(g.id.startsWith('seg:') ? { segOpen: [g.id] } : g.id === 'lan' ? { lanOpen: true } : {}) }, `dev-${r.key}`),
      }, `${r.vendor} ${r.mac} devices`))),
      ...(on(snap, 'homeassistant') ? snap.home.locks : []).map(l => item({ key: `lock-${l.name}`, name: l.name, meta: `lock · ${l.state}`, kind: 'DEVICE', mono: 'LK', hue: 40, run: tab('House', 'home-locks') }, 'locks doors')),
      ...snap.health.jobs.map(j => item({ key: `job-${j.id}`, name: j.name, meta: `${j.group} · ${j.where} · ${j.lastAgo}`, kind: 'JOB', mono: j.group === 'backup' ? 'BK' : 'AU', hue: j.group === 'backup' ? 150 : 200, run: tab('Health', `job-${j.id}`) }, `${j.schedule} ${j.detail}`)),
      ...snap.health.unmonitored.map((j, i) => item({ key: `jobx-${i}`, name: j.name, meta: `not monitored · ${j.where}`, kind: 'JOB', mono: 'BK', hue: 0, run: tab('Health', 'health-unmonitored') }, j.note)),
      ...(snap.network.gateway ? [item({ key: 'net-fw', name: snap.network.gateway.name, meta: `${snap.network.gateway.ipShort} · router, firewall`, kind: 'NETWORK', mono: 'GW', hue: 0, run: tab('Overview') }, 'gateway router firewall wan internet')] : []),
      ...(snap.network.switch ? [item({ key: 'net-sw', name: snap.network.switch.name, meta: [snap.network.switch.ipShort, 'switch', snap.network.switch.firmware && `firmware ${snap.network.switch.firmware}`].filter(Boolean).join(' · '), kind: 'NETWORK', mono: 'SW', hue: 230, run: tab('Overview') }, 'switch ports')] : []),
      ...(snap.network.switch ? snap.network.aps : []).map((a, i) => item({ key: `net-ap-${i}`, name: a.name, meta: `access point · ${a.port}`, kind: 'NETWORK', mono: 'AP', hue: 190, run: tab('Overview') }, 'wifi')),
      item({ key: 'health-sources', name: 'Sources', meta: 'Health · every adapter, its age and errors', kind: 'TAB', mono: '→', hue: 220, run: tab('Health', 'health-sources') }, 'adapters stale errors'),
      ...(on(snap, 'grafana') ? [item({ key: 'health-alerts', name: 'Grafana alerts', meta: 'Health · firing alerts', kind: 'TAB', mono: '→', hue: 220, run: tab('Health', 'health-alerts') })] : []),
      // plans H5-H13: only once their data exists (the sections aren't drawn before)
      ...(snap.health.ops?.power ? [item({ key: 'health-power', name: 'Power · UPS', meta: `Health · ${snap.health.ops.power.fresh ? snap.health.ops.power.state : 'stale'}`, kind: 'TAB', mono: '→', hue: 220, run: tab('Health', 'health-power') }, 'ups apcupsd battery runtime')] : []),
      ...(snap.health.ops?.disks ? [item({ key: 'health-disks', name: 'Unraid disks', meta: 'Health · array, parity, SMART', kind: 'TAB', mono: '→', hue: 220, run: tab('Health', 'health-disks') }, 'parity smart temperature array')] : []),
      ...(snap.health.ops?.edge ? [item({ key: 'health-edge', name: 'Edge', meta: 'Health · tunnels, Caddy, ntfy', kind: 'TAB', mono: '→', hue: 220, run: tab('Health', 'health-edge') }, 'cloudflared tunnel caddy ntfy')] : []),
    ];
  }, [snap, set]);

  const query = q.trim().toLowerCase();
  const res = useMemo(() => {
    if (!query) return [...all.filter(c => c.kind === 'HOST'), ...all.filter(c => c.kind === 'TAB' && c.key.startsWith('tab-'))];
    const score = (c: Item) => { const n = c.name.toLowerCase(); return n.startsWith(query) ? 0 : n.includes(query) ? 1 : 2; };
    return all.filter(c => matches(c.hay, query)).sort((a, b) => score(a) - score(b) || KIND_RANK[a.kind] - KIND_RANK[b.kind]).slice(0, 12);
  }, [all, query]);
  const active = Math.min(ci, Math.max(0, res.length - 1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setCi(i => Math.min(i + 1, Math.max(0, res.length - 1))); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setCi(i => Math.max(i - 1, 0)); }
      else if (e.key === 'Enter' && !(el instanceof HTMLButtonElement)) { e.preventDefault(); res[active]?.run(); } // a focused button gets its own click
      else if (e.key === 'Tab' && dialog.current) {
        const f = [...dialog.current.querySelectorAll<HTMLElement>('input, button')];
        if (!f.length) return;
        const i = f.indexOf(el as HTMLElement), next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1);
        e.preventDefault(); f[next].focus();
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });
  useEffect(() => { document.getElementById(`cmd-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active]);

  return (
    <div onClick={close} role="presentation" style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(8,9,12,.62)', backdropFilter: 'blur(6px)', WebkitBackdropFilter: 'blur(6px)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '12vh 16px 0' }}>
      <div ref={dialog} onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Search everything"
        style={{ width: 640, maxWidth: '100%', background: 'var(--palette)', border: '1px solid var(--rule)', borderRadius: 16, boxShadow: '0 30px 80px rgba(0,0,0,.6)', overflow: 'hidden', color: 'var(--text)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 18px', borderBottom: '1px solid var(--rule-2)' }}>
          <SearchIcon size={18} stroke="var(--mut-3)" />
          <input autoFocus value={q} onChange={e => { setQ(e.target.value); setCi(0); }} placeholder="Search hosts, apps, services, jobs, links…" aria-label="Search"
            aria-controls="cmd-list" aria-activedescendant={res.length ? `cmd-${active}` : undefined}
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 0, outline: 'none', color: 'var(--text)', font: '500 17px var(--font-ui)' }} />
          {/* the chip stays small; the button around it is a 44px touch target (phones have no esc key) */}
          <button onClick={close} aria-label="Close search" style={{ padding: 12, margin: -12, flex: 'none' }}><span style={mono(11, 'var(--mut-3)', { display: 'block', padding: '2px 6px', borderRadius: 5, background: 'var(--hover)' })}>esc</span></button>
        </div>
        <div id="cmd-list" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 420, overflowY: 'auto' }} role="listbox" aria-label="Results">
          <span style={{ padding: '6px 10px 4px', fontSize: 11, letterSpacing: '.14em', fontWeight: 700, color: 'var(--mut-3)' }}>{query ? `${res.length} RESULTS` : 'JUMP TO'}</span>
          {res.map((c, i) => (
            <button key={c.key} id={`cmd-${i}`} role="option" aria-selected={i === active} onClick={c.run} onMouseEnter={() => i !== active && setCi(i)} onFocus={() => i !== active && setCi(i)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 46, padding: '0 10px', borderRadius: 10, background: i === active ? 'var(--hover)' : 'transparent', width: '100%', boxSizing: 'border-box' }}>
              <span style={{ minWidth: 28, height: 28, padding: '0 4px', boxSizing: 'border-box', borderRadius: 8, ...tint(c.hue), display: 'grid', placeItems: 'center', fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 700, flex: 'none' }}>{c.mono}</span>
              <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.name}</span>
              <span style={mono(11, 'var(--mut-3)', { flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' })}>{c.meta}</span>
              <span style={mono(11, i === active ? 'var(--mut-1)' : 'var(--mut-3)', { letterSpacing: '.08em', flex: 'none' })}>{c.kind}</span>
            </button>
          ))}
          {!res.length && <div style={{ padding: '28px 10px', textAlign: 'center', fontSize: 13, color: 'var(--mut-3)' }}>Nothing matches “{q}”</div>}
        </div>
        <div style={{ display: 'flex', gap: 16, padding: '10px 18px', borderTop: '1px solid var(--rule-2)', fontSize: 11, color: 'var(--mut-3)' }}>
          <span>↑↓ navigate</span><span>↵ open</span><span>esc close</span><span style={{ flex: 1 }} /><span>{all.length} items indexed</span>
        </div>
      </div>
    </div>
  );
}
