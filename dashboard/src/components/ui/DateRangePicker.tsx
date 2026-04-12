import { useState, useCallback } from "react";
import { cn } from "@/lib/utils";

export interface DateRange {
  from: Date;
  to: Date;
}

export interface DateRangeWithPreset extends DateRange {
  preset: string | null;
}

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (range: DateRangeWithPreset) => void;
  defaultPreset?: string;
}

interface PresetDef {
  key: string;
  label: string;
  range: () => DateRange;
}

const PRESETS: PresetDef[] = [
  {
    key: "today",
    label: "Today",
    range: () => {
      const now = new Date();
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      return { from: start, to: now };
    },
  },
  {
    key: "yesterday",
    label: "Yesterday",
    range: () => {
      const now = new Date();
      const start = new Date(now);
      start.setDate(start.getDate() - 1);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      return { from: start, to: end };
    },
  },
  {
    key: "last7days",
    label: "Last 7 days",
    range: () => {
      const now = new Date();
      const start = new Date(now);
      start.setDate(start.getDate() - 7);
      return { from: start, to: now };
    },
  },
  {
    key: "last30days",
    label: "Last 30 days",
    range: () => {
      const now = new Date();
      const start = new Date(now);
      start.setDate(start.getDate() - 30);
      return { from: start, to: now };
    },
  },
  {
    key: "last90days",
    label: "Last 90 days",
    range: () => {
      const now = new Date();
      const start = new Date(now);
      start.setDate(start.getDate() - 90);
      return { from: start, to: now };
    },
  },
];

export function DateRangePicker({
  value: _value,
  onChange,
  defaultPreset = "last7days",
}: DateRangePickerProps) {
  const [activePreset, setActivePreset] = useState<string | null>(
    defaultPreset
  );
  const [showCustom, setShowCustom] = useState(false);
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const handlePresetClick = useCallback(
    (preset: PresetDef) => {
      setActivePreset(preset.key);
      setShowCustom(false);
      setCustomFrom("");
      setCustomTo("");
      const range = preset.range();
      onChange({ ...range, preset: preset.key });
    },
    [onChange]
  );

  const handleCustomClick = useCallback(() => {
    setActivePreset(null);
    setShowCustom(true);
  }, []);

  const handleCustomDateChange = useCallback(
    (from: string, to: string) => {
      if (from && to) {
        const fromDate = new Date(from);
        const toDate = new Date(to);
        if (!isNaN(fromDate.getTime()) && !isNaN(toDate.getTime()) && fromDate <= toDate) {
          setActivePreset(null);
          onChange({ from: fromDate, to: toDate, preset: null });
        }
      }
    },
    [onChange]
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1 flex-wrap">
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            data-testid={`preset-${preset.key}`}
            onClick={() => handlePresetClick(preset)}
            className={cn(
              "px-3 py-1 rounded-md text-xs font-medium transition-colors",
              activePreset === preset.key
                ? "bg-primary text-white"
                : "bg-surface border border-border text-text-secondary hover:bg-surface-hover"
            )}
          >
            {preset.label}
          </button>
        ))}
        <button
          data-testid="preset-custom"
          onClick={handleCustomClick}
          className={cn(
            "px-3 py-1 rounded-md text-xs font-medium transition-colors",
            showCustom && activePreset === null
              ? "bg-primary text-white"
              : "bg-surface border border-border text-text-secondary hover:bg-surface-hover"
          )}
        >
          Custom
        </button>
      </div>

      {showCustom && (
        <div className="flex items-center gap-2" data-testid="custom-inputs">
          <input
            type="datetime-local"
            data-testid="custom-from"
            value={customFrom}
            onChange={(e) => {
              setCustomFrom(e.target.value);
              handleCustomDateChange(e.target.value, customTo);
            }}
            className="h-7 rounded-md border border-border bg-surface px-2 text-xs text-text focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <span className="text-xs text-text-muted">to</span>
          <input
            type="datetime-local"
            data-testid="custom-to"
            value={customTo}
            onChange={(e) => {
              setCustomTo(e.target.value);
              handleCustomDateChange(customFrom, e.target.value);
            }}
            className="h-7 rounded-md border border-border bg-surface px-2 text-xs text-text focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      )}
    </div>
  );
}
