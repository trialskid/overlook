# Security

Overlook shows your lab: host names, addresses, what runs where and what's down. Treat the page like an admin console.

- **Read-only keys.** Give each integration the least it needs: a Proxmox token with PVEAuditor, a Grafana Viewer service account, a read-only ntfy user, Uptime Kuma's metrics key. Overlook only sends GET requests to your sources.
- **Secrets stay on the server.** Keys live in `.env` and are only used by the backend; the page gets the Snapshot, never a key. Errors shown on the page are stripped of URLs and tokens.
- **Keep it off the internet.** Run it on your LAN, a VPN, or behind a reverse proxy with authentication. Its own login (`CC_LOGIN_BCRYPT`) signs a device in for a year with an HMAC-signed, HttpOnly cookie and rate-limits failed tries.
- **The one write.** Saving bookmarks (`PUT /api/links`) needs a signed-in device, a same-origin request and a custom header, and writes only `DATA_DIR/links.json` (keeping the last 20 versions). Every other method is refused.
- **The container** runs as a non-root user with a read-only filesystem, no capabilities and `no-new-privileges` in the provided compose file.

## Reporting

Please report a vulnerability privately, through GitHub's "Report a vulnerability" on this repository, rather than in a public issue.
