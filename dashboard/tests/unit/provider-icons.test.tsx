import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { PROVIDER_ICONS } from "@/components/ui/provider-icons";
import { ProviderLogo } from "@/components/ui/provider-logo";

describe("provider icons", () => {
  it("has a brand mark for every provider simple-icons covers", () => {
    for (const p of ["anthropic", "openai", "google", "mistral", "meta", "deepseek"] as const) {
      expect(PROVIDER_ICONS[p]?.path, p).toBeTruthy();
    }
  });

  it("renders the DeepSeek mark with its label", () => {
    const { container } = render(<ProviderLogo provider="deepseek" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-label", "DeepSeek");
    expect(svg.querySelector("path")).not.toBeNull();
  });
});
