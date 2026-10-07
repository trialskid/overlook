# homelab.json

Everything Overlook knows about your lab that it can't read from a source. Start from `config/example.homelab.json` (the fictional Acme Lab). The file is re-read within 30 s of a change. A file that doesn't parse, misses a required key, or would make the page fail to build keeps the old config, and the log says why.

Path: `config/homelab.json`, or `HOMELAB_CONFIG`. In the container it is `/config/homelab.json`; mount the folder, not the file.

**Required:** `domain`, `network.subnet` and `hosts`. Everything else has a default (an empty list, or off).

LAN addresses can be written short: `.42` means the address on `network.subnet` (`10.20.0.42`), and the page shows them that way too.

## The lab

| Key | What |
|---|---|
| `domain` | Your lab's domain, e.g. `lab.example.com`. Used by the `uiUrl` template and to recognise your own certificates. |
| `timezone` | IANA zone for clock times, e.g. `Europe/London`. Default: `TZ`, else the system's. |
| `location` | `{ name, lat, lon }` for the weather (module `weather`). Leave it out for no weather. |
| `modules` | The integrations this lab has, e.g. `["proxmox", "prometheus", "kuma"]`. When present it is authoritative: a module listed without its key shows "not connected · needs X", and one not listed is hidden. When absent, a module is on when its `.env` key is set and this file describes something for it. See [INTEGRATIONS.md](INTEGRATIONS.md). |

## Hosts, guests, apps

```jsonc
"hosts": [
  { "id": "pve1", "name": "pve1", "type": "proxmox", "ip": "10.20.0.10", "port": "p1", "hardware": "Ryzen 7 · 64 GB",
    "api": "https://10.20.0.10:8006", "pveNode": "pve1", "nodeJob": "node-pve1" },
  { "id": "nas", "name": "NAS", "type": "unraid", "ip": "10.20.0.30", "hardware": "i5-12400 · 32 GB", "nodeJob": "node-nas" }
]
```

| Host key | What |
|---|---|
| `id`, `name` | Its id (used everywhere else in this file) and display name. `short`: a shorter name for tight spots. |
| `type` | `proxmox`, `unraid` or `mac`. Proxmox hosts are read through their API; any host with a `nodeJob` gets its resources from node_exporter. A `mac` host is probed on TCP 22 (`MAC_PROBE_PORT`). |
| `ip`, `port` | Its address, and the switch port it's on (shown on the map). `portLabel` replaces the port's text. `altIp`: a second address (e.g. a storage link). |
| `hardware` | Free text, shown on its details. |
| `api`, `pveNode`, `tokenEnv` | Proxmox: the API URL, the node name, and the env prefix of its token (default `PVE_<ID>`, so `PVE_PVE1_TOKEN_ID` / `_SECRET`). |
| `nodeJob` | Its node_exporter scrape job: CPU sparkline, memory, load, uptime. |
| `cpuScale` | The CPU sparkline's least full scale in % (default 40). |

`guests` add what Proxmox can't say about a VM or LXC (the guest list itself is live from Proxmox): `{ host, vmid, name, kind: "vm" | "lxc", ip, desc?, services: [...], devices?: [...], cadvisor?, expectRunning? }`. `services` is what runs in it (it decides "where" texts like "web · reverse proxy"). `cadvisor` is its cAdvisor scrape job, for the container count.

`apps` are services that aren't a web UI of their own (containers on a NAS, public apps): `{ name, label, host, url?, publicUrl?, kuma?: [monitor ids], jobs?: [job ids], critical?, note?, onDemand? }`. A `critical` app that's down is red rather than amber. `onDemand`: started by hand when needed, so it isn't drawn on the map. `jobs`: for an app no monitor or probe can see (a sync container), the [jobs](#jobs) whose status is its status; the job's own item reports a failure.

## Web UIs and links

