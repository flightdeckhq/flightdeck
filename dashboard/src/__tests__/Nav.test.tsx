import "@testing-library/jest-dom/vitest";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Nav } from "../App";
import { LOCKUP_SRC, THEME_STORAGE_KEY } from "@/lib/constants";

function renderNav(theme: "dark" | "light") {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Nav onSearchClick={() => {}} />
    </MemoryRouter>,
  );
}

describe("Nav lockup", () => {
  // ``cleanup`` is auto-called by Vitest when ``globals: true`` is
  // set in vitest.config.ts; the explicit call lives in afterEach
  // (not beforeEach) so it tears down the prior test's DOM rather
  // than the empty DOM at the next test's start. ``localStorage``
  // is reset alongside.
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it.each([
    ["dark" as const, LOCKUP_SRC.dark],
    ["light" as const, LOCKUP_SRC.light],
  ])("renders the %s lockup linked to Fleet", (theme, expectedSrc) => {
    renderNav(theme);

    const lockup = screen.getByTestId("nav-lockup") as HTMLImageElement;
    expect(lockup).toBeInTheDocument();
    expect(lockup.getAttribute("src")).toBe(expectedSrc);
    // The img is intentionally decorative — the link's aria-label
    // carries the accessible name. ``alt=""`` is the correct
    // semantic value for a logo whose meaning is fully conveyed by
    // the surrounding link's label.
    expect(lockup.getAttribute("alt")).toBe("");

    const link = screen.getByTestId("nav-lockup-link") as HTMLAnchorElement;
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe("/");
    expect(link.getAttribute("aria-label")).toBe("Flightdeck, go to Fleet");
    expect(link).toContainElement(lockup);
  });
});
