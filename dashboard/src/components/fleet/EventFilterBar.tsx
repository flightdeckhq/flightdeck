import { EVENT_FILTER_PILLS } from "@/lib/events";

interface EventFilterBarProps {
  activeFilter: string | null;
  onFilterChange: (filter: string | null) => void;
}

export function EventFilterBar({ activeFilter, onFilterChange }: EventFilterBarProps) {
  return (
    <div
      className="flex h-9 shrink-0 items-center gap-1.5 px-3"
      style={{
        background: "var(--bg)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
      data-testid="event-filter-bar"
    >
      {EVENT_FILTER_PILLS.map((pill) => {
        const isAll = pill.label === "All";
        const isActive = isAll ? activeFilter === null : activeFilter === pill.label;

        return (
          <button
            key={pill.label}
            className="flex items-center gap-1.5 rounded font-mono text-[11px] font-medium transition-all"
            style={{
              height: 22,
              padding: "0 10px",
              cursor: "pointer",
              borderRadius: 4,
              ...(isActive
                ? isAll
                  ? {
                      background: "var(--accent-glow)",
                      color: "var(--accent)",
                      border: "1px solid var(--accent-border)",
                    }
                  : {
                      background: "var(--bg-elevated)",
                      color: "var(--text)",
                      border: "1px solid var(--border-strong)",
                    }
                : {
                    background: "transparent",
                    color: "var(--text-muted)",
                    border: "1px solid var(--border-subtle)",
                  }),
            }}
            onClick={() => {
              if (isAll) {
                onFilterChange(null);
              } else {
                onFilterChange(isActive ? null : pill.label);
              }
            }}
            data-testid={`filter-pill-${pill.label}`}
          >
            {pill.color && (
              <span
                className="inline-block rounded-full"
                style={{
                  width: 6,
                  height: 6,
                  background: pill.color,
                  flexShrink: 0,
                }}
                data-testid="filter-dot"
              />
            )}
            {pill.label}
          </button>
        );
      })}
    </div>
  );
}
