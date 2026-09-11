import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTransactionViewportHeight } from './useTransactionViewportHeight';

const observers: MockResizeObserver[] = [];

class MockResizeObserver {
  observe = vi.fn();

  disconnect = vi.fn();

  constructor(public notify: () => void) {
    observers.push(this);
  }
}

describe('useTransactionViewportHeight', () => {
  let page: HTMLDivElement;
  let viewport: HTMLDivElement;
  let top: number;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('innerHeight', 900);
    observers.length = 0;
    page = document.createElement('div');
    viewport = document.createElement('div');
    page.append(viewport);
    document.body.append(page);
    top = 340;
    vi.spyOn(viewport, 'getBoundingClientRect').mockImplementation(() => ({ top }) as DOMRect);
  });

  afterEach(() => {
    cleanup();
    page.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('fits below the page controls with room for the table border and bottom gap', () => {
    renderHook(() => useTransactionViewportHeight({ current: viewport }, true));

    expect(viewport.style.maxHeight).toBe('544px');
    expect(observers[0].observe).toHaveBeenCalledWith(page);
  });

  it('removes excess page height even if the outer page is already scrolled', () => {
    page.scrollTop = 100;
    top = 240;
    viewport.scrollTop = 800;
    renderHook(() => useTransactionViewportHeight({ current: viewport }, true));

    expect(viewport.style.maxHeight).toBe('544px');
    expect(viewport.scrollTop).toBe(800);
  });

  it('refits when controls grow or the window shrinks without scrolling the register', () => {
    renderHook(() => useTransactionViewportHeight({ current: viewport }, true));
    viewport.scrollTop = 500;
    top = 460;
    act(() => {
      observers[0].notify();
      vi.advanceTimersByTime(20);
    });
    expect(viewport.style.maxHeight).toBe('424px');

    vi.stubGlobal('innerHeight', 700);
    act(() => {
      window.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(20);
    });
    expect(viewport.style.maxHeight).toBe('224px');
    expect(viewport.scrollTop).toBe(500);
  });

  it('attaches when an empty register gains rows and cleans up when it is removed', () => {
    const ref = { current: null as HTMLDivElement | null };
    const { rerender, unmount } = renderHook(
      ({ hasRows }) => useTransactionViewportHeight(ref, hasRows),
      { initialProps: { hasRows: false } }
    );
    expect(observers).toHaveLength(0);

    ref.current = viewport;
    rerender({ hasRows: true });
    expect(viewport.style.maxHeight).toBe('544px');

    observers[0].notify();
    unmount();
    act(() => vi.advanceTimersByTime(20));
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(viewport.style.maxHeight).toBe('');
  });

  it('keeps a usable register when expanded page content itself exceeds the screen', () => {
    top = 1000;
    renderHook(() => useTransactionViewportHeight({ current: viewport }, true));

    expect(viewport.style.maxHeight).toBe('128px');
  });
});
