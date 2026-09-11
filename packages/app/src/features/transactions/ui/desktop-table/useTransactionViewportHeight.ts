import { useLayoutEffect, type RefObject } from 'react';
import { TRANSACTION_ROW_HEIGHT } from './useVirtualizedTransactionRows';

const BOTTOM_GAP = 16;
// Keep the register usable when expanded page content exceeds the screen.
const MIN_HEIGHT = TRANSACTION_ROW_HEIGHT * 2;

export function useTransactionViewportHeight(
  viewportRef: RefObject<HTMLDivElement | null>,
  hasRows: boolean
) {
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !hasRows) return;

    let frame: number | null = null;
    const previousMaxHeight = viewport.style.maxHeight;
    const ancestors: HTMLElement[] = [];
    for (let parent = viewport.parentElement; parent; parent = parent.parentElement) {
      ancestors.push(parent);
    }

    const fit = () => {
      // Measure at the page's unscrolled position. Otherwise an already-scrolled
      // page would keep its extra height, preserving the second scrollbar.
      const top =
        viewport.getBoundingClientRect().top +
        ancestors.reduce((offset, parent) => offset + parent.scrollTop, 0);
      const height = Math.max(MIN_HEIGHT, window.innerHeight - top - BOTTOM_GAP);
      viewport.style.maxHeight = `${height}px`;
    };

    const scheduleFit = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        fit();
      });
    };

    fit();
    // Headers, filters, banners, and the upcoming panel can all change the
    // table's offset. Observe the surrounding layout as well as window resizes.
    const observer = new ResizeObserver(scheduleFit);
    ancestors.forEach((parent) => observer.observe(parent));
    window.addEventListener('resize', scheduleFit);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', scheduleFit);
      if (frame !== null) cancelAnimationFrame(frame);
      viewport.style.maxHeight = previousMaxHeight;
    };
  }, [viewportRef, hasRows]);
}
