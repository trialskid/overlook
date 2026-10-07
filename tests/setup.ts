// Public tests run against the example lab (config/example.homelab.json) unless HOMELAB_CONFIG says otherwise; a
// test that needs its own file sets HOMELAB_CONFIG before it imports server/config.ts.
import { fileURLToPath } from 'node:url';

process.env.HOMELAB_CONFIG ??= fileURLToPath(new URL('../config/example.homelab.json', import.meta.url));
