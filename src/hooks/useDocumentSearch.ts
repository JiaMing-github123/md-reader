import { useCallback, useEffect, useRef, useState } from "react";

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

const RESULTS_HIGHLIGHT = "md-reader-search-results";
const ACTIVE_HIGHLIGHT = "md-reader-search-active";

function highlightApi(): {
  registry: HighlightRegistry | null;
  Highlight: HighlightConstructor | null;
} {
  const registry = (CSS as typeof CSS & { highlights?: HighlightRegistry }).highlights ?? null;
  const Highlight =
    (window as typeof window & { Highlight?: HighlightConstructor }).Highlight ?? null;
  return { registry, Highlight };
}

function clearHighlights(): void {
  const { registry } = highlightApi();
  registry?.delete(RESULTS_HIGHLIGHT);
  registry?.delete(ACTIVE_HIGHLIGHT);
}

function findRanges(container: HTMLElement, query: string): Range[] {
  const ranges: Range[] = [];
  const needle = query.toLocaleLowerCase();
  if (!needle) return ranges;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (
        !parent ||
        parent.closest("[data-search-exclude]") ||
        parent.closest("svg, script, style") ||
        !node.textContent?.trim()
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let textNode = walker.nextNode();
  while (textNode) {
    const text = textNode.textContent ?? "";
    const haystack = text.toLocaleLowerCase();
    let start = 0;

    while (start <= haystack.length - needle.length) {
      const matchIndex = haystack.indexOf(needle, start);
      if (matchIndex < 0) break;
      const range = document.createRange();
      range.setStart(textNode, matchIndex);
      range.setEnd(textNode, matchIndex + needle.length);
      ranges.push(range);
      start = matchIndex + Math.max(needle.length, 1);
    }

    textNode = walker.nextNode();
  }

  return ranges;
}

export function useDocumentSearch(
  articleRef: React.RefObject<HTMLElement>,
  scrollRef: React.RefObject<HTMLElement>,
  query: string,
  documentKey: string,
) {
  const rangesRef = useRef<Range[]>([]);
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);

  useEffect(() => {
    clearHighlights();
    rangesRef.current = [];
    setMatchCount(0);
    setCurrentMatch(0);

    if (!query.trim() || !articleRef.current) return;

    const frame = requestAnimationFrame(() => {
      if (!articleRef.current) return;
      const ranges = findRanges(articleRef.current, query.trim());
      rangesRef.current = ranges;
      setMatchCount(ranges.length);

      const { registry, Highlight } = highlightApi();
      if (registry && Highlight && ranges.length > 0) {
        registry.set(RESULTS_HIGHLIGHT, new Highlight(...ranges));
      }
    });

    return () => {
      cancelAnimationFrame(frame);
      clearHighlights();
    };
  }, [articleRef, documentKey, query]);

  useEffect(() => {
    const ranges = rangesRef.current;
    const range = ranges[currentMatch];
    const { registry, Highlight } = highlightApi();
    registry?.delete(ACTIVE_HIGHLIGHT);

    if (!range) return;
    if (registry && Highlight) {
      registry.set(ACTIVE_HIGHLIGHT, new Highlight(range));
    }

    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;
    const matchRect = range.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    const isOutside =
      matchRect.top < containerRect.top + 64 || matchRect.bottom > containerRect.bottom - 40;

    if (isOutside) {
      scrollContainer.scrollTo({
        top:
          scrollContainer.scrollTop +
          matchRect.top -
          containerRect.top -
          containerRect.height * 0.28,
        behavior: "smooth",
      });
    }
  }, [currentMatch, matchCount, scrollRef]);

  const next = useCallback(() => {
    if (matchCount === 0) return;
    setCurrentMatch((current) => (current + 1) % matchCount);
  }, [matchCount]);

  const previous = useCallback(() => {
    if (matchCount === 0) return;
    setCurrentMatch((current) => (current - 1 + matchCount) % matchCount);
  }, [matchCount]);

  return {
    matchCount,
    currentMatch: matchCount > 0 ? currentMatch + 1 : 0,
    next,
    previous,
  };
}

