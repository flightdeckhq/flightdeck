import { useState, useEffect, useCallback } from "react";
import type { CustomDirective, CustomDirectiveParameter } from "@/lib/types";
import { fetchCustomDirectives, triggerCustomDirective } from "@/lib/api";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

interface DirectivesPanelProps {
  flavorFilter: string | null;
  selectedSessionId: string | null;
}

export function DirectivesPanel({ flavorFilter, selectedSessionId }: DirectivesPanelProps) {
  const [directives, setDirectives] = useState<CustomDirective[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchCustomDirectives(flavorFilter ?? undefined);
      setDirectives(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [flavorFilter]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <Card>
        <CardHeader className="px-2 py-1.5">
          <CardTitle className="text-[11px]">Custom Directives</CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-2">
          <div className="py-4 text-center text-xs text-text-muted">Loading...</div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader className="px-2 py-1.5">
          <CardTitle className="text-[11px]">Custom Directives</CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-2">
          <div className="py-4 text-center text-xs text-[var(--danger)]">{error}</div>
        </CardContent>
      </Card>
    );
  }

  if (directives.length === 0) {
    return (
      <Card>
        <CardHeader className="px-2 py-1.5">
          <CardTitle className="text-[11px]">Custom Directives</CardTitle>
        </CardHeader>
        <CardContent className="px-2 pb-2">
          <div className="py-4 text-center text-xs text-text-muted">
            No custom directives registered for this fleet.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="px-2 py-1.5">
        <CardTitle className="text-[11px]">Custom Directives</CardTitle>
      </CardHeader>
      <CardContent className="px-2 pb-2">
        <div className="space-y-2">
          {directives.map((d) => (
            <DirectiveCard
              key={d.id}
              directive={d}
              selectedSessionId={selectedSessionId}
              flavorFilter={flavorFilter}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function DirectiveCard({
  directive,
  selectedSessionId,
  flavorFilter,
}: {
  directive: CustomDirective;
  selectedSessionId: string | null;
  flavorFilter: string | null;
}) {
  const [params, setParams] = useState<Record<string, unknown>>(() => {
    const defaults: Record<string, unknown> = {};
    for (const p of directive.parameters) {
      if (p.default !== undefined && p.default !== null) {
        defaults[p.name] = p.default;
      } else if (p.type === "boolean") {
        defaults[p.name] = false;
      } else {
        defaults[p.name] = "";
      }
    }
    return defaults;
  });
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function updateParam(name: string, value: unknown) {
    setParams((prev) => ({ ...prev, [name]: value }));
  }

  async function handleRun() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await triggerCustomDirective({
        action: "custom",
        directive_name: directive.name,
        fingerprint: directive.fingerprint,
        session_id: selectedSessionId ?? undefined,
        flavor: flavorFilter ?? directive.flavor,
        parameters: directive.parameters.length > 0 ? params : undefined,
      });
      setSent(true);
      setTimeout(() => setSent(false), 2000);
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded border border-border p-2 space-y-1.5">
      <div>
        <div className="text-[11px] font-semibold text-text">{directive.name}</div>
        {directive.description && (
          <div className="text-[10px] text-text-muted">{directive.description}</div>
        )}
      </div>

      {directive.parameters.map((p) => (
        <ParameterField
          key={p.name}
          param={p}
          value={params[p.name]}
          onChange={(v) => updateParam(p.name, v)}
        />
      ))}

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-5 px-2 text-[10px]"
          onClick={handleRun}
          disabled={submitting}
        >
          {submitting ? "Sending..." : "Run"}
        </Button>
        {sent && <span className="text-[10px] text-success">Directive sent</span>}
        {submitError && (
          <span className="text-[10px] text-[var(--danger)]">{submitError}</span>
        )}
      </div>
    </div>
  );
}

function ParameterField({
  param,
  value,
  onChange,
}: {
  param: CustomDirectiveParameter;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = (
    <label className="text-[10px] text-text-muted block mb-0.5">
      {param.name}
      {param.required && <span className="text-[var(--danger)]"> *</span>}
    </label>
  );

  if (param.type === "boolean") {
    return (
      <div className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-[var(--primary)]"
          aria-label={param.name}
        />
        <span className="text-[10px] text-text-muted">{param.name}</span>
      </div>
    );
  }

  if (param.type === "string" && param.options && param.options.length > 0) {
    return (
      <div>
        {label}
        <Select
          value={String(value ?? "")}
          onValueChange={(v) => onChange(v)}
        >
          <SelectTrigger className="h-6 text-[10px]">
            <SelectValue placeholder={`Select ${param.name}`} />
          </SelectTrigger>
          <SelectContent>
            {param.options.map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  if (param.type === "integer") {
    return (
      <div>
        {label}
        <input
          type="number"
          step={1}
          value={value === "" ? "" : Number(value)}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          placeholder={param.description || param.name}
          aria-label={param.name}
          className="w-full rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
        />
      </div>
    );
  }

  if (param.type === "float") {
    return (
      <div>
        {label}
        <input
          type="number"
          step={0.01}
          value={value === "" ? "" : Number(value)}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          placeholder={param.description || param.name}
          aria-label={param.name}
          className="w-full rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
        />
      </div>
    );
  }

  // Default: string without options -> text input
  return (
    <div>
      {label}
      <input
        type="text"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        placeholder={param.description || param.name}
        aria-label={param.name}
        className="w-full rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] text-text focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
      />
    </div>
  );
}
