import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

const DIMENSIONS = [
  { value: "flavor", label: "Flavor" },
  { value: "model", label: "Model" },
  { value: "framework", label: "Framework" },
  { value: "host", label: "Host" },
  { value: "agent_type", label: "Agent Type" },
  { value: "team", label: "Team" },
] as const;

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
