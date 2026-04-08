import { useState, useEffect, useCallback, useRef } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Search, Loader2 } from "lucide-react";
import { useSearch } from "@/hooks/useSearch";
import { SearchResultsList } from "@/components/search/SearchResults";
import type {
  SearchResultAgent,
  SearchResultSession,
  SearchResultEvent,
} from "@/lib/types";

type ResultItem = SearchResultAgent | SearchResultSession | SearchResultEvent;

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelectResult?: (type: "agent" | "session" | "event", item: ResultItem) => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  onSelectResult,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { results, loading, error } = useSearch(query);

  // Reset state when opening/closing
  useEffect(() => {
    if (open) {
      setQuery("");
      setFocusedIndex(0);
      // Focus input after dialog opens
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  // Global keyboard shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  const totalItems = results
    ? results.agents.length + results.sessions.length + results.events.length
    : 0;

  const handleSelect = useCallback(
    (type: "agent" | "session" | "event", item: ResultItem) => {
      onSelectResult?.(type, item);
      onOpenChange(false);
    },
    [onSelectResult, onOpenChange],
  );

  // Get item at flat index
  const getItemAtIndex = useCallback(
    (index: number): { type: "agent" | "session" | "event"; item: ResultItem } | null => {
      if (!results) return null;
      let offset = 0;
      if (index < offset + results.agents.length) {
        return { type: "agent", item: results.agents[index - offset] };
      }
      offset += results.agents.length;
      if (index < offset + results.sessions.length) {
        return { type: "session", item: results.sessions[index - offset] };
      }
      offset += results.sessions.length;
      if (index < offset + results.events.length) {
        return { type: "event", item: results.events[index - offset] };
      }
      return null;
    },
    [results],
  );

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIndex((prev) => (prev + 1 < totalItems ? prev + 1 : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIndex((prev) => (prev - 1 >= 0 ? prev - 1 : Math.max(totalItems - 1, 0)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = getItemAtIndex(focusedIndex);
      if (selected) {
        handleSelect(selected.type, selected.item);
      }
    }
  }

  // Reset focused index when results change
  useEffect(() => {
    setFocusedIndex(0);
  }, [results]);

  const showNoResults =
    query.length >= 2 && !loading && results && totalItems === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[20%] w-full max-w-lg translate-y-0 p-0"
        onKeyDown={handleKeyDown}
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        {/* Search input */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents, sessions, events..."
            className="flex-1 bg-transparent text-sm text-text placeholder:text-text-muted focus:outline-none"
            aria-label="Search"
          />
          {loading && (
            <Loader2
              className="h-4 w-4 shrink-0 animate-spin text-text-muted"
              data-testid="search-loading"
            />
          )}
        </div>

        {/* Results */}
        {results && totalItems > 0 && (
          <SearchResultsList
            results={results}
            onSelect={handleSelect}
            focusedIndex={focusedIndex}
          />
        )}

        {/* No results */}
        {showNoResults && (
          <div className="px-3 py-8 text-center text-xs text-text-muted">
            No results found for &quot;{query}&quot;
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="px-3 py-4 text-center text-xs text-red-400">
            {error}
          </div>
        )}

        {/* Hint when empty */}
        {query.length < 2 && !loading && (
          <div className="px-3 py-8 text-center text-xs text-text-muted">
            Type at least 2 characters to search
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
