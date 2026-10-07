// The Links tab's editable list: the rules a save must pass, shared by the server (PUT /api/links) and the editor
// (inline errors before it sends). url is what homelab.json holds: a bare host[:port][/path] or an http(s):// URL.
import type { HomelabConfig, LinkGroup } from './types.ts';

export const LINK_LIMITS = { groups: 60, items: 300, groupName: 40, itemName: 60, url: 300, bodyBytes: 64 * 1024 } as const;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
/** host (dotted labels, an IPv4 fits), optional :port, optional path/query/fragment without spaces or control characters */
const WEB = new RegExp(`^(?:https?://)?(?:${LABEL}\\.)*${LABEL}(?::\\d{1,5})?(?:[/?#][^\\s\\x00-\\x1f\\x7f]*)?$`, 'i');

export const groupNameProblem = (v: string) => (!v ? 'needs a name' : v.length > LINK_LIMITS.groupName ? `over ${LINK_LIMITS.groupName} characters` : null);
export const itemNameProblem = (v: string) => (!v ? 'needs a name' : v.length > LINK_LIMITS.itemName ? `over ${LINK_LIMITS.itemName} characters` : null);
export function urlProblem(v: string): string | null {
  if (!v) return 'needs a URL';
  if (v.length > LINK_LIMITS.url) return `over ${LINK_LIMITS.url} characters`;
  // 'javascript:', 'data:', 'mailto:', 'http:/x' … (but not 'host:8080')
  if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(v) && !/^https?:\/\//i.test(v)) return 'only http:// or https:// (or a bare domain like example.com)';
  if (!WEB.test(v)) return 'not a web address (example.com, example.com/path or https://…)';
  try { new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`); } catch { return 'not a web address'; }
  return null;
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const quote = (s: string) => (s ? ` (“${s.length > 30 ? s.slice(0, 29) + '…' : s}”)` : '');

/** Trimmed and checked; the first problem in plain English, else the clean list (only name/url kept). */
export function validateLinks(input: unknown): { ok: true; groups: LinkGroup[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'No list of categories was sent.' };
  if (!input.length) return { ok: false, error: 'Keep at least one category.' };
  if (input.length > LINK_LIMITS.groups) return { ok: false, error: `Too many categories (${input.length}; at most ${LINK_LIMITS.groups}).` };
  const total = input.reduce((a: number, g) => a + (Array.isArray(g?.items) ? g.items.length : 0), 0);
  if (total > LINK_LIMITS.items) return { ok: false, error: `Too many links (${total}; at most ${LINK_LIMITS.items}).` };
  const groups: LinkGroup[] = [], seen = new Set<string>();
  for (const [gi, g] of input.entries()) {
    const name = str(g?.name), at = `Category ${gi + 1}${quote(name)}`;
    if (!g || typeof g !== 'object' || !Array.isArray(g.items)) return { ok: false, error: `${at} is not a category.` };
    const gp = groupNameProblem(name);
    if (gp) return { ok: false, error: `${at}: ${gp}.` };
    if (seen.has(name.toLowerCase())) return { ok: false, error: `${at}: another category already has this name.` };
    seen.add(name.toLowerCase());
    const items: LinkGroup['items'] = [];
    for (const [ii, l] of (g.items as unknown[]).entries()) {
      const it = l as { name?: unknown; url?: unknown } | null, n = str(it?.name), u = str(it?.url), where = `${at}, link ${ii + 1}${quote(n)}`;
      const p = itemNameProblem(n) ?? (urlProblem(u) && `URL ${urlProblem(u)}`);
      if (p) return { ok: false, error: `${where}: ${p}.` };
      items.push({ name: n, url: u });
    }
    groups.push({ name, items });
  }
  return { ok: true, groups };
}

/** homelab.json `links` → groups; an entry missing its url is skipped, never a throw (a half-edited file). */
export const seedLinks = (cfg: HomelabConfig): LinkGroup[] => Object.entries(cfg.links ?? {}).map(([name, list]) => ({
  name, items: (Array.isArray(list) ? list : []).filter(x => Array.isArray(x) && typeof x[1] === 'string').map(([n, url]) => ({ name: String(n), url })),
}));

/** How the page shows a saved url (unchanged from the homelab.json days): domain without scheme or trailing /, https:// added to a bare one. */
export const linkView = (name: string, url: string) => ({
  name, domain: url.replace(/^https?:\/\//i, '').replace(/\/$/, ''), url: /^https?:\/\//i.test(url) ? url : `https://${url}`,
});
