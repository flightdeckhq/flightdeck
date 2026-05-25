import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../table";

describe("table primitive", () => {
  it("renders the table/thead/tbody/tr/th/td chain", () => {
    render(
      <Table data-testid="t">
        <TableHeader>
          <TableRow>
            <TableHead data-testid="th-a">Tokens</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow data-testid="row">
            <TableCell data-testid="td-a">42</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const t = screen.getByTestId("t");
    expect(t.tagName).toBe("TABLE");
    expect(t.querySelector("thead")).not.toBeNull();
    expect(t.querySelector("tbody")).not.toBeNull();
    expect(screen.getByTestId("th-a").tagName).toBe("TH");
    expect(screen.getByTestId("td-a").tagName).toBe("TD");
  });

  it("applies the canonical header class signature to TableHead", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead data-testid="th">Time</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const th = screen.getByTestId("th");
    const cls = th.className;
    // The 11-px / semibold / uppercase / tracking / muted-text /
    // padding / whitespace contract every header cell shares.
    expect(cls).toContain("text-[11px]");
    expect(cls).toContain("font-semibold");
    expect(cls).toContain("uppercase");
    expect(cls).toContain("tracking-[0.06em]");
    expect(cls).toContain("text-text-secondary");
    expect(cls).toContain("px-3");
    expect(cls).toContain("py-2");
    expect(cls).toContain("whitespace-nowrap");
    // Default scope is "col".
    expect(th.getAttribute("scope")).toBe("col");
  });

  it("applies the canonical body class signature to TableCell", () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell data-testid="td">name</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const cls = screen.getByTestId("td").className;
    expect(cls).toContain("text-[12px]");
    expect(cls).toContain("align-middle");
    expect(cls).toContain("px-3");
    expect(cls).toContain("py-2");
    expect(cls).not.toContain("font-mono");
    // TableCell defaults to explicit text-left so behaviour mirrors
    // TableHead and doesn't rely on native <td> inherit.
    expect(cls).toContain("text-left");
  });

  it("defaults TableHead to text-left so headers sit above left-aligned values (not native <th> center)", () => {
    // Native <th> default is text-align:center per HTML spec; without
    // an explicit text-left the header label floats off the left
    // edge of the column above its left-aligned values. Lock the
    // explicit default and the override hierarchy: exactly one of
    // text-{left,center,right} lands on the element so Tailwind
    // class ordering is not relied on as a tie-breaker.
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead data-testid="th-default">Default</TableHead>
            <TableHead align="right" data-testid="th-right">Right</TableHead>
            <TableHead align="center" data-testid="th-center">Center</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const def = screen.getByTestId("th-default").className;
    expect(def).toContain("text-left");
    expect(def).not.toContain("text-right");
    expect(def).not.toContain("text-center");
    const right = screen.getByTestId("th-right").className;
    expect(right).toContain("text-right");
    expect(right).not.toContain("text-left");
    const center = screen.getByTestId("th-center").className;
    expect(center).toContain("text-center");
    expect(center).not.toContain("text-left");
  });

  it("`mono` prop adds font-mono to TableCell", () => {
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell mono data-testid="td">
              1,234
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByTestId("td").className).toContain("font-mono");
  });

  it("`align=right` on TableHead and TableCell flips text alignment and drops the text-left default", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead align="right" data-testid="th">
              Cost
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell align="right" data-testid="td">
              $1.23
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const th = screen.getByTestId("th").className;
    expect(th).toContain("text-right");
    expect(th).not.toContain("text-left");
    const td = screen.getByTestId("td").className;
    expect(td).toContain("text-right");
    expect(td).not.toContain("text-left");
  });

  it("`interactive` body TableRow adds hover + cursor classes", () => {
    render(
      <Table>
        <TableBody>
          <TableRow interactive data-testid="row">
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const cls = screen.getByTestId("row").className;
    expect(cls).toContain("hover:bg-surface-hover");
    expect(cls).toContain("cursor-pointer");
    expect(cls).toContain("border-b");
    expect(cls).toContain("border-border-subtle");
  });

  it("non-interactive body TableRow still picks up the border but no hover", () => {
    render(
      <Table>
        <TableBody>
          <TableRow data-testid="row">
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const cls = screen.getByTestId("row").className;
    expect(cls).toContain("border-border-subtle");
    expect(cls).not.toContain("hover:bg-surface-hover");
    expect(cls).not.toContain("cursor-pointer");
  });

  it("header-context TableRow picks up border-border + bg-surface", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow data-testid="row">
            <TableHead>Time</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const cls = screen.getByTestId("row").className;
    expect(cls).toContain("border-border");
    expect(cls).not.toContain("border-border-subtle");
    expect(cls).toContain("bg-surface");
  });

  it("`scope=\"row\"` overrides the \"col\" default on TableHead", () => {
    // Regression lock for the previous double-set trap where
    // TableHead set ``scope={props.scope ?? "col"}`` then spread
    // ``{...props}`` again. React silently dropped undefined from
    // the spread so the "col" default worked, but an explicit
    // ``scope="row"`` from a caller wrote the attribute twice and
    // depended on spread ordering. The fix destructures ``scope``
    // out of props; this test confirms the override path lands.
    render(
      <Table>
        <TableBody>
          <TableRow>
            <TableHead scope="row" data-testid="th">
              Row label
            </TableHead>
          </TableRow>
        </TableBody>
      </Table>,
    );
    expect(screen.getByTestId("th").getAttribute("scope")).toBe("row");
  });

  it("`align` prop does not leak the deprecated HTML align attribute to the DOM", () => {
    // The native HTML ``align`` attribute on ``<th>`` / ``<td>`` was
    // deprecated in HTML4 and is presentational. The primitive's
    // ``align`` prop drives a Tailwind text-align utility via
    // ``alignClass()``; the DOM element should NOT carry the raw
    // attribute. Locks the contract: callers see Tailwind classes,
    // never the deprecated HTML attribute.
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead align="right" data-testid="th">
              Cost
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell align="center" data-testid="td">
              42
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const th = screen.getByTestId("th");
    const td = screen.getByTestId("td");
    expect(th.className).toContain("text-right");
    expect(th.getAttribute("align")).toBeNull();
    expect(td.className).toContain("text-center");
    expect(td.getAttribute("align")).toBeNull();
  });

  it("forwards arbitrary props (data-*, aria-*, onClick) to the underlying elements", () => {
    render(
      <Table>
        <TableBody>
          <TableRow
            data-testid="row"
            data-agent-id="a-1"
            aria-label="row label"
          >
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const row = screen.getByTestId("row");
    expect(row.getAttribute("data-agent-id")).toBe("a-1");
    expect(row.getAttribute("aria-label")).toBe("row label");
  });
});
