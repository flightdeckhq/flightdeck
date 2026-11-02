/**
 * DirectiveCard — renders a single custom directive with its
 * parameter inputs and a "Run" button. Used in two places:
 *
 * 1. The session drawer's Directives tab -- targets one run
 *    (`sessionId` prop).
 * 2. The Fleet sidebar agent row's Directives dialog -- targets the
 *    agent's live runs under the directive's own flavor (`agentId`
 *    prop). The API picks the runs, including ones the page has not
 *    loaded, and the card names how many it reached.
 *
 * Both call sites share the parameter-input rendering and the trigger
 * API path; each owns its own loading and empty handling.
 */

import { useState } from "react";
import type {
  CustomDirective,
  CustomDirectiveParameter,
} from "@/lib/types";
import { triggerCustomDirective } from "@/lib/api";
import { SUCCESS_MESSAGE_DISPLAY_MS } from "@/lib/constants";
import { runCountLabel } from "@/lib/directives";
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
  /** Targets this one run (the run drawer). Wins over the others. */
  sessionId?: string | null;
  /**
   * Targets every live run of this agent that runs custom handlers
   * under the directive's own flavor (the Fleet row). The request
   * carries that flavor, so a run of the agent under another flavor
   * that registered the same handler is not reached, and neither is
   * another agent's run that shares the flavor.
   */
  agentId?: string | null;
  /**
   * With neither of the above, the Run button reaches every live run
   * of this flavor. Defaults to the directive's own registered flavor.
   */
  flavor?: string | null;
}

export function DirectiveCard({
  directive,
  sessionId,
  agentId,
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
  // Confirmation shown after a send: for an agent, how many runs the
  // API reached.
  const [sentMessage, setSentMessage] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function updateParam(name: string, value: unknown) {
    setParams((prev) => ({ ...prev, [name]: value }));
  }

  async function handleRun() {
    setSubmitting(true);
    setSubmitError(null);
    // One run; else the agent's live runs of the directive's own flavor;
    // else every live run of a flavor.
    const target = sessionId
      ? { session_id: sessionId }
      : agentId
        ? { agent_id: agentId, flavor: directive.flavor }
        : { flavor: flavor ?? directive.flavor };
    try {
      const { count } = await triggerCustomDirective({
        action: "custom",
        directive_name: directive.name,
        fingerprint: directive.fingerprint,
        ...target,
        parameters:
          directive.parameters.length > 0 ? params : undefined,
      });
      setSentMessage(
        sessionId || count === null
          ? "Directive sent"
          : `Directive sent to ${runCountLabel(count)}`,
      );
      setTimeout(() => setSentMessage(null), SUCCESS_MESSAGE_DISPLAY_MS);
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
              ? "Trigger on this run"
              : agentId
                ? "Trigger on this agent's runs"
                : "Trigger on all active"}
        </Button>
        {sentMessage !== null && (
          <span
            role="status"
            data-testid={`directive-sent-${directive.name}`}
            className="text-[11px] text-success"
          >
            {sentMessage}
          </span>
        )}
        {submitError && (
          <span
            role="alert"
            data-testid={`directive-error-${directive.name}`}
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
        <span className="text-(--danger)"> *</span>
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
          className="accent-(--primary)"
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
          className="w-full rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text focus:outline-hidden focus:ring-1 focus:ring-(--primary)"
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
          className="w-full rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text focus:outline-hidden focus:ring-1 focus:ring-(--primary)"
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
        className="w-full rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text focus:outline-hidden focus:ring-1 focus:ring-(--primary)"
      />
    </div>
  );
}
