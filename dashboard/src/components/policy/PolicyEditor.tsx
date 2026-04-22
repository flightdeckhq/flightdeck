import { useState, useEffect, useMemo } from "react";
import type { Policy, PolicyRequest } from "@/lib/types";
import { useFleetStore } from "@/store/fleet";
import { truncateSessionId } from "@/lib/events";
import { ALL_MODELS as ALL_MODELS_LIST, getProvider } from "@/lib/models";
import { POLICY_SCOPE_LABELS, type PolicyScope } from "@/lib/policy-scope-labels";
import { ProviderLogo } from "@/components/ui/provider-logo";
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

type Scope = PolicyScope;

const SCOPE_LABELS = POLICY_SCOPE_LABELS;

// Model lists imported from @/lib/models

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
  const [customFlavorInput, setCustomFlavorInput] = useState(false);
  const [customModelInput, setCustomModelInput] = useState(false);

  const { flavors } = useFleetStore();

  // Collect distinct models from fleet store for "in use" group
  const inUseModels = useMemo(() => {
    const models = new Set<string>();
    const targetFlavors = scope === "flavor" && scopeValue
      ? flavors.filter((f) => f.flavor === scopeValue)
      : flavors;
    for (const f of targetFlavors) {
      for (const s of f.sessions) {
        if (s.model) models.add(s.model);
      }
    }
    return [...models].sort();
  }, [flavors, scope, scopeValue]);

  // Active/idle sessions for session scope dropdown
  const activeSessions = useMemo(() => {
    const result: { session_id: string; flavor: string; state: string; model: string | null }[] = [];
    for (const f of flavors) {
      for (const s of f.sessions) {
        if (s.state === "active" || s.state === "idle") {
          result.push({ session_id: s.session_id, flavor: s.flavor, state: s.state, model: s.model });
        }
      }
    }
    return result;
  }, [flavors]);

  // Flavor list from fleet store
  const flavorNames = useMemo(() => flavors.map((f) => f.flavor), [flavors]);

  useEffect(() => {
    if (scope === "org") setScopeValue("");
  }, [scope]);

  function validate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (!scope) e.scope = "Scope is required";
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
      {/* Scope */}
      <div>
        <label className="mb-1 block text-xs font-medium text-text">Scope</label>
        <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="org">{SCOPE_LABELS.org}</SelectItem>
            <SelectItem value="flavor">{SCOPE_LABELS.flavor}</SelectItem>
            <SelectItem value="session">{SCOPE_LABELS.session}</SelectItem>
          </SelectContent>
        </Select>
        {errors.scope && <p className="mt-1 text-xs text-danger">{errors.scope}</p>}
      </div>

      {/* Scope value — Flavor */}
      {scope === "flavor" && (
        <div>
          <label className="mb-1 block text-xs font-medium text-text">Agent</label>
          {!customFlavorInput && flavorNames.length > 0 ? (
            <>
              <Select
                value={scopeValue}
                onValueChange={(v) => {
                  if (v === "__custom__") {
                    setCustomFlavorInput(true);
                    setScopeValue("");
                  } else {
                    setScopeValue(v);
                  }
                }}
              >
                <SelectTrigger className="w-full" data-testid="flavor-dropdown">
                  <SelectValue placeholder="Select agent" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="*">* (all agents)</SelectItem>
                  {flavorNames.map((f) => (
                    <SelectItem key={f} value={f}>{f}</SelectItem>
                  ))}
                  <SelectItem value="__custom__">Custom...</SelectItem>
                </SelectContent>
              </Select>
            </>
          ) : (
            <>
              <input
                type="text"
                className={inputClass}
                value={scopeValue}
                onChange={(e) => setScopeValue(e.target.value)}
                placeholder="Enter agent name"
              />
              {flavorNames.length > 0 && (
                <button
                  type="button"
                  className="mt-1 text-xs"
                  style={{ color: "var(--accent)" }}
                  onClick={() => { setCustomFlavorInput(false); setScopeValue(""); }}
                >
                  ← back to dropdown
                </button>
              )}
            </>
          )}
          {errors.scope_value && (
            <p className="mt-1 text-xs text-danger">{errors.scope_value}</p>
          )}
        </div>
      )}

      {/* Scope value — Session */}
      {scope === "session" && (
        <div>
          <label className="mb-1 block text-xs font-medium text-text">Session</label>
          {activeSessions.length > 0 && (
            <Select
              value={scopeValue}
              onValueChange={setScopeValue}
            >
              <SelectTrigger className="w-full" data-testid="session-dropdown">
                <SelectValue placeholder="Select session" />
              </SelectTrigger>
              <SelectContent>
                {activeSessions.map((s) => (
                  <SelectItem key={s.session_id} value={s.session_id}>
                    <span className="font-mono text-xs">{truncateSessionId(s.session_id)}</span>
                    <span className="ml-1" style={{ color: "var(--text-muted)" }}>·</span>
                    <span className="ml-1">{s.flavor}</span>
                    <span className="ml-1" style={{ color: "var(--text-muted)" }}>·</span>
                    <span className="ml-1" style={{ color: s.state === "active" ? "var(--status-active)" : "var(--status-idle)" }}>
                      {s.state}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="mt-1.5">
            <label className="mb-0.5 block text-[11px] text-text-muted">Or enter session ID directly</label>
            <input
              type="text"
              className={inputClass}
              value={scopeValue}
              onChange={(e) => setScopeValue(e.target.value)}
              placeholder="Enter session ID"
            />
          </div>
          {errors.scope_value && (
            <p className="mt-1 text-xs text-danger">{errors.scope_value}</p>
          )}
        </div>
      )}

      {/* Token limit */}
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

      {/* Warn / Block */}
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

      {/* Degrade at % */}
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

      {/* Degrade to model — structured dropdown */}
      {degradeAtPct !== "" && (
        <div>
          <label className="mb-1 block text-xs font-medium text-text">Downgrade to model</label>
          {!customModelInput ? (
            <>
              <div
                className="max-h-48 overflow-y-auto rounded-md border border-border bg-surface"
                data-testid="model-dropdown"
              >
                {/* In use group */}
                {inUseModels.length > 0 && (
                  <>
                    <div
                      className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      In use in this scope
                    </div>
                    {inUseModels.map((m) => (
                      <button
                        key={`inuse-${m}`}
                        type="button"
                        className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left font-mono text-[13px] transition-colors hover:bg-surface-hover"
                        style={{ color: degradeTo === m ? "var(--text)" : "var(--text-secondary)" }}
                        onClick={() => setDegradeTo(m)}
                      >
                        <span
                          className="inline-block rounded-full"
                          style={{ width: 6, height: 6, background: "var(--status-active)", flexShrink: 0 }}
                          data-testid="in-use-dot"
                        />
                        <ProviderLogo provider={getProvider(m)} size={12} />
                        {m}
                      </button>
                    ))}
                  </>
                )}

                {/* All models group */}
                <div
                  className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
                  style={{ color: "var(--text-muted)" }}
                >
                  All models
                </div>
                {ALL_MODELS_LIST.filter((m) => !inUseModels.includes(m)).map((m) => (
                  <button
                    key={m}
                    type="button"
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left font-mono text-[13px] transition-colors hover:bg-surface-hover"
                    style={{ color: degradeTo === m ? "var(--text)" : "var(--text-secondary)" }}
                    onClick={() => setDegradeTo(m)}
                  >
                    <ProviderLogo provider={getProvider(m)} size={12} />
                    {m}
                  </button>
                ))}

                {/* Custom */}
                <button
                  type="button"
                  className="w-full px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-surface-hover"
                  style={{ color: "var(--accent)", borderTop: "1px solid var(--border-subtle)" }}
                  onClick={() => setCustomModelInput(true)}
                >
                  Or enter model name directly →
                </button>
              </div>
              {degradeTo && (
                <p className="mt-1 text-[11px] font-mono" style={{ color: "var(--text-secondary)" }}>
                  Selected: {degradeTo}
                </p>
              )}
            </>
          ) : (
            <>
              <input
                type="text"
                className={inputClass}
                value={degradeTo}
                onChange={(e) => setDegradeTo(e.target.value)}
                placeholder="e.g. claude-haiku-4-5-20251001"
              />
              <button
                type="button"
                className="mt-1 text-xs"
                style={{ color: "var(--accent)" }}
                onClick={() => setCustomModelInput(false)}
              >
                ← back to model list
              </button>
            </>
          )}
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
