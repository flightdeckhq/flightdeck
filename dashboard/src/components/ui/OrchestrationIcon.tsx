/**
 * OrchestrationIcon — small inline-SVG glyph for the runtime
 * orchestration platform a session is running under. Mirrors the
 * shape and rendering contract of OSIcon: returns null for unknown
 * values, fixed brand-adjacent colors via inline style, designed for
 * 12-14px placements next to hostnames.
 *
 * Both icons are intentionally separate so a session can render zero,
 * one, or both side-by-side depending on what context is available
 * (e.g., a Linux pod in Kubernetes shows both; a bare-metal Mac
 * developer laptop shows only OSIcon).
 */

interface OrchestrationIconProps {
  orchestration?: string | null;
  size?: number;
  className?: string;
}

export const ORCHESTRATION_LABELS: Record<string, string> = {
  kubernetes: "Kubernetes",
  "docker-compose": "Docker Compose",
  docker: "Docker",
  "aws-ecs": "AWS ECS",
  "cloud-run": "Google Cloud Run",
};

const ORCHESTRATION_COLORS: Record<string, string> = {
  kubernetes: "#326CE5",
  docker: "#2496ED",
  "docker-compose": "#2496ED",
  "aws-ecs": "#FF9900",
  "cloud-run": "#4285F4",
};

export function getOrchestrationLabel(orchestration: string): string {
  return ORCHESTRATION_LABELS[orchestration] ?? orchestration;
}

export function OrchestrationIcon({
  orchestration,
  size = 14,
  className,
}: OrchestrationIconProps) {
  if (!orchestration) return null;
  const color = ORCHESTRATION_COLORS[orchestration];
  if (!color) return null;

  const common = {
    width: size,
    height: size,
    className,
    style: {
      color,
      display: "inline-block",
      verticalAlign: "middle",
      flexShrink: 0,
    } as const,
    "data-testid": `orch-icon-${orchestration}`,
  };

  if (orchestration === "kubernetes") {
    // Helm wheel: outer ring, solid hub, six radial spokes. Stroke-
    // based so currentColor paints the line art.
    return (
      <svg
        {...common}
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      >
        <circle cx="7" cy="7" r="5.5" />
        <circle cx="7" cy="7" r="1.5" fill="currentColor" />
        <line x1="7" y1="1.5" x2="7" y2="4" />
        <line x1="7" y1="10" x2="7" y2="12.5" />
        <line x1="2" y1="4.2" x2="4.2" y2="5.5" />
        <line x1="9.8" y1="8.5" x2="12" y2="9.8" />
        <line x1="2" y1="9.8" x2="4.2" y2="8.5" />
        <line x1="9.8" y1="5.5" x2="12" y2="4.2" />
      </svg>
    );
  }

  if (orchestration === "docker" || orchestration === "docker-compose") {
    // Six-container pyramid stack: 3 bottom + 2 middle + 1 top.
    // docker-compose reuses the same icon -- the tooltip distinguishes.
    return (
      <svg {...common} viewBox="0 0 14 14" fill="currentColor">
        <rect x="1" y="4" width="3" height="2.5" rx="0.4" />
        <rect x="5" y="4" width="3" height="2.5" rx="0.4" />
        <rect x="9" y="4" width="3" height="2.5" rx="0.4" />
        <rect x="3" y="7" width="3" height="2.5" rx="0.4" />
        <rect x="7" y="7" width="3" height="2.5" rx="0.4" />
        <rect x="5" y="10" width="3" height="2" rx="0.4" />
      </svg>
    );
  }

  if (orchestration === "aws-ecs") {
    // AWS-style hexagon.
    return (
      <svg {...common} viewBox="0 0 14 14" fill="currentColor">
        <polygon points="7,1 12,3.8 12,9.2 7,12 2,9.2 2,3.8" />
      </svg>
    );
  }

  // cloud-run: cloud silhouette.
  return (
    <svg {...common} viewBox="0 0 14 14" fill="currentColor">
      <path d="M10.5 10H3.5 C2 10 1 8.9 1 7.5 C1 6.2 2 5.2 3.3 5 C3.7 3.5 5 2.5 6.5 2.5 C8.3 2.5 9.8 3.8 10 5.5 C11.2 5.7 12 6.7 12 8 C12 9.1 11.4 10 10.5 10Z" />
    </svg>
  );
}
