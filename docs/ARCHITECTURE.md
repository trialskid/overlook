# Architecture

```
sources ──► adapters ──► Hub ──► derive() ──► Snapshot ──► SSE ──► page
 (APIs,      one per      fresh     pure       every 10 s    (hello, snapshot
 Prometheus) source       parts    function    + Tick 1/s     when changed, tick)
```

- **Adapters** (`server/adapters/`) poll one source each on their own interval, and return their slice of `Raw` (`server/raw.ts`). An adapter that isn't configured is "not connected"; one that throws is "error". Neither ever crashes the server. Each adapter serves one or more modules (`server/modules.ts`); one whose modules are all off is never polled.
- **The Hub** (`server/hub.ts`) keeps each adapter's last good part and when it arrived, and composes `Raw` from the fresh parts only.
- **derive()** (`server/derive.ts`, `server/derive/`) is a pure function from `Raw`, the sources' states and `homelab.json` to the `Snapshot` (`shared/types.ts`): hosts, guests, web UIs, the network, Needs attention, the status line, Health's sections, Media and House. The same code runs on live and mock data, so `?simulateIncident=1` exercises the real failure path.
- **The page** (`src/`) renders the Snapshot and the 1 s `Tick` (CPU, WAN and download rates). It keeps no state about the lab of its own.

## Rules

1. **Nothing old is shown as current.** Each adapter has a max age (default `max(3 × every, 90 s)`). Past it, its data drops out before derive() runs: widgets read "—" or "not answering", and the source is named in Health › Sources and Needs attention. Ages are sent as times and turned into "3 h ago" at derive time. On the page, a second without a tick leaves a gap in the sparklines. No tick for 5 s, or no confirmed snapshot for 25 s, puts a "nothing new since hh:mm" banner over a greyed page.
2. **Adapters own their slices.** Two adapters never write the same `Raw` key, except the record-shaped `MERGE_KEYS`, where each writes its own entries.
3. **The status line reflects every signal**, in three tiers. **Red:** something is down (a web UI, host, guest, public reachability, the WAN link, a critical job, a critical Grafana alert, a smoke alarm). **Amber:** something needs a look (a stale source, a failed or old backup, a disk past its threshold, a check past warn). **Info:** a note that never changes the status line. Thresholds are in `shared/rules.ts` and `attentionRules`.
4. **Live over hand-typed.** The guest list comes from Proxmox (homelab.json only adds to it). Versions, capacities and container counts are live. What no source can read is shown as "manual · as of <date>".
5. **Read-only, display-only.** Adapters only GET. Home Assistant is shown, never controlled. The only write is the bookmarks editor's `PUT /api/links`, into `DATA_DIR/links.json`.
6. **Never crash on bad data.** A rebuild that throws keeps the last snapshot serving. A reloaded homelab.json is dry-run through derive() on empty and mock data before it replaces the old one.
7. **Explain once.** One cause, one item: a host that's down explains its guests, a reverse proxy that's down explains the web UIs behind it, a tunnel that's down explains its endpoints, and a firing Grafana alert that says the same as an item folds into it.

## Files

| | |
|---|---|
| `server/index.ts` | HTTP routes, SSE, ring buffers, the rebuild loop |
| `server/config.ts` | homelab.json: defaults, validation, hot reload |
| `server/modules.ts` | modules: which are on, which adapters serve them, the Raw keys they own |
| `server/derive/` | jobs, Kuma mapping, attention, devices, checks, ops (ups, unraid, apt, edge) |
| `server/incident.ts` | `?simulateIncident=1` |
| `server/adapters/mock.ts` | mock data shaped from the config (`MOCK=1`, `npm run demo`) |
| `shared/types.ts` | the config, Snapshot and Tick shapes |
| `shared/ui.ts` | product names, aliases, monograms and Open's default groups |
| `src/desktop/`, `src/mobile/` | the desktop and phone layouts |
| `src/map/layout.ts` | the network map's geometry, from the hosts and the chain |
| `src/lib/incident.ts` | the failure path and the Overview's shape (calm or incident) |
