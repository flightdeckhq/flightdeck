import type { ReactNode } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Reusable chart shell used by the Analytics v2 page rows -- title,
 * optional right-side toolbar (e.g. By Provider / By Model toggle),
 * optional warning banner (estimated cost disclaimer), plus shared
 * loading / error / empty states. Centralising these pieces here keeps
 * every row visually aligned and avoids repeating the same skeleton
 * markup across five or six chart components.
 */
interface ChartCardProps {
  title: ReactNode;
  toolbar?: ReactNode;
  warning?: ReactNode;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: boolean;
  emptyMessage?: string;
  className?: string;
  contentHeight?: number;
  children: ReactNode;
}

export function ChartCard({
  title,
  toolbar,
  warning,
  loading,
  error,
  onRetry,
  empty,
  emptyMessage = "No data for this period",
  className,
  contentHeight = 260,
  children,
}: ChartCardProps) {
  return (
    <Card className={cn("flex flex-col", className)}>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>{title}</CardTitle>
        {toolbar}
      </CardHeader>
      {warning && (
        <div
          className="mx-6 -mt-2 mb-3 rounded border px-3 py-2 text-[11px] leading-relaxed"
          style={{
            background: "var(--color-warn-soft)",
            borderColor: "var(--color-warn-border)",
            color: "var(--warning)",
          }}
        >
          {warning}
        </div>
      )}
      <CardContent className="flex-1">
        {loading && (
          <div
            style={{ height: contentHeight }}
            className="flex items-center justify-center"
          >
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        )}
        {error && !loading && (
          <div
            style={{ height: contentHeight }}
            className="flex flex-col items-center justify-center gap-2"
          >
            <span className="text-sm text-danger">{error}</span>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            )}
          </div>
        )}
        {!loading && !error && empty && (
          <div
            style={{ height: contentHeight }}
            className="flex items-center justify-center text-sm text-text-muted"
          >
            {emptyMessage}
          </div>
        )}
        {!loading && !error && !empty && children}
      </CardContent>
    </Card>
  );
}
