// Uptime Kuma /metrics parsing, and the history file v3.1 keeps apart from v3's (a rollback keeps working).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kuma-'));
process.env.DATA_DIR = dir;
// v3's file in the same volume: a different shape that v3.1 must neither read nor overwrite
const v3 = JSON.stringify({ days: { git: [1, 2] }, slots: { git: {} } });
fs.writeFileSync(path.join(dir, 'kuma-history.json'), v3);
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const { parse, saveKumaHistory } = await import('../../server/adapters/kuma.ts');

const METRICS = `# HELP monitor_status Monitor Status (1 = UP, 0= DOWN, 2= PENDING, 3= MAINTENANCE)
monitor_status{monitor_id="13",monitor_name="Gitea",monitor_type="http",monitor_url="https://git.lab.example.com",monitor_hostname="null",monitor_port="null"} 1
monitor_response_time{monitor_id="13",monitor_name="Gitea",monitor_type="http",monitor_url="https://git.lab.example.com",monitor_hostname="null",monitor_port="null"} 41
monitor_uptime_ratio{monitor_id="13",monitor_name="Gitea",monitor_type="http",monitor_url="https://git.lab.example.com",monitor_hostname="null",monitor_port="null",window="1d"} 0.998
monitor_uptime_ratio{monitor_id="13",monitor_name="Gitea",monitor_type="http",monitor_url="https://git.lab.example.com",monitor_hostname="null",monitor_port="null",window="30d"} 0.9995
monitor_cert_days_remaining{monitor_id="13",monitor_name="Gitea",monitor_type="http",monitor_url="https://git.lab.example.com",monitor_hostname="null",monitor_port="null"} 61.7
monitor_status{monitor_id="25",monitor_name="Caddy",monitor_type="port",monitor_url="http://10.20.0.203:80",monitor_hostname="10.20.0.203",monitor_port="443"} 0
monitor_response_time{monitor_id="25",monitor_name="Caddy",monitor_type="port",monitor_url="http://10.20.0.203:80",monitor_hostname="10.20.0.203",monitor_port="443"} 12
monitor_status{monitor_id="29",monitor_name="UniFi",monitor_type="http",monitor_url="https://10.20.0.203:18043",monitor_hostname="null",monitor_port="null"} 1
monitor_cert_days_remaining{monitor_id="29",monitor_name="UniFi",monitor_type="http",monitor_url="https://10.20.0.203:18043",monitor_hostname="null",monitor_port="null"} 3
monitor_cert_is_valid{monitor_id="29",monitor_name="UniFi",monitor_type="http",monitor_url="https://10.20.0.203:18043",monitor_hostname="null",monitor_port="null"} 0
monitor_response_time{monitor_id="40",monitor_name="No status yet",monitor_type="http",monitor_url="https://x.lab.example.com",monitor_hostname="null",monitor_port="null"} 5
`;

test('parse: status, latency, Kuma\'s own uptime windows, cert days; a port monitor drops its stale URL', () => {
  const ms = parse(METRICS);
  assert.deepEqual(ms.map(m => m.id), [13, 25, 29]); // 40 has no status line: left out
  const git = ms[0];
  assert.deepEqual([git.status, git.ms, git.up1d, git.up30d, git.certDays, git.url], ['up', 41, 0.998, 0.9995, 61, 'https://git.lab.example.com']);
  const caddy = ms[1];
  assert.deepEqual([caddy.status, caddy.ms, caddy.url, caddy.hostname, caddy.port], ['down', null, '', '10.20.0.203', '443']);
  assert.equal(ms[2].certDays, null); // an invalid cert on a monitor that skips TLS checks isn't an expiry to act on
});

test('parse: metrics without monitor ids (Kuma 1) are an error, not an empty list', () => {
  assert.throws(() => parse('monitor_status{monitor_name="x"} 1\n'), /monitor_id/);
});

test('history goes to kuma-history-v2.json; v3\'s kuma-history.json is left alone', () => {
  saveKumaHistory();
  assert.ok(fs.existsSync(path.join(dir, 'kuma-history-v2.json')));
  assert.equal(fs.readFileSync(path.join(dir, 'kuma-history.json'), 'utf8'), v3);
});
