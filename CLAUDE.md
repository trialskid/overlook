# Overlook

A status-first homelab dashboard: one page that says whether anything is broken, where it broke on the network map, and what to do next. Hono backend (`server/`), React + Vite page (`src/`), shared contract (`shared/types.ts`: Snapshot every 10 s, Tick 1/s, over SSE). Everything about a lab comes from `config/homelab.json` (start from `config/example.homelab.json`) and `.env` (keys, never sent to the browser).

## Rules

1. **Read-only toward the lab.** Adapters only GET. The House tab shows Home Assistant state as text; no control-like elements.
2. **Secrets stay server-side.** Keys live in `.env`; the page only gets the Snapshot/Tick shapes.
3. **No personal data in the repo.** Examples, mocks and tests use the fictional Acme Lab (`lab.example.com`, `10.20.0.0/24`). `scripts/leak-scan.sh` checks every tracked file against a private denylist; it must pass before any push.
4. **Every integration is optional.** A lab without a given service must still render cleanly (the section hides; it doesn't nag).
5. **Never stale.** A source past its max age drops out and is named on the page.
6. **Colours only via `src/styles/tokens.css`.** No cards: sections sit under a 1px top rule.

## Commands

```sh
npm run dev        # backend :8787 + Vite :5173 (reads .env and config/homelab.json)
npm run dev:mock   # same with mock data
npm run build      # dist/web + dist/server/index.js
npm run typecheck
npm test
scripts/leak-scan.sh
```
