import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface TokenUsageBarProps {
  tokensUsed: number;
  tokenLimit: number | null;
  warn_at_pct?: number | null;
  degrade_at_pct?: number | null;
  block_at_pct?: number | null;
}

interface MarkerDef {
  pct: number;
  label: string;
  color: string;
}

function ThresholdMarker({ pct, label, color }: MarkerDef) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className="absolute top-0 h-full w-0.5"
            style={{ left: `${pct}%`, backgroundColor: `var(${color})` }}
            data-testid={`marker-${label.toLowerCase().replace(/\s+/g, "-")}`}
          />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function TokenUsageBar({
  tokensUsed,
  tokenLimit,
  warn_at_pct,
  degrade_at_pct,
  block_at_pct,
}: TokenUsageBarProps) {
  if (tokenLimit == null || tokenLimit <= 0) {
    return (
      <div className="text-xs text-text-muted">
        {tokensUsed.toLocaleString()} tokens (no limit)
      </div>
    );
  }

  const pct = Math.min((tokensUsed / tokenLimit) * 100, 100);
  const barColor =
    pct >= 90 ? "bg-danger" : pct >= 70 ? "bg-warning" : "bg-primary";

  const markers: MarkerDef[] = [];
  if (warn_at_pct != null) {
    markers.push({ pct: warn_at_pct, label: `Warn at ${warn_at_pct}%`, color: "--color-warn" });
  }
  if (degrade_at_pct != null) {
    markers.push({ pct: degrade_at_pct, label: `Degrade at ${degrade_at_pct}%`, color: "--color-degrade" });
  }
  if (block_at_pct != null) {
    markers.push({ pct: block_at_pct, label: `Block at ${block_at_pct}%`, color: "--color-block" });
  }

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span>{tokensUsed.toLocaleString()} / {tokenLimit.toLocaleString()}</span>
        <span className="text-text-muted">{pct.toFixed(0)}%</span>
      </div>
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
        {markers.map((m) => (
          <ThresholdMarker key={m.label} {...m} />
        ))}
      </div>
    </div>
  );
}
