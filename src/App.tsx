import { Component, useEffect, type ReactNode } from 'react';
import { useLive, useWidth } from './lib/live.ts';
import { AppProvider, useApp } from './state.tsx';
import { Desktop } from './desktop/Desktop.tsx';
import { Mobile } from './mobile/Mobile.tsx';
import { CommandPalette } from './CommandPalette.tsx';

/** Below this the phone layout: the 1440 px desktop composition is never scaled under 0.8 (11 px labels at 8.8 px) and
 *  never scrolls sideways, so tablets in portrait and narrow windows get the phone screens instead. */
export const MOBILE_MAX = 1152;

export function App() {
  const live = useLive();
  if (!live.snapshot) {
    return <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', color: 'var(--mut-3)', fontSize: 13 }}>{live.connected ? 'Loading…' : 'Connecting to Command Center…'}</div>;
  }
  return <AppProvider live={live} snap={live.snapshot}><Shell /></AppProvider>;
}

/** A render error shows one line instead of unmounting the page, and the next snapshot (resetKey) tries again. */
class Boundary extends Component<{ resetKey: number; children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.message ?? e).slice(0, 160) }; }
  componentDidCatch(e: unknown) { console.error('[cc] render failed', e); }
  componentDidUpdate(prev: { resetKey: number }) { if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null }); }
  render() {
    return this.state.error
      ? <div role="alert" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center', color: 'var(--mut-3)', fontSize: 13 }}>This view failed to draw ({this.state.error}). It tries again with the next update.</div>
      : this.props.children;
  }
}

function Shell() {
  const w = useWidth();
  const { ui, set, snap } = useApp();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); set(s => ({ cmdOpen: !s.cmdOpen })); }
      // one search (review finding 10): '/' opens the palette, unless it's being typed into a field
      const el = e.target as HTMLElement | null;
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey && !(el && (/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName) || el.isContentEditable))) { e.preventDefault(); set({ cmdOpen: true }); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [set]);
  return <>
    <Boundary resetKey={snap.at}>{w < MOBILE_MAX ? <Mobile /> : <Desktop width={w} />}</Boundary>
    {ui.cmdOpen && <Boundary resetKey={snap.at}><CommandPalette /></Boundary>}
  </>;
}
