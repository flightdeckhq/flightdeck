import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Nav } from "../App";
import { THEME_STORAGE_KEY } from "@/lib/constants";

function renderNav(theme: "dark" | "light") {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Nav onSearchClick={() => {}} />
    </MemoryRouter>,
  );
}

describe("Nav lockup", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
  });

  it.each([
    ["dark" as const, "/assets/flightdeck-lockup-dark.svg"],
    ["light" as const, "/assets/flightdeck-lockup-light.svg"],
  ])("renders the %s lockup linked to Fleet", (theme, expectedSrc) => {
    renderNav(theme);

    const lockup = screen.getByTestId("nav-lockup") as HTMLImageElement;
    expect(lockup).toBeInTheDocument();
    expect(lockup.getAttribute("src")).toBe(expectedSrc);
    expect(lockup.getAttribute("alt")).toBe("Flightdeck");

    const link = screen.getByTestId("nav-lockup-link") as HTMLAnchorElement;
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe("/");
    expect(link.getAttribute("aria-label")).toBe("Flightdeck, go to Fleet");
    expect(link).toContainElement(lockup);
  });
});
