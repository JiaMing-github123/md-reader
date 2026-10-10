import { useCallback, useEffect, useRef, useState } from "react";

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

interface SearchableTextGroup {
  text: string;
  segments: TextSegment[];
}

type HighlightConstructor = new (...ranges: Range[]) => unknown;

const RESULTS_HIGHLIGHT = "md-reader-search-results";
const ACTIVE_HIGHLIGHT = "md-reader-search-active";
const SEARCH_DEBOUNCE_MS = 150;
const MAX_HIGHLIGHT_RANGES = 2000;
const SEARCH_EXCLUDE = "[data-search-exclude], svg, script, style";
const SEARCH_GROUP = "[data-code-content], pre, p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote";

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

// A code block (or paragraph) remains one searchable string when token spans replace
// plain text. Segment offsets map matches, including cross-token matches, back to DOM.
function buildSearchIndex(container: HTMLElement): SearchableTextGroup[] {
  const groups: SearchableTextGroup[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return !node.textContent || node.parentElement?.closest(SEARCH_EXCLUDE)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  let owner: Element | null = null;
  let group: SearchableTextGroup | undefined;
  let node = walker.nextNode();
  while (node) {
    const nextOwner = node.parentElement?.closest(SEARCH_GROUP) ?? container;
    if (!group || owner !== nextOwner) {
      group = { text: "", segments: [] };
      groups.push(group);
      owner = nextOwner;
    }
    const text = node.textContent ?? "";
    const start = group.text.length;
    group.text += text;
    group.segments.push({ node: node as Text, start, end: start + text.length });
    node = walker.nextNode();
  }
  return groups.filter((entry) => entry.text.trim());
}

function segmentAt(segments: TextSegment[], offset: number): TextSegment {
  let low = 0;
  let high = segments.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (segments[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  return segments[low];
}

function findRanges(
  index: SearchableTextGroup[],
  query: string,
): { ranges: Range[]; limitExceeded: boolean } {
  const ranges: Range[] = [];
  // Match against original UTF-16 offsets: lowercasing can change a character's
  // length (for example U+0130) and produce invalid Range offsets.
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
  for (const entry of index) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(entry.text))) {
      if (ranges.length === MAX_HIGHLIGHT_RANGES) return { ranges, limitExceeded: true };
      const start = match.index;
      const end = start + match[0].length;
      const first = segmentAt(entry.segments, start);
      const last = segmentAt(entry.segments, end - 1);
      const range = document.createRange();
      range.setStart(first.node, start - first.start);
      range.setEnd(last.node, end - last.start);
      ranges.push(range);
    }
  }
  return { ranges, limitExceeded: false };
}

function affectsSearch(record: MutationRecord): boolean {
  const element = record.target instanceof Element ? record.target : record.target.parentElement;
  return !element?.closest(SEARCH_EXCLUDE);
}

