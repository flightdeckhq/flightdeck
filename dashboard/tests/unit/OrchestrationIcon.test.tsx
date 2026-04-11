import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  siDocker,
  siGooglecloud,
  siKubernetes,
} from "simple-icons";
import {
  OrchestrationIcon,
  getOrchestrationLabel,
} from "@/components/ui/OrchestrationIcon";

describe("OrchestrationIcon", () => {
  it("renders an SVG for kubernetes", () => {
    render(<OrchestrationIcon orchestration="kubernetes" />);
    expect(screen.getByTestId("orch-icon-kubernetes")).toBeInTheDocument();
  });

  it("renders an SVG for docker", () => {
    render(<OrchestrationIcon orchestration="docker" />);
    expect(screen.getByTestId("orch-icon-docker")).toBeInTheDocument();
  });

  it("renders the same shape for docker-compose as docker", () => {
    // docker-compose deliberately reuses the docker container icon --
    // the tooltip distinguishes the two. Verify the testid still
    // identifies the variant for selectors.
    render(<OrchestrationIcon orchestration="docker-compose" />);
    expect(screen.getByTestId("orch-icon-docker-compose")).toBeInTheDocument();
  });

  it("renders an SVG for aws-ecs", () => {
    render(<OrchestrationIcon orchestration="aws-ecs" />);
    expect(screen.getByTestId("orch-icon-aws-ecs")).toBeInTheDocument();
  });

  it("renders an SVG for cloud-run", () => {
    render(<OrchestrationIcon orchestration="cloud-run" />);
    expect(screen.getByTestId("orch-icon-cloud-run")).toBeInTheDocument();
  });

  it("renders nothing for unknown orchestration strings", () => {
    const { container } = render(
      <OrchestrationIcon orchestration="nomad" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when orchestration is undefined", () => {
    const { container } = render(<OrchestrationIcon orchestration={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it("respects the size prop", () => {
    render(<OrchestrationIcon orchestration="kubernetes" size={20} />);
    const svg = screen.getByTestId("orch-icon-kubernetes");
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("height")).toBe("20");
  });

  it("kubernetes uses the exact siKubernetes path from simple-icons", () => {
    render(<OrchestrationIcon orchestration="kubernetes" />);
    const svg = screen.getByTestId("orch-icon-kubernetes");
    const path = svg.querySelector("path");
    expect(path).not.toBeNull();
    expect(path!.getAttribute("d")).toBe(siKubernetes.path);
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("docker uses the exact siDocker path from simple-icons", () => {
    render(<OrchestrationIcon orchestration="docker" />);
    const svg = screen.getByTestId("orch-icon-docker");
    const path = svg.querySelector("path");
    expect(path).not.toBeNull();
    expect(path!.getAttribute("d")).toBe(siDocker.path);
  });

  it("docker-compose reuses the siDocker path", () => {
    render(<OrchestrationIcon orchestration="docker-compose" />);
    const svg = screen.getByTestId("orch-icon-docker-compose");
    const path = svg.querySelector("path");
    expect(path).not.toBeNull();
    expect(path!.getAttribute("d")).toBe(siDocker.path);
  });

  it("cloud-run uses the siGooglecloud path as the closest GCP fit", () => {
    render(<OrchestrationIcon orchestration="cloud-run" />);
    const svg = screen.getByTestId("orch-icon-cloud-run");
    const path = svg.querySelector("path");
    expect(path).not.toBeNull();
    expect(path!.getAttribute("d")).toBe(siGooglecloud.path);
  });

  it("aws-ecs renders the hand-crafted hexagon fallback", () => {
    // AWS ECS is NOT in simple-icons. Verify the fallback SVG still
    // renders at its original 14x14 viewBox with a single polygon
    // (the hexagon) rather than a <path>.
    render(<OrchestrationIcon orchestration="aws-ecs" />);
    const svg = screen.getByTestId("orch-icon-aws-ecs");
    expect(svg.getAttribute("viewBox")).toBe("0 0 14 14");
    expect(svg.querySelector("polygon")).not.toBeNull();
    // AWS ECS fallback uses <polygon>, not <path>.
    expect(svg.querySelector("path")).toBeNull();
  });
});

describe("getOrchestrationLabel", () => {
  it("translates kebab-case keys to display labels", () => {
    expect(getOrchestrationLabel("kubernetes")).toBe("Kubernetes");
    expect(getOrchestrationLabel("docker-compose")).toBe("Docker Compose");
    expect(getOrchestrationLabel("docker")).toBe("Docker");
    expect(getOrchestrationLabel("aws-ecs")).toBe("AWS ECS");
    expect(getOrchestrationLabel("cloud-run")).toBe("Google Cloud Run");
  });

  it("returns the input unchanged for unknown keys", () => {
    expect(getOrchestrationLabel("nomad")).toBe("nomad");
  });
});
