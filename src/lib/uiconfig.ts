// The lab's names, groups, aliases and LAN prefix (Snapshot.ui, built by shared/ui.ts from homelab.json `ui`).
// A module-level value so plain helpers (monoOf, displayName, shortUrl …) can read it without a React context:
// AppProvider sets it from every snapshot before its children render; tests call setUi() with a fixture.
import { resolveUi } from '../../shared/ui.ts';
import type { UiView } from '../../shared/types.ts';

let current: UiView = resolveUi();
export const ui = () => current;
export function setUi(v: UiView | undefined) { if (v) current = v; }