export function useDocumentSearch(
  articleRef: React.RefObject<HTMLElement>,
  scrollRef: React.RefObject<HTMLElement>,
  query: string,
  documentKey: string,
  documentContent: string,
  renderKey: string,
) {
  const indexRef = useRef<SearchableTextGroup[]>([]);
  const indexDirtyRef = useRef(true);
  const rangesRef = useRef<Range[]>([]);
  const observerRef = useRef<MutationObserver | null>(null);
  const scheduleSearchRef = useRef<(() => void) | null>(null);
  const refreshSearchRef = useRef<(() => void) | null>(null);
  const currentMatchRef = useRef(0);
  const scrollToMatchRef = useRef(false);
  const [matchCount, setMatchCount] = useState(0);
  const [matchLimitExceeded, setMatchLimitExceeded] = useState(false);
  const [currentMatch, setCurrentMatch] = useState(0);
  const [rangeRevision, setRangeRevision] = useState(0);

  useEffect(() => {
    indexRef.current = [];
    indexDirtyRef.current = true;
    rangesRef.current = [];
    clearHighlights();
    const article = articleRef.current;
    if (!article) return;
    const observer = new MutationObserver((records) => {
      if (!records.some(affectsSearch)) return;
      indexDirtyRef.current = true;
      indexRef.current = [];
      rangesRef.current = [];
      clearHighlights();
      // No search -> no scan. A burst of highlights shares one trailing debounce.
      scheduleSearchRef.current?.();
    });
    observer.observe(article, { childList: true, characterData: true, subtree: true });
    observerRef.current = observer;
    return () => {
      observer.disconnect();
      observerRef.current = null;
      indexRef.current = [];
      rangesRef.current = [];
      clearHighlights();
    };
  }, [articleRef, documentContent, documentKey, renderKey]);

  useEffect(() => {
    let timer: number | undefined;
    let cancelled = false;
    const normalizedQuery = query.trim();
    scrollToMatchRef.current = true;
    currentMatchRef.current = 0;
    setCurrentMatch(0);
    setMatchCount(0);
    setMatchLimitExceeded(false);
    rangesRef.current = [];
    clearHighlights();

    const refresh = () => {
      window.clearTimeout(timer);
      if (cancelled || !normalizedQuery || !documentKey) return;
      const article = articleRef.current;
      if (!article) return;
      if (observerRef.current?.takeRecords().some(affectsSearch)) indexDirtyRef.current = true;
      if (indexDirtyRef.current) {
        indexRef.current = buildSearchIndex(article);
        indexDirtyRef.current = false;
      }
      const { ranges, limitExceeded } = findRanges(indexRef.current, normalizedQuery);
      rangesRef.current = ranges;
      const active = Math.min(currentMatchRef.current, Math.max(ranges.length - 1, 0));
      currentMatchRef.current = active;
      setCurrentMatch(active);
      setMatchCount(ranges.length);
      setMatchLimitExceeded(limitExceeded);
      setRangeRevision((revision) => revision + 1);
      const { registry, Highlight } = highlightApi();
      clearHighlights();
      if (registry && Highlight && ranges.length) {
        registry.set(RESULTS_HIGHLIGHT, new Highlight(...ranges));
      }
    };
    const schedule = () => {
      window.clearTimeout(timer);
      if (normalizedQuery && documentKey) timer = window.setTimeout(refresh, SEARCH_DEBOUNCE_MS);
    };
    refreshSearchRef.current = refresh;
    scheduleSearchRef.current = schedule;
    schedule();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      refreshSearchRef.current = null;
      scheduleSearchRef.current = null;
      clearHighlights();
    };
  }, [articleRef, documentContent, documentKey, query, renderKey]);

  useEffect(() => {
    const range = rangesRef.current[currentMatch];
    const { registry, Highlight } = highlightApi();
    registry?.delete(ACTIVE_HIGHLIGHT);
    if (!range) return;
    if (registry && Highlight) registry.set(ACTIVE_HIGHLIGHT, new Highlight(range));
    // Replacing token nodes must restore paint without pulling a manually scrolled
    // reader back to its old active match. Only a new query or navigation scrolls.
    if (!scrollToMatchRef.current) return;
    scrollToMatchRef.current = false;
    const scrollContainer = scrollRef.current;
    if (!scrollContainer) return;
    const matchRect = range.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();
    if (matchRect.top < containerRect.top + 64 || matchRect.bottom > containerRect.bottom - 40) {
      scrollContainer.scrollTo({
        top: scrollContainer.scrollTop + matchRect.top - containerRect.top - containerRect.height * 0.28,
        behavior: "smooth",
      });
    }
  }, [currentMatch, rangeRevision, scrollRef]);

  const navigate = useCallback((direction: number) => {
    // Navigation never uses detached nodes, even before the mutation debounce fires.
    if (observerRef.current?.takeRecords().some(affectsSearch)) indexDirtyRef.current = true;
    if (indexDirtyRef.current) refreshSearchRef.current?.();
    const count = rangesRef.current.length;
    if (!count) return;
    const next = (currentMatchRef.current + direction + count) % count;
    scrollToMatchRef.current = true;
    currentMatchRef.current = next;
    setCurrentMatch(next);
    setRangeRevision((revision) => revision + 1);
  }, []);
  const next = useCallback(() => navigate(1), [navigate]);
  const previous = useCallback(() => navigate(-1), [navigate]);

  return { matchCount, matchLimitExceeded, currentMatch: matchCount > 0 ? currentMatch + 1 : 0, next, previous };
}
