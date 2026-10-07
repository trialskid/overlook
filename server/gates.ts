// What every request passes before a route (index.ts mounts these first; tests mount them on their own app):
// the method gate and security headers, the login routes, then the login gate.
import type { Hono } from 'hono';
import { handleLogin, handleLogout, loginEnabled, page, signedIn } from './auth.ts';

// The site is read-only: nothing here can write to the homelab. The only non-GET/HEAD requests are signing in and
// out of this page and saving the Links tab (server/links.ts, which writes only DATA_DIR/links.json). Everything
// else, OPTIONS included (so no CORS preflight ever succeeds), is 405.
const WRITES = new Set(['POST /login', 'POST /logout', 'PUT /api/links']);
// login (server/auth.ts): everything except /healthz, the login page and the icon needs a signed-in device
const OPEN = new Set(['/healthz', '/login', '/logout', '/favicon.svg']);

export function gates(app: Hono) {
  app.use('*', async (c, next) => {
    const m = c.req.method;
    if (m !== 'GET' && m !== 'HEAD' && !WRITES.has(`${m} ${c.req.path}`)) return c.text('read-only', 405);
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  });
  app.get('/login', c => (signedIn(c) && loginEnabled() ? c.redirect('/', 303) : c.html(page())));
  app.post('/login', async c => (loginEnabled() ? handleLogin(c) : c.redirect('/', 303)));
  app.post('/logout', c => handleLogout(c));
  app.use('*', async (c, next) => {
    if (OPEN.has(c.req.path) || signedIn(c)) return next();
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'sign in' }, 401);
    return c.redirect('/login', 303);
  });
}
