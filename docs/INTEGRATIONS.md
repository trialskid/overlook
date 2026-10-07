# Integrations

Every integration is a **module**. A module is on when its key is in `.env` and `homelab.json` describes something for it, or when you list it in `homelab.json` `modules`. A listed module without its key reads "not connected · needs X" on the page. A module that's off is never polled and its sections are hidden. Health › Sources lists every source with its last answer and any error.

Every key should be **read-only**. Overlook only reads (GET), and no key ever reaches the browser.

| Module | `.env` | Needs |
|---|---|---|
| `proxmox` | `PVE_<HOST ID>_TOKEN_ID`, `PVE_<HOST ID>_TOKEN_SECRET` per node | An API token with the **PVEAuditor** role on `/`. Hosts of `type: proxmox` with `api` and `pveNode`. The node's self-signed certificate is accepted. |
| `prometheus` | `PROMETHEUS_URL` | Hosts' `nodeJob`, guests' `cadvisor` jobs, your `jobs`. Overlook reads `/api/v1/query`, `query_range`, `targets` and `scrape_pools`. |
| `network` | (Prometheus) | snmp_exporter jobs for the gateway and switch (`network.gateway.snmpJob`, `network.switch.snmpJob`): `up`, `ifOperStatus`, `ifHCInOctets`, `ifHCOutOctets`. |
| `kuma` | `KUMA_URL`, `KUMA_API_KEY` | Uptime Kuma 2 (`monitor_id` labels), an API key from Settings → API Keys. Monitors are matched to web UIs by URL host and port, to apps by `apps[].kuma`, or by `kumaAliases`. |
| `grafana` | `GRAFANA_URL`, `GRAFANA_TOKEN` | A service account with the **Viewer** role. Firing, unsilenced alerts from its Alertmanager API. |
| `ntfy` | `NTFY_URL`, `NTFY_TOKEN`, `NTFY_TOPICS` | Health needs no auth; the activity feed needs a read-only user's token (`ntfy access <user> <topic> ro`) and the topics, comma-separated. |
| `probes` | (none; `PROBES=off` to stop) | `publicEndpoints`. GETs from inside your network every 5 min. |
| `plex` | `TAUTULLI_URL`, `TAUTULLI_KEY`; `PLEX_URL`, `PLEX_TOKEN` | Tautulli for now playing, libraries and recently added; Plex's own token for its remote-access check. Either is enough. |
| `sonarr`, `radarr` | (Prometheus) | [exportarr](https://github.com/onedr0p/exportarr): `sonarr_series_total`, `sonarr_episode_missing_total`, `sonarr_queue_total`, `radarr_movie_total`, `radarr_movie_missing_total`, `radarr_movie_wanted_total`, `radarr_queue_total`. |
| `qbittorrent`, `nzbget` | (Prometheus) | A qBittorrent exporter (`qbittorrent_up`, `qbittorrent_connected`, `qbittorrent_firewalled`, `qbittorrent_torrents_count`, `qbittorrent_dl_info_data_total`, `qbittorrent_up_info_data_total`) and an NZBGet exporter (`nzbget_quota_day_bytes`, `nzbget_queue_remaining_bytes`, `nzbget_download_paused`, `nzbget_downloaded_total_bytes`). Job names: `prometheus.jobs.qbittorrent` / `.nzbget`. |
| `bazarr`, `seerr`, `prowlarr`, `chaptarr`, `immich` | `<APP>_URL`, `<APP>_KEY` | Each app's own API key. |
| `wud` | `WUD_URL`, `WUD_USER`, `WUD_PASSWORD` | What's Up Docker, a login that can read `/api/containers`. |
| `homeassistant` | (Prometheus) | Home Assistant's [Prometheus integration](https://www.home-assistant.io/integrations/prometheus/), scraped as `prometheus.jobs.homeassistant` (default `homeassistant`), and a `homeAssistant` section naming the entities. Display only: nothing calls a service. |
| `ups` | (Prometheus) | `apcupsd_*` from [contrib/collectors/apcupsd-textfile-collector](../contrib/collectors). `ups.host` names the host it runs on. |
| `unraid` | (Prometheus) | A host of `type: unraid` with a `nodeJob` (array and cache fill from node_exporter), plus `unraid_*` from [contrib/collectors/unraid-health.sh](../contrib/collectors) for the array, parity and disk health. |
| `apt` | (Prometheus) | `apt_*` from [contrib/collectors/apt-textfile](../contrib/collectors) on each host (only targets that also export `apt_collector_info` count). |
| `edge` | (Prometheus) | cloudflared (`cloudflared_tunnel_ha_connections`, `cloudflared_tunnel_server_locations`, `build_info`), Caddy (`caddy_config_last_reload_successful`, `…_timestamp_seconds`) and ntfy (`ntfy_messages_published_success`, `…_failure`, `ntfy_http_requests_total`) scrape jobs, named in `prometheus.jobs`. |
| `checks` | (Prometheus) | `checks` in homelab.json. |
| `spotlight` | (Prometheus) | `spotlight` in homelab.json. |
| `devices` | `DEVICES_FILE` (default `/app/inbox/devices.json`) | A file your own job writes (below). |
| `weather` | (none; `WEATHER=off` to stop) | `location` in homelab.json. Open-Meteo, no key. |

`ups`, `apt` and `edge` are opt-in: list them in `modules` (they are never inferred).

## Replacing a query

Each built-in query of the `ups`, `unraid`, `apt` and `edge` modules has a key. `prometheus.queries` replaces one by that key, so a lab with another exporter can map its own metrics:

```jsonc
"prometheus": { "queries": { "upsCharge": "max(nut_battery_charge)", "upsLeft": "max(nut_battery_runtime_seconds)" } }
```

| Module | Keys |
|---|---|
| `ups` | `upsUp` `upsFresh` `upsAge` `upsCharge` `upsLeft` `upsLeftAvg` `upsLoad` `upsLine` `upsOnBatt` `upsNomW` `upsNomV` `upsXferLo` `upsXferHi` `upsShutCharge` `upsShutLeft` `upsShutOnBatt` `upsTransfers` `upsLastOn` `upsLastOff` `upsStart` `upsCollOk` `upsCollRun` `upsCollOkAt`; labelled: `upsInfo` `upsStatus` `upsFlag` `upsTransfer` |
| `unraid` | `urOk` `urRun` `urStarted` `urMaint` `urMounted` `urUnmountable` `urMover` `parRunning` `parPaused` `parProgress` `parSpeed` `parLastStart` `parLastEnd` `parLastDur` `parLastErr` `parLastExit`; labelled: `urState` `parAction` `dStatus` `dOk` `dTemp` `dErr` `dSpun` `dFs` `dFail` `dPast` `dRealloc` `dPend` `dOffl` `dCrc` `dUnc` `dPoh` `dGrowR` `dGrowU` `dGrowC` |
| `apt` | labelled (per job, instance, host): `aptInfo` `aptPending` `aptHeld` `aptSec` `aptSecSince` `aptReboot` `aptRebootSince` `aptKernel` `aptOk` `aptRun` `aptCache` |
| `edge` | `ntfyUp` `ntfyOk24` `ntfyRejHttp24` `ntfyRejFail24` `ntfyRejHttp30` `ntfyRejFail30` `caddyUp` `caddyReload` `caddyReloadAt`; labelled: `tunUp` `tunConns` `tunLoc` `tunBuild` |

The defaults are in `server/adapters/prom-ops.ts`.

## devices.json

The `devices` module reads a JSON file that your own job writes every few minutes, from your router's API, an ARP scan, or whatever knows your LAN. A file older than 20 min counts as stale.

```json
{
  "at": 1760000000000,
  "source": "router",
  "devices": [
    { "mac": "02:00:5E:00:00:01", "ip": "10.20.0.150", "name": "alex-phone", "vendor": "Apple, Inc.", "type": "phone",
      "network": "LAN", "lastActive": 1759999900000, "firstSeen": 1750000000000 }
  ]
}
```

Times are epoch ms (or seconds). `network` files a device on a segment by name or id; without one, its IP decides (`segments[].prefix`). Devices active in the last 30 min are online. Infra and smart-home rows come from homelab.json and are matched by IP.
