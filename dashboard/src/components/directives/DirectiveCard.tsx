/**
 * DirectiveCard — renders a single custom directive with its
 * parameter inputs and a "Run" button. Used in two places:
 *
 * 1. The session drawer's Directives tab -- targets a specific
 *    session_id (`sessionId` prop).
 * 2. The FleetPanel flavor-row Directives dialog -- targets the
 *    entire flavor's active sessions (`flavor` prop, no sessionId).
 *
 * Extracted from the old DirectivesPanel so both call sites share
 * the same parameter-input rendering and trigger API path. The
 * original panel wrapper (header + loading / error / empty state)
 * is gone; both consumers now own their own loading / empty
 * handling.
 */

import { useState } from "react";
import type {
  CustomDirective,
  CustomDirectiveParameter,
} from "@/lib/types";
import { triggerCustomDirective } from "@/lib/api";
import { SUCCESS_MESSAGE_DISPLAY_MS } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";

interface DirectiveCardProps {
  directive: CustomDirective;
  /**
   * When set, the Run button targets this specific session id.
   * Mutually exclusive with `flavor` in practice: the session drawer
   * passes sessionId; the flavor-level dialog passes flavor only.
   */
  sessionId?: string | null;
  /**
   * When set and sessionId is not, the Run button fans out to all
   * active sessions of this flavor via the POST /v1/directives
   * endpoint. Defaults to the directive's own registered flavor.
   */
  flavor?: string | null;
}

export function DirectiveCard({
  directive,
  sessionId,
  flavor,
}: DirectiveCardProps) {
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
        session_id: sessionId ?? undefined,
        flavor: sessionId ? undefined : flavor ?? directive.flavor,
        parameters:
          directive.parameters.length > 0 ? params : undefined,
      });
      setSent(true);
      setTimeout(() => setSent(false), SUCCESS_MESSAGE_DISPLAY_MS);
    } catch (e) {
      setSubmitError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      data-testid={`directive-card-${directive.name}`}
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 6,
        padding: "10px 12px",
        marginBottom: 8,
      }}
    >
      <div
        style={{
          fontSize: 13,
          fontFamily: "var(--font-mono)",
          fontWeight: 600,
          color: "var(--accent)",
          marginBottom: 4,
        }}
      >
        {directive.name}
      </div>
      {directive.description && (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-secondary)",
            marginBottom: 8,
          }}
        >
          {directive.description}
        </div>
      )}

      {directive.parameters.map((p) => (
        <ParameterField
          key={p.name}
          param={p}
          value={params[p.name]}
          onChange={(v) => updateParam(p.name, v)}
        />
      ))}

      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          className="h-6 px-2 text-[11px]"
          onClick={handleRun}
          disabled={submitting}
          data-testid={`directive-run-${directive.name}`}
        >
          {submitting
            ? "Sending..."
            : sessionId
              ? "Trigger on this session"
              : "Trigger on all active"}
        </Button>
        {sent && (
          <span className="text-[11px] text-success">
            Directive sent
          </span>
        )}
        {submitError && (
          <span
            className="text-[11px]"
            style={{ color: "var(--danger)" }}
          >
            {submitError}
          </span>
        )}
      </div>
    </div>
  );
}

export function ParameterField({
  param,
  value,
  onChange,
}: {
  param: CustomDirectiveParameter;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = (
    <label className="text-[11px] text-text-muted block mb-0.5">
      {param.name}
      {param.required && (
        <span className="text-[var(--danger)]"> *</span>
      )}
    </label>
  );

  if (param.type === "boolean") {
    return (
      <div className="flex items-center gap-1.5 mb-1.5">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-[var(--primary)]"
          aria-label={param.name}
        />
        <span className="text-[11px] text-text-muted">{param.name}</span>
      </div>
    );
  }

  if (
    param.type === "string" &&
    param.options &&
    param.options.length > 0
  ) {
    return (
      <div className="mb-1.5">
        {label}
        <Select
          value={String(value ?? "")}
          onValueChange={(v) => onChange(v)}
        >
          <SelectTrigger className="h-6 text-[11px]">
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
      <div className="mb-1.5">
        {label}
        <input
          type="number"
          step={1}
          value={value === "" ? "" : Number(value)}
          onChange={(e) =>
            onChange(e.target.value === "" ? "" : Number(e.target.value))
          }
          placeholder={param.description || param.name}
          aria-label={param.name}
          className="w-full rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
        />
      </div>
    );
  }

  if (param.type === "float") {
    return (
      <div className="mb-1.5">
        {label}
        <input
          type="number"
          step={0.01}
          value={value === "" ? "" : Number(value)}
          onChange={(e) =>
            onChange(e.target.value === "" ? "" : Number(e.target.value))
          }
          placeholder={param.description || param.name}
          aria-label={param.name}
          className="w-full rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
        />
      </div>
    );
  }

  // Default: string without options -> text input
  return (
    <div className="mb-1.5">
      {label}
      <input
        type="text"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        placeholder={param.description || param.name}
        aria-label={param.name}
        className="w-full rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
      />
    </div>
  );
}
