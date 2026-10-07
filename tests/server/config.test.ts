// homelab.json hot reload: replaced in place on a good edit, kept on a bad one. Works on a temp copy.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-config-'));
const file = path.join(dir, 'homelab.json');
const original = JSON.parse(fs.readFileSync(new URL('../../config/example.homelab.json', import.meta.url), 'utf8'));
fs.writeFileSync(file, JSON.stringify(original));
process.env.HOMELAB_CONFIG = file;
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const { config, reloadConfig } = await import('../../server/config.ts');

test('reloads a changed file into the same object', () => {
  const logs: string[] = [];
  const same = config;
  assert.equal(reloadConfig(m => logs.push(m)), false); // unchanged
  fs.writeFileSync(file, JSON.stringify({ ...original, domain: 'example.dev', uiLabels: { ...original.uiLabels, git: 'Forgejo' } }));
  assert.equal(reloadConfig(m => logs.push(m)), true);
  assert.equal(config, same);
  assert.equal(config.domain, 'example.dev');
  assert.equal(config.uiLabels.git, 'Forgejo');
  assert.deepEqual(logs, ['config reloaded']);
});

test('a file that does not parse, or lacks a key, keeps the old config', () => {
  const logs: string[] = [];
  fs.writeFileSync(file, '{ "domain": "broken", ');
  assert.equal(reloadConfig(m => logs.push(m)), false);
  assert.equal(config.domain, 'example.dev');
  const { hosts: _gone, ...rest } = original;
  fs.writeFileSync(file, JSON.stringify({ ...rest, domain: 'nohosts.dev' }));
  assert.equal(reloadConfig(m => logs.push(m)), false);
  assert.equal(config.domain, 'example.dev');
  assert.ok(Array.isArray(config.hosts) && config.hosts.length > 0);
  assert.equal(logs.length, 2);
  assert.match(logs[1], /missing hosts/);
});

test('a file that parses but fails the validator (a guest without an ip) keeps the old config', async () => {
  const { derive } = await import('../../server/derive.ts');
  const { mockRaw } = await import('../../server/adapters/mock.ts');
  const { emptyRaw } = await import('../../server/raw.ts');
  // what index.ts passes to watchConfig: derive must build on empty and on mock data with the new file
  const validate = (next: typeof config) => { for (const raw of [emptyRaw(), mockRaw(next)]) derive(raw, [], { mock: false, incident: false, build: 't' }, next); };
  const logs: string[] = [];
  const guests = [...original.guests, { host: 'pve1', vmid: 199, name: 'dhcp-vm', kind: 'vm', services: [] }];
  fs.writeFileSync(file, JSON.stringify({ ...original, domain: 'guest.dev', guests }));
  // derive skips the entry it can't place, so this one is accepted; a broken top-level shape is not
  assert.equal(reloadConfig(m => logs.push(m), validate), true);
  assert.equal(config.domain, 'guest.dev');
  fs.writeFileSync(file, JSON.stringify({ ...original, domain: 'broken.dev', network: { ...original.network, subnet: 5 } })); // not a string: derive can't build
  assert.equal(reloadConfig(m => logs.push(m), validate), false);
  assert.equal(config.domain, 'guest.dev');
  assert.match(logs.at(-1)!, /keeping the old one/);
});
