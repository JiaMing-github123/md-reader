import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useRef } from "react";

interface SearchBarProps {
  query: string;
  currentMatch: number;
  matchCount: number;
  onQueryChange: (query: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
}

export function SearchBar({
  query,
  currentMatch,
  matchCount,
  onQueryChange,
  onNext,
  onPrevious,
  onClose,
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div className="search-bar" role="search">
      <Search size={16} aria-hidden="true" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.shiftKey ? onPrevious() : onNext();
          }
          if (event.key === "Escape") onClose();
        }}
        placeholder="Find in document"
        aria-label="Find in document"
        spellCheck={false}
      />
      <span className="search-bar__count" aria-live="polite">
        {query ? `${currentMatch} / ${matchCount}` : "0 / 0"}
      </span>
      <button
        type="button"
        onClick={onPrevious}
        disabled={matchCount === 0}
        aria-label="Previous match"
        title="Previous match (Shift+Enter)"
      >
        <ChevronUp size={17} />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={matchCount === 0}
        aria-label="Next match"
        title="Next match (Enter)"
      >
        <ChevronDown size={17} />
      </button>
      <button type="button" onClick={onClose} aria-label="Close search" title="Close (Esc)">
        <X size={17} />
      </button>
    </div>
  );
}

