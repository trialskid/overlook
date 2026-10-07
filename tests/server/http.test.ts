// http.ts: node and curl transports behave the same on answers that end badly (production runs node, the Mac curl).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';

delete process.env.CC_FETCH;
const { viaNode, viaCurl, getJSON } = await import('../../server/http.ts');

const server = http.createServer((req, res) => {
  const p = new URL(req.url!, 'http://x').pathname;
  if (p === '/ok') { res.setHeader('Content-Type', 'application/json'); res.end('{"a":1}'); return; }
  if (p === '/cut') { res.writeHead(200, { 'Content-Length': '1000' }); res.write('partial'); setTimeout(() => res.socket?.destroy(), 30); return; }
  if (p === '/drip') { res.writeHead(200); const t = setInterval(() => res.write('.'), 100); res.on('close', () => clearInterval(t)); return; }
  if (p === '/big') { res.writeHead(200); const chunk = Buffer.alloc(1e6, 120); let n = 0; const go = () => { while (n++ < 10) if (!res.write(chunk)) return void res.once('drain', go); res.end(); }; go(); return; }
  if (p === '/302') { res.writeHead(302, { Location: '/ok' }); res.end(); return; }
  if (p === '/204') { res.writeHead(204); res.end(); return; }
  res.writeHead(500); res.end('boom');
});
await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.closeAllConnections(); server.close(); });

const transports = [['node', viaNode], ...(fs.existsSync('/usr/bin/curl') ? [['curl', viaCurl] as const] : [])] as const;
for (const [name, get] of transports) {
  test(`${name}: plain answers, redirects not followed, 204 and 500 come back as status codes`, async () => {
    const ok = await get(`${base}/ok`, { timeout: 3000 });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.toString(), '{"a":1}');
    assert.match(ok.type, /json/);
    assert.equal((await get(`${base}/302`, { timeout: 3000 })).status, 302);
    assert.equal((await get(`${base}/204`, { timeout: 3000 })).status, 204);
    assert.equal((await get(`${base}/500`, { timeout: 3000 })).status, 500);
  });
  test(`${name}: a body cut mid-answer rejects (never hangs)`, async () => {
    const t0 = Date.now();
    await assert.rejects(get(`${base}/cut`, { timeout: 5000 }));
    assert.ok(Date.now() - t0 < 3000);
  });
  test(`${name}: a server that keeps dribbling bytes rejects at the total deadline`, async () => {
    const t0 = Date.now();
    await assert.rejects(get(`${base}/drip`, { timeout: 1500 }), /timeout|28/);
    assert.ok(Date.now() - t0 < 3500, `took ${Date.now() - t0} ms`);
  });
  test(`${name}: an answer over 8 MB rejects`, async () => {
    await assert.rejects(get(`${base}/big`, { timeout: 5000 }));
  });
}

test('getJSON: a non-2xx is an error that names the URL without its key', async () => {
  await assert.rejects(getJSON(`${base}/500?apikey=SECRET123`), (e: Error) => /HTTP 500/.test(e.message) && !e.message.includes('SECRET123'));
});
