import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DateRangePicker } from "@/components/ui/DateRangePicker";

const defaultValue = { from: new Date("2026-04-05"), to: new Date("2026-04-12") };

describe("DateRangePicker", () => {
  it("renders all preset buttons", () => {
    render(<DateRangePicker value={defaultValue} onChange={vi.fn()} />);

    expect(screen.getByTestId("preset-today")).toBeInTheDocument();
    expect(screen.getByTestId("preset-yesterday")).toBeInTheDocument();
    expect(screen.getByTestId("preset-last7days")).toBeInTheDocument();
    expect(screen.getByTestId("preset-last30days")).toBeInTheDocument();
    expect(screen.getByTestId("preset-last90days")).toBeInTheDocument();
    expect(screen.getByTestId("preset-custom")).toBeInTheDocument();
  });

  it("fires onChange with correct range when Last 7 days is clicked", () => {
    const onChange = vi.fn();
    render(<DateRangePicker value={defaultValue} onChange={onChange} />);

    fireEvent.click(screen.getByTestId("preset-last7days"));

    expect(onChange).toHaveBeenCalledTimes(1);
    const call = onChange.mock.calls[0][0];
    expect(call.preset).toBe("last7days");
    expect(call.from).toBeInstanceOf(Date);
    expect(call.to).toBeInstanceOf(Date);
    // Range should be approximately 7 days
    const diffMs = call.to.getTime() - call.from.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(6.9);
    expect(diffDays).toBeLessThanOrEqual(7.1);
  });

  it("shows custom date inputs when Custom is clicked", () => {
    render(<DateRangePicker value={defaultValue} onChange={vi.fn()} />);

    // Custom inputs should not be visible initially
    expect(screen.queryByTestId("custom-inputs")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("preset-custom"));

    expect(screen.getByTestId("custom-inputs")).toBeInTheDocument();
    expect(screen.getByTestId("custom-from")).toBeInTheDocument();
    expect(screen.getByTestId("custom-to")).toBeInTheDocument();
  });

  it("fires onChange when both custom dates are set", () => {
    const onChange = vi.fn();
    render(<DateRangePicker value={defaultValue} onChange={onChange} />);

    fireEvent.click(screen.getByTestId("preset-custom"));

    const fromInput = screen.getByTestId("custom-from") as HTMLInputElement;
    const toInput = screen.getByTestId("custom-to") as HTMLInputElement;

    fireEvent.change(fromInput, { target: { value: "2026-04-01T00:00" } });
    // onChange should NOT fire yet (only from is set)
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(toInput, { target: { value: "2026-04-10T23:59" } });
    // Now both are set -- onChange should fire with preset: null
    expect(onChange).toHaveBeenCalledTimes(1);
    const call = onChange.mock.calls[0][0];
    expect(call.preset).toBeNull();
    expect(call.from).toBeInstanceOf(Date);
    expect(call.to).toBeInstanceOf(Date);
  });

  it("collapses custom inputs when a preset is clicked after custom", () => {
    render(<DateRangePicker value={defaultValue} onChange={vi.fn()} />);

    // Open custom
    fireEvent.click(screen.getByTestId("preset-custom"));
    expect(screen.getByTestId("custom-inputs")).toBeInTheDocument();

    // Click a preset
    fireEvent.click(screen.getByTestId("preset-last30days"));

    // Custom inputs should be gone
    expect(screen.queryByTestId("custom-inputs")).not.toBeInTheDocument();
  });
});