| Key | What |
|---|---|
| `webUis` | `{ "sonarr": ".41:8989", ... }`: each web UI's LAN address. The name is the key everything else uses (groups, labels, Kuma matching). |
| `uiUrl` | How a web UI's link is written: `{name}`, `{domain}`, `{ip}`, `{port}`. Default `http://{ip}:{port}`. Behind a reverse proxy with a wildcard name: `https://{name}.{domain}`. |
| `uiUrls` | A full URL for a web UI the template doesn't fit, e.g. `{ "pve1": "https://10.20.0.10:8006" }`. |
| `uiPaths` | Where the app lives when it isn't `/`, e.g. `{ "plex": "/web/index.html" }`. |
| `uiLabels` | Display names, e.g. `{ "git": "Gitea" }`. |
| `reverseProxy` | `{ "name": "Caddy" }`: when its Kuma monitor (`kumaAliases` → `infra:caddy`) is down, one item explains the web UIs behind it instead of one item each. |
| `kumaAliases` | `{ "25": "infra:caddy" }`: Kuma monitors the URL matcher can't place (a port or keyword monitor), by monitor id. Values: a web UI name, `app:<name>` or `infra:<anything>`. |
| `links` | Bookmarks: `{ "Group": [["Name", "example.com"], ...] }`. Only the seed: once you save from the page ("Edit links"), `DATA_DIR/links.json` wins. |

## Network

```jsonc
"network": {
  "subnet": "10.20.0.0/24",
  "gateway": { "id": "router", "name": "OPNsense", "ip": "10.20.0.1", "snmpJob": "snmp-router", "wanIf": "igc0" },
  "switch": { "id": "switch", "name": "Core switch", "ip": "10.20.0.2", "snmpJob": "snmp-switch", "firmware": "2.1.0", "eol": false },
  "accessPoints": [{ "name": "AP Office", "ip": "10.20.0.21", "port": "p6", "model": "Wi-Fi 6 AP" }],
  "segments": [{ "id": "guest", "name": "Guest Wi-Fi", "prefix": "10.30.0", "gatewayIf": "igc2" }],
  "tunnel": "Cloudflare tunnel",
  "deviceCount": { "query": "max(ntopng_interface_num_devices)", "source": "ntopng" }
}
```

An access point's `short` replaces its `model` in the map's segment label (the Devices tab keeps the full model).

The gateway and the switch are optional. Without them the map draws a plain trunk where they would be. With an `snmpJob` (snmp_exporter), the gateway reads as answering or not, its `wanIf` gives the WAN link and the 1 s WAN rate, the switch's port states give each access point's state, and a segment's `gatewayIf` gives that segment's. `tunnel` names the pill beside the Internet one (what carries your public endpoints).

## Public endpoints

`publicEndpoints`: everything the internet can reach. Overlook GETs each `host` every 5 min from inside your network.

| Key | What |
|---|---|
| `name`, `host`, `origin` | What it is, its public host name, and what's behind it ("Seerr · media :5055"). |
| `via` | `tunnel`, `port-forward` (not probed: no safe GET; shown as configured) or `direct`. `tunnelJob`: the cloudflared job of the tunnel that carries it, when it isn't the main one (it then doesn't count toward "the tunnel is down"). |
| `expect` | HTTP codes that mean healthy, e.g. `[200, 301, 302]`, or `[401]` behind an access gate. `path`: what to GET (default `/`). |
| `app`, `critical`, `access` | The app it serves; red rather than amber when unreachable; an access gate's name for the row. |
| `probe`, `check` | `probe: false` to skip probing; `check: "plex"` reads Plex's own remote-access state instead. |

`retiredHosts`: names that used to be public. One that still answers is shown as an orphan.

## Jobs

`jobs`: every scheduled job you want watched, backups and automation alike.

```jsonc
{ "id": "kopia", "name": "Kopia off-site", "group": "backup", "where": "NAS → off-site", "schedule": "daily 05:00",
  "maxAgeH": 30, "signal": "prometheus", "last": "kopia_snapshot_last_success_timestamp_seconds" }
```

