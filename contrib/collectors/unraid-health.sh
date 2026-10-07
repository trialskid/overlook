#!/bin/bash
# unraid-health: Unraid array, disk and parity state for node_exporter's textfile collector (Overlook module unraid).
#
# Reads only (never writes to any of them):
#   /var/local/emhttp/var.ini, /var/local/emhttp/disks.ini  (emhttpd's own state files, RAM)
#   /proc/mdstat                                           (resync fields only, same source as the GUI's parity_control)
#   /var/local/emhttp/smart/<slot>                         (SMART tables emhttpd caches; this script never runs smartctl)
#
# Modes:
#   --collect  write /var/tmp/node_exporter_textfile/unraid_health.prom (temp file + mv, 0644)
#   --stdout   print the same metrics to stdout and write nothing (dry run)
#
# Pause: create /boot/config/plugins/unraid-health/DISABLED (any content).
# Schedule it every 5 minutes, e.g. /boot/config/plugins/dynamix/unraid-health.cron:
#   */5 * * * * /boot/config/plugins/unraid-health/collector.sh --collect >/dev/null 2>&1
# and point node_exporter's --collector.textfile.directory at /var/tmp/node_exporter_textfile.
set -uo pipefail
umask 022
export LC_ALL=C PATH=/usr/sbin:/usr/bin:/sbin:/bin

mode=${1:-}
case "$mode" in --collect|--stdout) ;; *) echo 'usage: collector.sh --collect|--stdout' >&2; exit 2 ;; esac
[[ $# -eq 1 && $EUID -eq 0 ]] || { echo 'unraid-health: run as root with one argument' >&2; exit 2; }

bundle=/boot/config/plugins/unraid-health
textdir=/var/tmp/node_exporter_textfile
out=$textdir/unraid_health.prom
emhttp=/var/local/emhttp
lock=/run/unraid-health.lock
marker='# unraid-health-v1'
started_ns=$(date +%s%N)
now=$(date +%s)

[[ -e $bundle/DISABLED && $mode == --collect ]] && exit 0

if [[ $mode == --collect ]]; then
  [[ -d $textdir && ! -L $textdir ]] || { echo 'unraid-health: textfile dir missing' >&2; exit 1; }
  [[ ! -L $out ]] || { echo 'unraid-health: refusing symlinked output' >&2; exit 1; }
  exec 9>"$lock"
  flock -n 9 || exit 0
fi

num() { [[ $1 =~ ^-?[0-9]+$ ]]; }
# ini_get FILE: prints "key<TAB>value" for every key=value line, quotes stripped. Never sourced or eval'd.
ini_kv() { awk '/^[A-Za-z_][A-Za-z0-9_]*=/ { k=$0; sub(/=.*/,"",k); v=substr($0,length(k)+2); gsub(/^"|"$/,"",v); print k "\t" v }' "$1"; }

M=()                       # metric lines
h() { M+=("# HELP $1 $3" "# TYPE $1 $2"); }
m() { M+=("$1 $2"); }

########## Array, disks, parity ##########
array_ok=1
declare -A V=() S=()
if [[ -r $emhttp/var.ini ]]; then
  while IFS=$'\t' read -r k v; do
    case "$k" in mdState|fsState|startMode|fsNumMounted|fsNumUnmountable|shareMoverActive|mdResync|mdResyncPos|mdResyncSize|mdResyncDt|mdResyncDb|mdResyncCorr|mdResyncAction|sbSynced|sbSynced2|sbSyncErrs|sbSyncExit) V[$k]=$v ;; esac
  done < <(ini_kv "$emhttp/var.ini")
else
  array_ok=0
fi
# Live resync fields straight from the md driver (what /usr/local/emhttp/plugins/dynamix/scripts/parity_control reads).
mdstat_ok=0
if [[ -r /proc/mdstat ]]; then
  while IFS=$'\t' read -r k v; do
    case "$k" in mdState|mdResync|mdResyncPos|mdResyncSize|mdResyncDt|mdResyncDb|mdResyncCorr|mdResyncAction|sbSynced|sbSynced2|sbSyncErrs|sbSyncExit) S[$k]=$v; mdstat_ok=1 ;; esac
  done < <(ini_kv /proc/mdstat)
fi
pick() { if [[ $mdstat_ok == 1 && -n ${S[$1]+x} ]]; then printf '%s' "${S[$1]}"; else printf '%s' "${V[$1]:-}"; fi; }

