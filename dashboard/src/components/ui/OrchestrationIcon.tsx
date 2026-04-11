/**
 * OrchestrationIcon — small inline-SVG glyph for the runtime
 * orchestration platform a session is running under. Mirrors the
 * shape and rendering contract of OSIcon: returns null for unknown
 * values, fixed brand-adjacent colors via inline style, designed for
 * 12-14px placements next to hostnames.
 *
 * Kubernetes, Docker, docker-compose, and cloud-run all use the
 * official brand paths from `simple-icons`. AWS ECS is not in
 * simple-icons (the package has no per-service AWS icons), so it
 * falls back to a hand-crafted hexagon that matches AWS's own
 * service-icon glyph style.
 */

import {
  siDocker,
  siGooglecloud,
  siKubernetes,
} from "simple-icons";
import { SimpleIconSvg } from "./OSIcon";

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

  if (orchestration === "kubernetes") {
    return (
      <SimpleIconSvg
        path={siKubernetes.path}
        size={size}
        color={color}
        title={siKubernetes.title}
        className={className}
        testId="orch-icon-kubernetes"
      />
    );
  }

  if (orchestration === "docker" || orchestration === "docker-compose") {
    // docker-compose reuses the siDocker glyph -- the tooltip at the
    // call site distinguishes which variant is in use.
    return (
      <SimpleIconSvg
        path={siDocker.path}
        size={size}
        color={color}
        title={
          orchestration === "docker-compose" ? "Docker Compose" : siDocker.title
        }
        className={className}
        testId={`orch-icon-${orchestration}`}
      />
    );
  }

  if (orchestration === "cloud-run") {
    // Google Cloud Run does not have its own simple-icons entry; the
    // parent Google Cloud brand logo is the closest legitimate fit.
    return (
      <SimpleIconSvg
        path={siGooglecloud.path}
        size={size}
        color={color}
        title="Google Cloud Run"
        className={className}
        testId="orch-icon-cloud-run"
      />
    );
  }

  // AWS ECS: not in simple-icons. Hexagon matches AWS service icon
  // style. viewBox stays 14x14 for this fallback since the path is
  // authored to that coordinate space.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill={color}
      className={className}
      style={{
        color,
        display: "inline-block",
        verticalAlign: "middle",
        flexShrink: 0,
      }}
      role="img"
      aria-label="AWS ECS"
      data-testid="orch-icon-aws-ecs"
    >
      <title>AWS ECS</title>
      <polygon points="7,1 12,3.8 12,9.2 7,12 2,9.2 2,3.8" />
    </svg>
  );
}