| Key | What |
|---|---|
| `group` | `backup` or `automation` (Health's two sections). |
| `maxAgeH` | Older than this is overdue (amber; red for a `critical` job). |
| `signal` | `prometheus` (`last`: PromQL for the last success's epoch seconds; `ok`: 1/0 for the last run; `by`: one row per label value), `proxmox-vzdump` (`node`: the host id), `ntfy` (`topic`, `match`: a message marks a run) or `none` (listed as not monitored, with a `note`). |
| `alert` | A Grafana alertname pattern for this job's own alerts, folded into its item. |
| `family`, `short` | Jobs that share a `family` show as one line. |
| `link`, `runbook` | Where its item points. |

## Optional sections

| Key | Module | What |
|---|---|---|
| `homeAssistant` | `homeassistant` | The House tab's entities: `climate`, `climateLabel`, `humidity`, `garage`, `garageObstruction`, `garageLight`, `locks` (`entity`, `battery`, `jammed`, `door`), `lights` (`entity`, `name`, `room`), `appliances`, `moreClimates`, `smoke`, `printer`, `backup`. Only the parts you name are drawn. |
| `ups` | `ups` | `{ name?, host? }`: what to call it, and the host id whose apcupsd reports it (it is named in "X shuts down in 7 min"). |
| `apt` | `apt` | `{ window? }`: when updates get applied, said on update items ("monthly window"). |
| `edge` | `edge` | `{ mainTunnelJob? }`: the cloudflared job that carries the public endpoints (default: the first). |
| `prometheus` | | `jobs`: the scrape job names you use (`homeassistant`, `qbittorrent`, `nzbget`, `caddy`, `ntfy`, `cloudflared`). `queries`: replace any built-in query by its key. See [INTEGRATIONS.md](INTEGRATIONS.md). |
| `checks` | `checks` | Your own PromQL checks (below). |
| `spotlight` | `spotlight` | One app to keep in view (below). |
| `devices` | | Smart-home and other gear by IP: `{ name, ip, note, hue }`, matched against the device list. |
| `versions` | | `[name, version, badge, asOf]` for what no source can read (router or switch firmware), shown as "manual · as of …". |
| `attentionRules` | | Thresholds: `diskWarnPct` (85), `diskDangerPct` (95), `certWarnDays` (14), `lockBatteryWarnPct` (25), `wudUpdatesAbove` (0), `bazarrMissingSubtitlesAbove` (1000), `arrayWarnPct`, `cacheWarnPct`. |
| `mediaAlsoRunning` | | Media apps without a block, listed by name. |

### checks

```jsonc
"checks": [
  { "id": "disk-temp", "name": "Hottest disk", "query": "max(smartctl_device_temperature{temperature_type=\"current\"})",
    "warn": 50, "danger": 60, "unit": "°C", "where": "NAS · smartctl_exporter" },
  { "id": "mounts", "name": "NFS mounts", "query": "count(nfs_mount_ready == 0) or vector(0)", "warn": 0,
    "detail": "{value} not ready" }
]
```

The query returns one number. Past `warn` is amber and past `danger` red; `below: true` flips it (lower is worse). Each check is a row under Health › Alerting, and past a threshold it raises a Needs attention item (`detail`, with `{value}`; `link` for its action). No series reads "no data" and raises nothing. `job`: a [job](#jobs) behind the check (a watchdog's own runs): the row takes the worse of the two tones and the job moves out of Automation.

### spotlight

```jsonc
"spotlight": {
  "app": "Nextcloud",
  "signals": [{ "name": "Database", "query": "nextcloud_db_up", "role": "other" }],
  "probeQuery": "nextcloud_probe_last_run_timestamp_seconds",
  "backupJob": "nextcloud-dump", "restoreJob": "nextcloud-restore-test"
}
```

A block on the Overview for the one app you care most about (an app from `apps`). It shows LAN and Public (from Kuma and the public probe) plus its own signals. A signal is a 1/0 query, and its `role` (`lan`, `public` or `other`) says which path it speaks for. A signal counts as down only once it stays 0 for 150 s; a shorter dip shows amber and raises nothing. A bare metric selector (`metric` or `metric{…}`) gets an exact 150 s window; any other expression is sampled every 15 s. With a `probeQuery`, signals older than 3 min no longer count.

## The page (`ui`)

| Key | What |
|---|---|
| `title`, `brand` | The page and login title (default "Overlook"), and the name on the header's second line (default `domain`). |
| `launcher.groups` | Open's groups in order: `[["Media", ["plex", "seerr"]], ...]`. Default: groups by product. |
| `launcher.columns` | Open's columns, each a list of group titles stacked top to bottom. |
| `launcher.hidden` | Names left out of Open (still found by search), e.g. `["overlook"]`. |
| `launcher.phonePins` | The phone incident view's eight shortcuts. |
| `names`, `aliases`, `monograms` | Display names, extra search words, and two-letter tiles, by web UI or app name. |
| `openHosts` | Hosts unfolded on the phone's network list at first. |
