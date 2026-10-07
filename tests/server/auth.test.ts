import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.CC_SESSION_SECRET = 'test-secret';
const { makeSession, validSession } = await import('../../server/auth.ts');

test('session cookie: valid for a year, then not; tampering fails', () => {
  const now = Date.UTC(2026, 9, 6);
  const s = makeSession(now);
  assert.ok(validSession(s, now));
  assert.ok(validSession(s, now + 364 * 86400e3));
  assert.ok(!validSession(s, now + 366 * 86400e3));
  const [exp, nonce, sig] = s.split('.');
  assert.ok(!validSession(`${Number(exp) + 999999}.${nonce}.${sig}`, now)); // extended expiry, old signature
  assert.ok(!validSession(`${exp}.${nonce}.${sig.slice(0, -2)}xx`, now));
  assert.ok(!validSession(undefined, now) && !validSession('', now) && !validSession('garbage', now));
});

test('rate-limit client: X-Forwarded-For only with CC_TRUST_PROXY=1, else the peer', async () => {
  const { clientOf } = await import('../../server/auth.ts');
  const ctx = (xff: string) => ({ req: { header: (k: string) => (k === 'x-forwarded-for' ? xff : undefined) }, env: {} }) as any;
  delete process.env.CC_TRUST_PROXY;
  assert.equal(clientOf(ctx('10.9.9.9')), 'direct'); // a forged header is ignored (no socket here: 'direct')
  process.env.CC_TRUST_PROXY = '1';
  assert.equal(clientOf(ctx('10.9.9.9, 10.20.0.42')), '10.9.9.9');
  delete process.env.CC_TRUST_PROXY;
});

test('login page: the saved username and title come from settings, escaped', async () => {
  const { page } = await import('../../server/auth.ts');
  delete process.env.CC_LOGIN_USER;
  assert.match(page(), /name="username" value="admin"/);
  process.env.CC_LOGIN_USER = 'ops"<x>';
  assert.match(page(), /name="username" value="opsx"/);
  delete process.env.CC_LOGIN_USER;
});
