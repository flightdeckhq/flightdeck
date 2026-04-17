import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

export const DIMENSIONS = [
  { value: "flavor", label: "Agent" },
  { value: "model", label: "Model" },
  { value: "framework", label: "Framework" },
  { value: "host", label: "Host" },
  { value: "agent_type", label: "Agent Type" },
  { value: "team", label: "Team" },
] as const;

/** Resolve a group_by value to the human-readable label used in the
 *  picker, for chart titles that want to reflect the live selection
 *  (e.g. ``Avg Latency by Model``). Falls back to the raw value when
 *  a caller passes a dimension the picker doesn't know about. */
export function dimensionLabel(value: string): string {
  const match = DIMENSIONS.find((d) => d.value === value);
  return match ? match.label : value;
}

interface DimensionPickerProps {
  value: string;
  onGroupByChange: (value: string) => void;
}

export function DimensionPicker({ value, onGroupByChange }: DimensionPickerProps) {
  return (
    <Select value={value} onValueChange={onGroupByChange}>
      <SelectTrigger className="w-[140px]">
        <SelectValue placeholder="Group by" />
      </SelectTrigger>
      <SelectContent>
        {DIMENSIONS.map((dim) => (
          <SelectItem key={dim.value} value={dim.value}>
            {dim.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
