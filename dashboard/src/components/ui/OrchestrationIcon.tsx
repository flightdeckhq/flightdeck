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
    // Helm-wheel: outer ring, inner hub, six spokes.
    return (
      <svg {...common} viewBox="0 0 14 14" fill="currentColor">
        <circle cx="7" cy="7" r="2" />
        <circle
          cx="7"
          cy="7"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
        />
        <line x1="7" y1="1" x2="7" y2="4" stroke="currentColor" strokeWidth="1.2" />
        <line x1="7" y1="10" x2="7" y2="13" stroke="currentColor" strokeWidth="1.2" />
        <line x1="1.8" y1="3.8" x2="4.2" y2="5.2" stroke="currentColor" strokeWidth="1.2" />
        <line x1="9.8" y1="8.8" x2="12.2" y2="10.2" stroke="currentColor" strokeWidth="1.2" />
        <line x1="1.8" y1="10.2" x2="4.2" y2="8.8" stroke="currentColor" strokeWidth="1.2" />
        <line x1="9.8" y1="5.2" x2="12.2" y2="3.8" stroke="currentColor" strokeWidth="1.2" />
      </svg>
    );
  }

  if (orchestration === "docker" || orchestration === "docker-compose") {
    // Three stacked containers. The whale is too detailed at 12px.
    // docker-compose reuses the same icon -- the tooltip distinguishes.
    return (
      <svg {...common} viewBox="0 0 14 14" fill="currentColor">
        <rect x="2" y="2" width="10" height="3" rx="1" />
        <rect x="2" y="6" width="10" height="3" rx="1" />
        <rect x="2" y="10" width="10" height="3" rx="1" />
      </svg>
    );
  }

  if (orchestration === "aws-ecs") {
    // AWS-style hexagon.
    return (
      <svg {...common} viewBox="0 0 14 14" fill="currentColor">
        <polygon points="7,1 12,3.5 12,8.5 7,11 2,8.5 2,3.5" />
      </svg>
    );
  }

  // cloud-run: simple cloud silhouette.
  return (
    <svg {...common} viewBox="0 0 14 14" fill="currentColor">
      <path d="M11 9H3.5C2.1 9 1 7.9 1 6.5C1 5.2 2 4.2 3.3 4C3.6 2.8 4.7 2 6 2C7.6 2 8.9 3.2 9 4.8C10.1 4.9 11 5.8 11 7V9Z" />
    </svg>
  );
}
