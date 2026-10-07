# contrib

## collectors

Textfile collectors for node_exporter that produce the metrics the `ups`, `unraid` and `apt` modules read. Each writes one `.prom` file atomically into node_exporter's textfile directory (`--collector.textfile.directory`) and only reads what it reports on.

| File | Module | Runs on | Schedule |
|---|---|---|---|
| `apcupsd-textfile-collector` (+ `.service`, `.timer`) | `ups` | the host whose apcupsd watches the UPS (Python 3, `apcaccess`) | every minute (systemd timer) |
| `unraid-health.sh` | `unraid` | Unraid, as root (reads emhttpd's state files and SMART cache) | every 5 min (Unraid cron) |
| `apt-textfile` (+ `.service`, `.timer`) | `apt` | each Debian/Ubuntu/Proxmox host | every 15 min (systemd timer) |

`apt-textfile` runs the upstream [`apt_info.py`](https://github.com/prometheus-community/node-exporter-textfile-collector-scripts) at the commit named in its header (install it at `/usr/local/lib/apt-textfile/apt_info.py`) and adds security-update age, reboot-required age and a kernel check.

`apcupsd-textfile-collector` and `unraid-health.sh` have a `--stdout` dry run: try it before you schedule them. `apt-textfile` writes to `TEXTFILE_DIR` (`/etc/default/apt-textfile`). Read each header for its settings.
