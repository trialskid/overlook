# Contributing

```sh
npm ci
npm run demo        # the example lab on mock data, http://localhost:5173
npm test            # node:test, on the example lab; no network
npm run typecheck
npm run shots       # screenshots of every tab and state (needs a server: see tests/shots.mjs)
```

- **Keep it read-only.** Adapters only GET. Nothing on the page acts on a device or service.
- **Keep it optional.** A new integration is a module (`server/modules.ts`): an adapter, the Raw keys it owns, and sections that hide when it's off. A lab without it must still render cleanly.
- **Keep it honest.** Old data is never shown as current; a missing value reads "—", never 0.
- **Keep it generic.** No host names, addresses or products baked into code: they come from `homelab.json`. Examples and tests use the fictional Acme Lab (`lab.example.com`, `10.20.0.0/24`).
- **Design.** No cards: sections sit under a 1px top rule. Colours only through `src/styles/tokens.css`.

A change to derive() should come with a test in `tests/server/` (see `lab.test.ts` for whole-snapshot tests on the example lab).
