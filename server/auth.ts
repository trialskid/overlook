// Login, once per device: one password (its bcrypt hash in CC_LOGIN_BCRYPT), then a signed cookie keeps that device
// in for a year. Off when CC_LOGIN_BCRYPT is unset (dev, mock, tests).
// The rate limit keys on the client address: X-Forwarded-For only with CC_TRUST_PROXY=1 (set it when a reverse proxy
// is the only thing that can reach the server, so the header can't be forged), else the TCP peer.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import bcrypt from 'bcryptjs';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { config } from './config.ts';

const COOKIE = 'cc_session';
const YEAR_S = 365 * 86400;
const env = (k: string) => process.env[k]?.trim() || '';

export const loginEnabled = () => !!env('CC_LOGIN_BCRYPT');
/** The cookie is Secure (HTTPS only) unless CC_COOKIE_SECURE=0, for a LAN setup served over plain HTTP. */
const secureCookie = () => env('CC_COOKIE_SECURE') !== '0';
/** The name password managers save the password under (the form only asks for the password). */
const loginUser = () => env('CC_LOGIN_USER') || 'admin';
// a missing secret means sessions die with the process (the page asks again after a restart): set CC_SESSION_SECRET
const secret = env('CC_SESSION_SECRET') || randomBytes(32).toString('hex');
if (loginEnabled() && !env('CC_SESSION_SECRET')) console.warn('[auth] CC_SESSION_SECRET not set: sessions end when the server restarts');

const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

/** `<exp>.<nonce>.<sig>`; valid until exp (epoch s). Rotating CC_SESSION_SECRET signs every device out. */
export function makeSession(now = Date.now()): string {
  const p = `${Math.floor(now / 1000) + YEAR_S}.${randomBytes(9).toString('base64url')}`;
  return `${p}.${sign(p)}`;
}
export function validSession(v: string | undefined, now = Date.now()): boolean {
  if (!v) return false;
  const i = v.lastIndexOf('.');
  if (i < 0) return false;
  const p = v.slice(0, i), sig = Buffer.from(v.slice(i + 1)), want = Buffer.from(sign(p));
  if (sig.length !== want.length || !timingSafeEqual(sig, want)) return false;
  const exp = Number(p.split('.')[0]);
  return Number.isFinite(exp) && exp * 1000 > now;
}
export const signedIn = (c: Context) => !loginEnabled() || validSession(getCookie(c, COOKIE));

// ---- rate limit: 10 failed tries per client in 15 min
const fails = new Map<string, number[]>();
const WINDOW = 15 * 60e3, MAX_FAILS = 10;
const peer = (c: Context) => { try { return getConnInfo(c).remote.address ?? ''; } catch { return ''; } };
export const clientOf = (c: Context) => (env('CC_TRUST_PROXY') === '1' ? (c.req.header('x-forwarded-for') ?? '').split(',')[0].trim() : peer(c)) || 'direct';
function blocked(ip: string, now: number) {
  const t = (fails.get(ip) ?? []).filter(x => now - x < WINDOW);
  fails.set(ip, t);
  if (fails.size > 1000) fails.clear();
  return t.length >= MAX_FAILS;
}

export async function handleLogin(c: Context) {
  const now = Date.now(), ip = clientOf(c);
  if (blocked(ip, now)) return c.html(page('Too many tries. Wait 15 minutes.'), 429);
  const body = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const pw = typeof body.password === 'string' ? body.password : '';
  const ok = pw.length > 0 && pw.length <= 200 && (await bcrypt.compare(pw, env('CC_LOGIN_BCRYPT')).catch(() => false));
  if (!ok) { fails.get(ip)!.push(now); return c.html(page('Wrong password.'), 401); }
  fails.delete(ip);
  setCookie(c, COOKIE, makeSession(now), { httpOnly: true, secure: secureCookie(), sameSite: 'Lax', path: '/', maxAge: YEAR_S });
  return c.redirect('/', 303);
}
export function handleLogout(c: Context) {
  deleteCookie(c, COOKIE, { path: '/', secure: secureCookie() });
  return c.redirect('/login', 303);
}

const title = () => (config.ui?.title || 'Overlook').replace(/[<>&"]/g, '');
/** The login page: one password field (a hidden username so iOS/macOS Passwords can save and fill it). */
export const page = (msg = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="theme-color" content="#0e1014">
<title>${title()} · sign in</title><link rel="icon" href="/favicon.svg">
<style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(ellipse 60% 50% at 38% 30%,#161b26 0%,#0e1014 70%);color:#eceef2;font:500 14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
form{width:min(320px,calc(100vw - 48px));display:flex;flex-direction:column;gap:14px}
h1{margin:6px 0 0;font-size:24px;letter-spacing:-.02em}p{margin:0;color:#7f8693;font-size:13px}
input{font:inherit;font-size:16px;color:#eceef2;background:transparent;border:0;border-bottom:1px solid #2c313c;padding:10px 0;outline:none}
input:focus{border-bottom-color:#6ea8ff}button{font:inherit;font-weight:700;min-height:44px;border:0;border-radius:10px;background:#6ea8ff;color:#0b1020;cursor:pointer}
.err{color:#ff5c6c}
</style></head><body><form method="post" action="/login">
<h1>${title()}</h1>
<p>Sign in once on this device; it stays signed in for a year.</p>
<input type="text" name="username" value="${loginUser().replace(/[<>&"]/g, '')}" autocomplete="username" hidden>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required aria-label="Password">
${msg ? `<p class="err" role="alert">${msg.replace(/[<>&]/g, '')}</p>` : ''}
<button type="submit">Sign in</button></form></body></html>`;
