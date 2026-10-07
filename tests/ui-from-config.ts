// Side-effect import for tests of page helpers: the ui store (src/lib/uiconfig.ts) as AppProvider would set it from
// a snapshot of the test's homelab.json.
import { config } from '../server/config.ts';
import { resolveUi } from '../shared/ui.ts';
import { setUi } from '../src/lib/uiconfig.ts';

setUi(resolveUi(config));
