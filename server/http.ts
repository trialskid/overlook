// Read-only upstream client: every call is a GET. CC_FETCH=curl routes through /usr/bin/curl, because
// macOS Local Network privacy blocks node (but not Apple's curl) from LAN addresses on the Mac mini.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFile } from 'node:child_process';

const VIA_CURL = process.env.CC_FETCH === 'curl';
export interface GetOpts { headers?: Record<string, string>; timeout?: number; insecure?: boolean }

export async function getBuffer(url: string, o: GetOpts = {}): Promise<{ status: number; body: Buffer; type: string }> {
  return VIA_CURL ? viaCurl(url, o) : viaNode(url, o);
}
export async function getText(url: string, o?: GetOpts) {
  const r = await getBuffer(url, o);
  if (r.status < 200 || r.status >= 300) throw new Error(`HTTP ${r.status} from ${redact(url)}`);
  return r.body.toString('utf8');
}
export const getJSON = async <T = any>(url: string, o?: GetOpts): Promise<T> => JSON.parse(await getText(url, o));

/** TCP reachability probe (no data sent). */
export function tcpUp(host: string, port: number, timeout = 2000): Promise<boolean> {
  return new Promise(res => {
    const s = net.connect({ host, port, timeout }, () => { s.destroy(); res(true); });
    s.on('error', () => res(false)); s.on('timeout', () => { s.destroy(); res(false); });
  });
}

/** Settles on every path, like curl: a body cut mid-answer rejects, and `timeout` is a total deadline (curl's -m),
 *  not just an idle one, so a server that dribbles bytes can't hold a caller (the 1 s sampler, startup) forever. */
export function viaNode(url: string, { headers = {}, timeout = 8000, insecure = false }: GetOpts) {
  return new Promise<{ status: number; body: Buffer; type: string }>((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    let done = false;
    const finish = (err: Error | null, v?: { status: number; body: Buffer; type: string }) => {
      if (done) return;
      done = true; clearTimeout(deadline);
      if (err) { req.destroy(); reject(err); } else resolve(v!);
    };
    const deadline = setTimeout(() => finish(new Error(`timeout ${redact(url)}`)), timeout);
    const req = lib.request(u, { method: 'GET', headers, timeout, rejectUnauthorized: !insecure }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > 8e6) finish(new Error('response too large')); else chunks.push(c); });
      res.on('end', () => finish(null, { status: res.statusCode ?? 0, body: Buffer.concat(chunks), type: String(res.headers['content-type'] ?? '') }));
      res.on('aborted', () => finish(new Error(`connection closed mid-answer ${redact(url)}`)));
      res.on('error', e => finish(e));
      res.on('close', () => { if (!res.complete) finish(new Error(`connection closed mid-answer ${redact(url)}`)); });
    });
    req.on('timeout', () => finish(new Error(`timeout ${redact(url)}`)));
    req.on('error', e => finish(e));
    req.end();
  });
}

export function viaCurl(url: string, { headers = {}, timeout = 8000, insecure = false }: GetOpts) {
  const args = ['-sS', '-m', String(Math.ceil(timeout / 1000)), '--max-filesize', '8000000', '-D', '-'];
  if (insecure) args.push('-k');
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(url);
  return new Promise<{ status: number; body: Buffer; type: string }>((resolve, reject) => {
    execFile('/usr/bin/curl', args, { maxBuffer: 9e6, encoding: 'buffer' }, (err, out, stderr) => {
      // err.message starts with the whole command line, headers (keys) included: report curl's own stderr line instead
      if (err) return reject(new Error(`curl ${redact(url)}: ${String(stderr).trim().split('\n')[0] || `exit ${err.code ?? '?'}`}`));
      // -D - writes the headers first; the last header block ends at the first blank line before the body
      let i = 0, head = '';
      while (true) { const j = out.indexOf('\r\n\r\n', i); if (j < 0) break; const block = out.subarray(i, j).toString('latin1'); if (!/^HTTP\//.test(block)) break; head = block; i = j + 4; if (!/^HTTP\/\S+ 1\d\d/.test(block)) break; }
      const status = Number(head.match(/^HTTP\/\S+ (\d+)/)?.[1] ?? 0);
      const type = head.match(/^content-type:\s*(.+)$/im)?.[1]?.trim() ?? '';
      resolve({ status, body: out.subarray(i), type });
    });
  });
}

/** Keys sometimes travel in query strings (Tautulli) or as user:password@ in a URL. Never let them reach a log line or the page. */
export function redact(url: string) {
  return String(url).replace(/([?&](apikey|api_key|access_token|token|key|auth|password)=)[^&\s]+/gi, '$1…').replace(/(\/\/)[^/@\s]+@/g, '$1…@');
}