md_state=$(pick mdState)
[[ $md_state =~ ^[A-Z_]+$ ]] || array_ok=0
for k in mdResyncPos mdResyncSize mdResyncDt mdResyncDb mdResyncCorr sbSynced sbSynced2 sbSyncErrs sbSyncExit; do
  num "$(pick $k)" || array_ok=0
done
for k in fsNumMounted fsNumUnmountable; do num "${V[$k]:-}" || array_ok=0; done

# disks.ini: one TSV row per slot that is assigned (superblock id or device id) or not in an empty state.
disk_rows=()
if [[ -r $emhttp/disks.ini ]]; then
  while IFS= read -r row; do disk_rows+=("$row"); done < <(awk '
    function flush() {
      if (sec == "") return
      assigned = (f["idSb"] != "" || f["id"] != "" || f["device"] != "")
      if (assigned || (f["status"] != "DISK_NP" && f["status"] != "DISK_NP_DSBL"))
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%d\n", f["name"], f["type"], f["status"], f["temp"], f["numErrors"], f["spundown"], f["fsStatus"], f["fsType"], assigned
      delete f; sec = ""
    }
    /^\[/ { flush(); sec = $0; next }
    /^[A-Za-z_]+=/ { k=$0; sub(/=.*/,"",k); v=substr($0,length(k)+2); gsub(/^"|"$/,"",v); f[k]=v }
    END { flush() }' "$emhttp/disks.ini")
  disks_mtime=$(stat -c %Y "$emhttp/disks.ini")
else
  array_ok=0; disks_mtime=0
fi
[[ ${#disk_rows[@]} -gt 0 ]] || array_ok=0

# SMART attribute table cached by emhttpd (ATA only; NVMe health is in unraid_nvme_*).
smart_rows=()
for row in "${disk_rows[@]}"; do
  IFS=$'\t' read -r name _ <<< "$row"
  [[ $name =~ ^[A-Za-z0-9_-]+$ ]] || continue
  f=$emhttp/smart/$name
  [[ -f $f && ! -L $f && -s $f ]] || continue
  r=$(awk -v n="$name" '
    /^ID# ATTRIBUTE_NAME/ { ata=1; next }
    ata && $1 ~ /^[0-9]+$/ && NF >= 10 {
      raw=$10; sub(/[^0-9].*$/,"",raw); if (raw == "") raw=0
      a[$1]=raw; seen[$1]=1
      if ($9 == "FAILING_NOW") failing++; else if ($9 != "-") past++
    }
    END {
      if (!ata) exit 1
      printf "%s\t%d\t%s\t%s\t%s\t%s\t%s\t%s\t%d\n", n, failing+0,
        (5 in seen ? a[5] : "-"), (197 in seen ? a[197] : "-"), (198 in seen ? a[198] : "-"),
        (199 in seen ? a[199] : "-"), (187 in seen ? a[187] : "-"), (9 in seen ? a[9] : "-"), past+0
    }' "$f") || continue
  smart_rows+=("$r"$'\t'"$(stat -c %Y "$f")")
done

########## Output ##########
finished_ns=$(date +%s%N)
duration=$(awk -v a="$started_ns" -v b="$finished_ns" 'BEGIN { printf "%.3f", (b - a) / 1e9 }')

h unraid_array_collector_success gauge 'Whether var.ini, disks.ini and the md status were read and validated.'
m unraid_array_collector_success "$array_ok"
h unraid_array_collector_last_run_timestamp_seconds gauge 'Unix time of the latest run.'
m unraid_array_collector_last_run_timestamp_seconds "$now"
h unraid_health_collector_duration_seconds gauge 'Runtime of the whole unraid_health collector.'
m unraid_health_collector_duration_seconds "$duration"

if [[ $array_ok == 1 ]]; then
  pos=$(pick mdResyncPos) size=$(pick mdResyncSize) dt=$(pick mdResyncDt) db=$(pick mdResyncDb)
  s1=$(pick sbSynced) s2=$(pick sbSynced2) action=$(pick mdResyncAction)
  [[ $action =~ ^[A-Za-z0-9\ ]{1,32}$ ]] || action=unknown
  running=0; [[ $pos -gt 0 ]] && running=1
  h unraid_array_started gauge '1 when mdState is STARTED.'
  m unraid_array_started "$([[ $md_state == STARTED ]] && echo 1 || echo 0)"
  h unraid_array_state gauge 'Current mdState as a label (always 1).'
  m "unraid_array_state{state=\"$md_state\"}" 1
  h unraid_array_maintenance_mode gauge '1 when the array was started in Maintenance mode.'
  m unraid_array_maintenance_mode "$([[ ${V[startMode]:-} == Maintenance ]] && echo 1 || echo 0)"
  h unraid_array_filesystems_mounted gauge 'Array and pool filesystems mounted (fsNumMounted).'
  m unraid_array_filesystems_mounted "${V[fsNumMounted]}"
  h unraid_array_filesystems_unmountable gauge 'Array and pool filesystems Unraid could not mount (fsNumUnmountable).'
  m unraid_array_filesystems_unmountable "${V[fsNumUnmountable]}"
  h unraid_mover_running gauge '1 while the mover runs.'
  m unraid_mover_running "$([[ ${V[shareMoverActive]:-} == yes ]] && echo 1 || echo 0)"
  h unraid_parity_running gauge '1 while a parity check, sync or rebuild is in progress (including paused).'
  m unraid_parity_running "$running"
  h unraid_parity_paused gauge '1 when the running operation is paused.'
  m unraid_parity_paused "$([[ $running == 1 && $dt == 0 ]] && echo 1 || echo 0)"
  h unraid_parity_progress_ratio gauge 'Position of the running operation (0-1); 0 when idle.'
  m unraid_parity_progress_ratio "$(awk -v p="$pos" -v s="$size" 'BEGIN { printf "%.4f", (s > 0 && p > 0) ? p / s : 0 }')"
  h unraid_parity_speed_bytes_per_second gauge 'Current speed of the running operation; 0 when idle or paused.'
  m unraid_parity_speed_bytes_per_second "$(awk -v d="$dt" -v b="$db" -v r="$running" 'BEGIN { printf "%.0f", (r == 1 && d > 0) ? b * 1024 / d : 0 }')"
  h unraid_parity_correcting gauge 'Current or last md operation as a label (e.g. "check P"); value 1 when it writes corrections.'
  m "unraid_parity_correcting{action=\"$action\"}" "$(pick mdResyncCorr)"
  h unraid_parity_last_start_timestamp_seconds gauge 'Start of the current or last parity operation (sbSynced).'
  m unraid_parity_last_start_timestamp_seconds "$s1"
  h unraid_parity_last_end_timestamp_seconds gauge 'End of the last finished parity operation (sbSynced2); older than the start while one runs.'
  m unraid_parity_last_end_timestamp_seconds "$s2"
  h unraid_parity_last_duration_seconds gauge 'Duration of the last finished parity operation; 0 while one runs.'
  m unraid_parity_last_duration_seconds "$(( s2 > s1 ? s2 - s1 : 0 ))"
  h unraid_parity_last_errors gauge 'Errors found by the current or last parity operation (sbSyncErrs).'
  m unraid_parity_last_errors "$(pick sbSyncErrs)"
  h unraid_parity_last_exit gauge 'Exit code of the last parity operation: 0 ok, -4 cancelled, other = error (sbSyncExit).'
  m unraid_parity_last_exit "$(pick sbSyncExit)"
  h unraid_disks_ini_timestamp_seconds gauge 'mtime of disks.ini (emhttpd replaces it about every 10 s).'
  m unraid_disks_ini_timestamp_seconds "$disks_mtime"

  h unraid_disk_status gauge 'Slot status from disks.ini as a label (always 1).'
  for row in "${disk_rows[@]}"; do
    IFS=$'\t' read -r name type status _ <<< "$row"
    [[ $name =~ ^[A-Za-z0-9_-]+$ && $type =~ ^[A-Za-z]*$ && $status =~ ^[A-Z_]+$ ]] || continue
    m "unraid_disk_status{disk=\"$name\",type=\"$type\",status=\"$status\"}" 1
  done
  h unraid_disk_ok gauge '1 when the slot status is DISK_OK.'
  for row in "${disk_rows[@]}"; do
    IFS=$'\t' read -r name type status _ <<< "$row"
    [[ $name =~ ^[A-Za-z0-9_-]+$ && $type =~ ^[A-Za-z]*$ ]] || continue
    m "unraid_disk_ok{disk=\"$name\",type=\"$type\"}" "$([[ $status == DISK_OK ]] && echo 1 || echo 0)"
  done
  h unraid_disk_temp_celsius gauge 'Drive temperature reported by emhttpd (absent while spun down).'
  for row in "${disk_rows[@]}"; do
    IFS=$'\t' read -r name type _ temp _ <<< "$row"
    [[ $name =~ ^[A-Za-z0-9_-]+$ && $type =~ ^[A-Za-z]*$ ]] && num "$temp" || continue
    m "unraid_disk_temp_celsius{disk=\"$name\",type=\"$type\"}" "$temp"
  done
  h unraid_disk_errors gauge 'md read/write errors on the slot since the array started (numErrors).'
  for row in "${disk_rows[@]}"; do
    IFS=$'\t' read -r name type _ _ errors _ <<< "$row"
    [[ $name =~ ^[A-Za-z0-9_-]+$ && $type =~ ^[A-Za-z]*$ ]] && num "$errors" || continue
    m "unraid_disk_errors{disk=\"$name\",type=\"$type\"}" "$errors"
  done
  h unraid_disk_spundown gauge '1 when the drive is spun down.'
  for row in "${disk_rows[@]}"; do
    IFS=$'\t' read -r name type _ _ _ spun _ <<< "$row"
    [[ $name =~ ^[A-Za-z0-9_-]+$ && $type =~ ^[A-Za-z]*$ ]] && num "$spun" || continue
    m "unraid_disk_spundown{disk=\"$name\",type=\"$type\"}" "$spun"
  done
  h unraid_disk_fs_mounted gauge '1 when the slot filesystem is mounted (slots with a filesystem, flash excluded).'
  for row in "${disk_rows[@]}"; do
    IFS=$'\t' read -r name type _ _ _ _ fsstatus fstype _ <<< "$row"
    [[ $name =~ ^[A-Za-z0-9_-]+$ && $type =~ ^[A-Za-z]*$ ]] || continue
    [[ -n $fstype && $fstype != auto && $type != Flash ]] || continue
    m "unraid_disk_fs_mounted{disk=\"$name\",type=\"$type\"}" "$([[ $fsstatus == Mounted ]] && echo 1 || echo 0)"
  done

  declare -A TYPE=()
  for row in "${disk_rows[@]}"; do IFS=$'\t' read -r name type _ <<< "$row"; TYPE[$name]=$type; done
  emit_smart() {  # metric column help
    h "$1" gauge "$3"
    for r in "${smart_rows[@]}"; do
      IFS=$'\t' read -r -a c <<< "$r"
      v=${c[$2]}; num "$v" || continue
      m "$1{disk=\"${c[0]}\",type=\"${TYPE[${c[0]}]:-}\"}" "$v"
    done
  }
  emit_smart unraid_disk_smart_failing_attributes 1 'SMART attributes whose WHEN_FAILED column is FAILING_NOW (cached table).'
  emit_smart unraid_disk_smart_failed_in_past_attributes 8 'SMART attributes whose WHEN_FAILED column is In_the_past (cached table; informational, not alerted).'
  emit_smart unraid_disk_smart_reallocated 2 'SMART 5 Reallocated_Sector_Ct raw value (cached table).'
  emit_smart unraid_disk_smart_pending 3 'SMART 197 Current_Pending_Sector raw value (cached table).'
  emit_smart unraid_disk_smart_offline_uncorrectable 4 'SMART 198 Offline_Uncorrectable raw value (cached table).'
  emit_smart unraid_disk_smart_crc 5 'SMART 199 UDMA_CRC_Error_Count raw value (cached table).'
  emit_smart unraid_disk_smart_reported_uncorrect 6 'SMART 187 Reported_Uncorrect raw value, where the drive has it (cached table).'
  emit_smart unraid_disk_smart_power_on_hours 7 'SMART 9 Power_On_Hours (cached table).'
  emit_smart unraid_disk_smart_cache_timestamp_seconds 9 'mtime of the cached SMART table (emhttpd refreshes it every poll_attributes seconds, 1800 here).'
fi

if [[ $mode == --stdout ]]; then
  printf '%s\n' "$marker" "${M[@]}"
  exit 0
fi
tmp=$(mktemp "$textdir/.unraid_health.XXXXXX") || exit 1
trap 'rm -f -- "$tmp"' EXIT
printf '%s\n' "$marker" "${M[@]}" > "$tmp" && chmod 0644 "$tmp" && mv -f -- "$tmp" "$out"
trap - EXIT
[[ $array_ok == 1 ]]
