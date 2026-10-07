# Deploying

Overlook is one container. It needs your `homelab.json` (mounted read-only), your `.env` (read-only keys), and a data volume for what it keeps: Kuma's 24 h strips, the ntfy feed, the saved bookmarks and Library health's daily samples.

## Docker Compose

```sh
mkdir overlook && cd overlook
curl -O https://raw.githubusercontent.com/trialskid/overlook/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/trialskid/overlook/main/.env.example && mv .env.example .env && chmod 600 .env
mkdir config && curl -o config/homelab.json https://raw.githubusercontent.com/trialskid/overlook/main/config/example.homelab.json
# edit config/homelab.json and .env, then:
docker compose up -d
docker compose logs -f overlook   # "modules on: …" lists what it found
```

The compose file runs the container read-only, with no capabilities and a 256 MB memory cap. `/healthz` returns 503 once no snapshot has been built for 2 min or every source has been failing for 2 min; the image's health check uses it.

Upgrading: `docker compose pull && docker compose up -d`. The config and data volume carry over.

## Keep it private

The page shows your whole lab: host names, addresses, what's down. Run it on your LAN or a VPN, never openly on the internet. Two layers help:

- **Its own login.** Set `CC_LOGIN_BCRYPT` to a bcrypt hash of a password (`docker run --rm ghcr.io/trialskid/overlook node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" 'your password'`, or `htpasswd -bnBC 12 "" 'your password' | tr -d ':\n'`) and `CC_SESSION_SECRET` to a random string (`openssl rand -hex 32`). Each device signs in once and stays signed in for a year. Over plain HTTP, also set `CC_COOKIE_SECURE=0`.
- **A reverse proxy.** Serve it over HTTPS and let only the proxy reach the container's port. When the proxy is the only way in, set `CC_TRUST_PROXY=1` so the login's rate limit uses `X-Forwarded-For`.

Caddy:

```caddyfile
overlook.lab.example.com {
	reverse_proxy 10.20.0.43:8080 {
		flush_interval -1   # the page is fed over Server-Sent Events
	}
}
```

nginx: `proxy_buffering off;` and `proxy_read_timeout 1h;` on the location, for the same reason.

## Settings

| `.env` | Default | What |
|---|---|---|
| `PORT` | 8787 (8080 in the image) | Listen port. |
| `HOMELAB_CONFIG` | `config/homelab.json` (`/config/homelab.json` in the image) | The config file. |
| `DATA_DIR` | `data` (`/data` in the image) | What Overlook keeps between restarts. |
| `TZ` | system | Clock times, when homelab.json has no `timezone`. |
| `MOCK` | | `1`: mock data from the config, no sources polled (the demo). |
| `ALLOW_SIMULATE` | | `1`: `?simulateIncident=1` works in production (only the page that asks sees it, labelled SIMULATED). |
| `PROBES`, `WEATHER` | on | `off` to stop the public probes or the weather. |
| `CC_FETCH` | | `curl`: fetch through `/usr/bin/curl` (macOS dev machines, whose Local Network privacy blocks node). |

The keys are in `.env.example` and [INTEGRATIONS.md](INTEGRATIONS.md).

## Without Docker

```sh
npm ci && npm run build
NODE_ENV=production PORT=8080 node --env-file=.env dist/server/index.js
```
