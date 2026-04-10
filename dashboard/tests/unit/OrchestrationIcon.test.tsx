import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
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
