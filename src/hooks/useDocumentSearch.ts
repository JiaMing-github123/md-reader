import { useCallback, useEffect, useRef, useState } from "react";

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

interface SearchableTextNode {
  node: Text;
  foldedText: string;
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

const RESULTS_HIGHLIGHT = "md-reader-search-results";
const ACTIVE_HIGHLIGHT = "md-reader-search-active";
const SEARCH_DEBOUNCE_MS = 150;
const MAX_HIGHLIGHT_RANGES = 2000;

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

function buildSearchIndex(container: HTMLElement): SearchableTextNode[] {
  const nodes: SearchableTextNode[] = [];
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

  let node = walker.nextNode();
  while (node) {
    const text = node.textContent ?? "";
    nodes.push({ node: node as Text, foldedText: text.toLocaleLowerCase() });
    node = walker.nextNode();
  }

  return nodes;
}

function findRanges(
  index: SearchableTextNode[],
  query: string,
): { ranges: Range[]; limitExceeded: boolean } {
  const ranges: Range[] = [];
  const needle = query.toLocaleLowerCase();
  if (!needle) return { ranges, limitExceeded: false };

  for (const entry of index) {
    let start = 0;
    while (start <= entry.foldedText.length - needle.length) {
      const matchIndex = entry.foldedText.indexOf(needle, start);
      if (matchIndex < 0) break;
      if (ranges.length === MAX_HIGHLIGHT_RANGES) {
        return { ranges, limitExceeded: true };
      }

      const range = document.createRange();
      range.setStart(entry.node, matchIndex);
      range.setEnd(entry.node, matchIndex + needle.length);
      ranges.push(range);
      start = matchIndex + needle.length;
    }
  }

  return { ranges, limitExceeded: false };
}

export function useDocumentSearch(
  articleRef: React.RefObject<HTMLElement>,
  scrollRef: React.RefObject<HTMLElement>,
  query: string,
  documentKey: string,
  documentContent: string,
  renderKey: string,
) {
  const indexRef = useRef<SearchableTextNode[]>([]);
  const rangesRef = useRef<Range[]>([]);
  const searchGenerationRef = useRef(0);
  const [matchCount, setMatchCount] = useState(0);
  const [matchLimitExceeded, setMatchLimitExceeded] = useState(false);
  const [currentMatch, setCurrentMatch] = useState(0);

  useEffect(() => {
    searchGenerationRef.current += 1;
    clearHighlights();
    rangesRef.current = [];
    indexRef.current = articleRef.current ? buildSearchIndex(articleRef.current) : [];

    return () => {
      searchGenerationRef.current += 1;
      indexRef.current = [];
      rangesRef.current = [];
      clearHighlights();
    };
  }, [articleRef, documentContent, documentKey, renderKey]);

  useEffect(() => {
    const generation = ++searchGenerationRef.current;
    clearHighlights();
    rangesRef.current = [];
    setMatchCount(0);
    setMatchLimitExceeded(false);
    setCurrentMatch(0);

    const normalizedQuery = query.trim();
    if (!normalizedQuery || !documentKey) return;

    const timer = window.setTimeout(() => {
      if (generation !== searchGenerationRef.current) return;
      const { ranges, limitExceeded } = findRanges(indexRef.current, normalizedQuery);
      if (generation !== searchGenerationRef.current) return;

      rangesRef.current = ranges;
      setMatchCount(ranges.length);
      setMatchLimitExceeded(limitExceeded);

      const { registry, Highlight } = highlightApi();
      if (registry && Highlight && ranges.length > 0) {
        registry.set(RESULTS_HIGHLIGHT, new Highlight(...ranges));
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      if (generation === searchGenerationRef.current) {
        searchGenerationRef.current += 1;
      }
      clearHighlights();
    };
  }, [documentContent, documentKey, query, renderKey]);

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
    matchLimitExceeded,
    currentMatch: matchCount > 0 ? currentMatch + 1 : 0,
    next,
    previous,
  };
}
