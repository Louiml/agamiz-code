/**
 * Vitest setup shared by every environment.
 *
 * jsdom-specific setup is guarded, because the default environment is `node`
 * for the pure-logic suites and `window` does not exist there.
 */

import { afterEach } from 'vitest';

if (typeof window !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');

  // jsdom implements neither of these, and the editor's scroll-sync relies on
  // both. Stubbed rather than polyfilled: the components only need a value that
  // changes when scrollTop is assigned.
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = function scrollTo() {};
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }

  // Unmount between tests so a component's effects and listeners do not leak
  // into the next one. `globals: true` in the config makes `cleanup` reachable.
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => {
    cleanup();
  });
}
