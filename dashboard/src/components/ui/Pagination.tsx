import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface PaginationProps {
  total: number;
  offset: number;
  limit: number;
  onPageChange: (newOffset: number) => void;
  onLimitChange: (newLimit: number) => void;
  entityLabel?: string;
}

const PER_PAGE_OPTIONS = [25, 50, 100];

export function Pagination({
  total,
  offset,
  limit,
  onPageChange,
  onLimitChange,
  entityLabel = "runs",
}: PaginationProps) {
  const { page, totalPages, rangeStart, rangeEnd } = useMemo(() => {
    const currentPage = Math.floor(offset / limit) + 1;
    const pages = Math.max(1, Math.ceil(total / limit));
    const start = total === 0 ? 0 : offset + 1;
    const end = Math.min(offset + limit, total);
    return { page: currentPage, totalPages: pages, rangeStart: start, rangeEnd: end };
  }, [offset, limit, total]);

  const isFirstPage = page <= 1;
  const isLastPage = page >= totalPages;

  return (
    <div className="flex items-center justify-between gap-4 text-xs text-text-secondary">
      <span data-testid="pagination-range">
        Showing {rangeStart}-{rangeEnd} of {total} {entityLabel}
      </span>

      <div className="flex items-center gap-3">
        <button
          data-testid="pagination-prev"
          onClick={() => onPageChange(Math.max(0, offset - limit))}
          disabled={isFirstPage}
          className={cn(
            "px-2 py-1 rounded-md border border-border text-xs transition-colors",
            isFirstPage
              ? "text-text-disabled cursor-not-allowed"
              : "text-text hover:bg-surface-hover"
          )}
        >
          &larr;
        </button>

        <span data-testid="pagination-page">
          Page {page} of {totalPages}
        </span>

        <button
          data-testid="pagination-next"
          onClick={() => onPageChange(offset + limit)}
          disabled={isLastPage}
          className={cn(
            "px-2 py-1 rounded-md border border-border text-xs transition-colors",
            isLastPage
              ? "text-text-disabled cursor-not-allowed"
              : "text-text hover:bg-surface-hover"
          )}
        >
          &rarr;
        </button>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-text-muted">Per page:</span>
        <Select
          value={String(limit)}
          onValueChange={(v) => onLimitChange(Number(v))}
        >
          <SelectTrigger className="w-16" data-testid="pagination-limit">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PER_PAGE_OPTIONS.map((opt) => (
              <SelectItem key={opt} value={String(opt)}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
