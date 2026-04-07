interface TokenUsageBarProps {
  tokensUsed: number;
  tokenLimit: number | null;
}

export function TokenUsageBar({ tokensUsed, tokenLimit }: TokenUsageBarProps) {
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

  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span>{tokensUsed.toLocaleString()} / {tokenLimit.toLocaleString()}</span>
        <span className="text-text-muted">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
        <div
          className={`h-full rounded-full transition-all ${barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
