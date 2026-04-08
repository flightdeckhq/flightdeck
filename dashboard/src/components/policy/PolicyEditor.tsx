import { useState, useEffect } from "react";
import type { Policy, PolicyRequest } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface PolicyEditorProps {
  policy?: Policy;
  onSave: (data: PolicyRequest) => Promise<void>;
  onCancel: () => void;
}

type Scope = "org" | "flavor" | "session";

function numOrNull(value: string): number | null {
  if (value === "") return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function strOrEmpty(value: number | null | undefined): string {
  return value == null ? "" : String(value);
}

export function PolicyEditor({ policy, onSave, onCancel }: PolicyEditorProps) {
  const [scope, setScope] = useState<Scope>(policy?.scope ?? "org");
  const [scopeValue, setScopeValue] = useState(policy?.scope_value ?? "");
  const [tokenLimit, setTokenLimit] = useState(strOrEmpty(policy?.token_limit));
  const [warnAtPct, setWarnAtPct] = useState(strOrEmpty(policy?.warn_at_pct));
  const [degradeAtPct, setDegradeAtPct] = useState(strOrEmpty(policy?.degrade_at_pct));
  const [degradeTo, setDegradeTo] = useState(policy?.degrade_to ?? "");
  const [blockAtPct, setBlockAtPct] = useState(strOrEmpty(policy?.block_at_pct));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (scope === "org") setScopeValue("");
  }, [scope]);

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};

    if (!scope) {
      e.scope = "Scope is required";
    }

    if ((scope === "flavor" || scope === "session") && !scopeValue.trim()) {
      e.scope_value = "Scope value is required for this scope";
    }

    const warn = numOrNull(warnAtPct);
    const degrade = numOrNull(degradeAtPct);
    const block = numOrNull(blockAtPct);

    if (warn != null && degrade != null && warn >= degrade) {
      e.warn_at_pct = "Warn % must be less than degrade %";
    }

    if (degrade != null && block != null && degrade > block) {
      e.degrade_at_pct = "Degrade % must be ≤ block %";
    }

    if (warn != null && block != null && warn >= block) {
      e.warn_at_pct = e.warn_at_pct ?? "Warn % must be less than block %";
    }

    return e;
  }

  async function handleSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    const errs = validate();
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    const data: PolicyRequest = {
      scope,
      scope_value: scope === "org" ? "" : scopeValue.trim(),
      token_limit: numOrNull(tokenLimit),
      warn_at_pct: numOrNull(warnAtPct),
      degrade_at_pct: numOrNull(degradeAtPct),
      degrade_to: degradeTo.trim() || null,
      block_at_pct: numOrNull(blockAtPct),
    };

    setSaving(true);
    try {
      await onSave(data);
    } finally {
      setSaving(false);
    }
  }

  const inputClass =
    "h-8 w-full rounded-md border border-border bg-surface px-3 py-1 text-xs text-text placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50";

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-text">Scope</label>
        <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="org">org</SelectItem>
            <SelectItem value="flavor">flavor</SelectItem>
            <SelectItem value="session">session</SelectItem>
          </SelectContent>
        </Select>
        {errors.scope && <p className="mt-1 text-xs text-danger">{errors.scope}</p>}
      </div>

      {(scope === "flavor" || scope === "session") && (
        <div>
          <label className="mb-1 block text-xs font-medium text-text">Scope value</label>
          <input
            type="text"
            className={inputClass}
            value={scopeValue}
            onChange={(e) => setScopeValue(e.target.value)}
            placeholder={scope === "flavor" ? "e.g. research-agent" : "e.g. session UUID"}
          />
          {errors.scope_value && (
            <p className="mt-1 text-xs text-danger">{errors.scope_value}</p>
          )}
        </div>
      )}

      <div>
        <label className="mb-1 block text-xs font-medium text-text">Token limit</label>
        <input
          type="number"
          className={inputClass}
          value={tokenLimit}
          onChange={(e) => setTokenLimit(e.target.value)}
          placeholder="Optional"
          min={0}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-text">Warn at %</label>
          <input
            type="number"
            className={inputClass}
            value={warnAtPct}
            onChange={(e) => setWarnAtPct(e.target.value)}
            placeholder="1-99"
            min={1}
            max={99}
          />
          {errors.warn_at_pct && (
            <p className="mt-1 text-xs text-danger">{errors.warn_at_pct}</p>
          )}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-text">Block at %</label>
          <input
            type="number"
            className={inputClass}
            value={blockAtPct}
            onChange={(e) => setBlockAtPct(e.target.value)}
            placeholder="1-100"
            min={1}
            max={100}
          />
          {errors.block_at_pct && (
            <p className="mt-1 text-xs text-danger">{errors.block_at_pct}</p>
          )}
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium text-text">Degrade at %</label>
        <input
          type="number"
          className={inputClass}
          value={degradeAtPct}
          onChange={(e) => setDegradeAtPct(e.target.value)}
          placeholder="1-99"
          min={1}
          max={99}
        />
        {errors.degrade_at_pct && (
          <p className="mt-1 text-xs text-danger">{errors.degrade_at_pct}</p>
        )}
      </div>

      {degradeAtPct !== "" && (
        <div>
          <label className="mb-1 block text-xs font-medium text-text">Degrade to model</label>
          <input
            type="text"
            className={inputClass}
            value={degradeTo}
            onChange={(e) => setDegradeTo(e.target.value)}
            placeholder="e.g. claude-haiku-4-5-20251001"
          />
        </div>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : policy ? "Update" : "Create"}
        </Button>
      </div>
    </form>
  );
}
