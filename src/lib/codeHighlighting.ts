// Leave a little time to highlight before the block reaches either pane's viewport.
const VIEWPORT_MARGIN_PX = 300;
// See docs/highlight-performance.md for the representative document and size timings.
export const MAX_HIGHLIGHT_CHARACTERS = 20_000;
export const MAX_HIGHLIGHT_LINES = 400;

export function canHighlightCode(code: string): boolean {
  if (code.length > MAX_HIGHLIGHT_CHARACTERS) return false;
  let lines = 1;
  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) === 10 && ++lines > MAX_HIGHLIGHT_LINES) return false;
  }
  return true;
}

interface PaneObserver {
  observer: IntersectionObserver;
  listeners: Map<Element, (visible: boolean) => void>;
}

const paneObservers = new WeakMap<HTMLElement, PaneObserver>();

// One observer per scroll pane, instead of one observer per code block.
export function observeCodeVisibility(
  root: HTMLElement,
  block: HTMLElement,
  listener: (visible: boolean) => void,
): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  let pane = paneObservers.get(root);
  if (!pane) {
    const listeners: PaneObserver["listeners"] = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
      },
      { root, rootMargin: `${VIEWPORT_MARGIN_PX}px 0px` },
    );
    pane = { observer, listeners };
    paneObservers.set(root, pane);
  }
  pane.listeners.set(block, listener);
  pane.observer.observe(block);
  return () => {
    pane.listeners.delete(block);
    pane.observer.unobserve(block);
    if (pane.listeners.size === 0) {
      pane.observer.disconnect();
      paneObservers.delete(root);
    }
  };
}

const pendingHighlights = new Set<() => void>();
let highlightFrame: number | undefined;

function scheduleHighlight(): void {
  if (highlightFrame !== undefined || pendingHighlights.size === 0) return;
  highlightFrame = window.requestAnimationFrame(() => {
    highlightFrame = undefined;
    const task = pendingHighlights.values().next().value;
    if (task) {
      pendingHighlights.delete(task);
      task();
    }
    scheduleHighlight();
  });
}

// At most one block per frame. A fast scroll can cancel blocks that were passed over.
export function enqueueCodeHighlight(task: () => void): () => void {
  pendingHighlights.add(task);
  scheduleHighlight();
  return () => {
    pendingHighlights.delete(task);
    if (pendingHighlights.size === 0 && highlightFrame !== undefined) {
      window.cancelAnimationFrame(highlightFrame);
      highlightFrame = undefined;
    }
  };
}
