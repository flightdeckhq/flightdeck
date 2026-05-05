import { useEffect, useRef, useState } from "react";
import type { ScaleTime } from "d3-scale";
import type { Session, AgentEvent } from "@/lib/types";
import type { ClientType } from "@/lib/agent-identity";
import { SwimLane } from "./SwimLane";

/**
 * Tailwind `h-12` on SwimLane's collapsed header row. Used only as
 * the pre-measurement fallback when a row mounts off-screen AND the
 * ResizeObserver callback hasn't fired yet -- a one-render window.
 * Not the source of truth for the placeholder; the live ResizeObserver
 * takes over as soon as the first layout pass completes.
 */
const FALLBACK_ROW_HEIGHT = 48;

interface VirtualizedSwimLaneProps {
  flavor: string;
  /** D115 label + pill metadata. Forwarded verbatim to SwimLane. */
  agentName?: string;
  clientType?: ClientType;
  agentType?: string;
  sessions: Session[];
  /** Forwarded to SwimLane for the expanded SESSIONS drawer; see
   *  SwimLane.tsx for the windowing rationale. */
  expandedSessions?: Session[];
  /** D115 ``agent.total_sessions`` lifetime counter. Forwarded to
   *  SwimLane so the expanded-drawer footer can compare against
   *  the returned ``expandedSessions`` length and surface a
   *  ``"Showing N of M sessions"`` preamble when truncated. */
  totalSessionsLifetime?: number;
  scale: ScaleTime<number, number>;
  onSessionClick: (sessionId: string, eventId?: string, event?: AgentEvent) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  timelineWidth: number;
  leftPanelWidth: number;
  activeFilter?: string | null;
  sessionVersions?: Record<string, number>;
  matchingSessionIds?: Set<string> | null;
  /** D126 § 7.fix.A — forwarded to SwimLane for relationship-pill
   *  click navigation. */
  onScrollToAgent?: (agentId: string) => void;
  /** D126 UX revision 2026-05-03 — row topology (``"root"`` or
   *  ``"child"``); forwarded verbatim to SwimLane so the
   *  ``data-topology`` attribute drives the indent + bg tint. */
  topology?: "root" | "child";
}

/**
 * Row-level virtualization wrapper for SwimLane.
 *
 * Smoke-test fleets can exceed 50 flavors. Every row being mounted at
 * once pushed the swimlane to ~9k DOM nodes and ~84 ms style-recalc
 * per tick -- style recalc scales roughly linearly with node count,
 * and memoization alone can't lower the absolute DOM footprint.
 *
 * This wrapper observes the row with an IntersectionObserver
 * (rootMargin "200px" so rows pre-mount just before scrolling into
 * view) and swaps the live SwimLane for a same-height spacer div once
 * the row is safely off-screen. Height is measured from the real
 * SwimLane via ResizeObserver, so the spacer matches whether the row
 * was last collapsed (~48 px) or expanded (200 px+). The user sees no
 * layout shift on scroll; the DOM below the visible row count simply
 * doesn't exist.
 *
 * Expansion state is owned by Fleet.tsx's `expandedFlavors` Set, not
 * SwimLane local state, so an unmount/remount on scroll preserves
 * whichever rows the user had opened.
 *
 * ALL row is intentionally not virtualized (Timeline.tsx keeps
 * AllSwimLane outside this wrapper) because it's always at the top
 * of the scroll container and unmounting it would defeat its whole
 * purpose as a fleet-wide overview.
 *
 * jsdom (vitest) does not ship IntersectionObserver. Missing IO OR
 * missing ResizeObserver both degrade gracefully to rendering the
 * full SwimLane so existing Timeline unit tests keep working without
 * a polyfill.
 */
export function VirtualizedSwimLane(props: VirtualizedSwimLaneProps) {
  const hasIO =
    typeof window !== "undefined" && typeof window.IntersectionObserver !== "undefined";
  const hasRO =
    typeof window !== "undefined" && typeof window.ResizeObserver !== "undefined";

  const ref = useRef<HTMLDivElement>(null);
  // Default to visible so the very first render mounts SwimLane and
  // the ResizeObserver can measure a real height. The IO callback
  // fires synchronously on the initial layout pass and downgrades
  // off-screen rows to the placeholder on the next commit.
  const [isIntersecting, setIsIntersecting] = useState(true);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);

  useEffect(() => {
    if (!hasIO) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          setIsIntersecting(entry.isIntersecting);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasIO]);

  useEffect(() => {
    if (!hasRO) return;
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const h = el.getBoundingClientRect().height;
      if (h <= 0) return;
      setMeasuredHeight((prev) => (prev === h ? prev : h));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasRO]);

  // Only swap in the placeholder once we have both a confirmed
  // off-screen state AND a measured height. Otherwise we'd either
  // flash a zero-height row (if measuredHeight is null) or
  // virtualize a still-visible row (if IO hasn't run yet).
  const virtualize = hasIO && !isIntersecting && measuredHeight != null;

  if (virtualize) {
    return (
      <div
        ref={ref}
        data-testid="virtualized-placeholder"
        data-flavor={props.flavor}
        aria-hidden="true"
        style={{ height: measuredHeight ?? FALLBACK_ROW_HEIGHT }}
      />
    );
  }

  return (
    <div ref={ref} data-flavor={props.flavor}>
      <SwimLane {...props} />
    </div>
  );
}
