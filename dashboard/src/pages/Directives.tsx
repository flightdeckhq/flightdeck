import { useState, useEffect, useCallback, useMemo } from "react";
import type { CustomDirective, CustomDirectiveParameter } from "@/lib/types";
import { fetchCustomDirectives, fetchFlavors, triggerCustomDirective } from "@/lib/api";
import { useFleetStore } from "@/store/fleet";
import { truncateSessionId } from "@/lib/events";
import { formatRelativeTime } from "@/lib/time";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { ChevronDown, ChevronRight } from "lucide-react";

const CODE_SNIPPET = `@flightdeck_sensor.directive(
    name="my_action",
    description="What this does",
)
def my_action(context):
    return {"status": "done"}

flightdeck_sensor.init(
    server="...", token="...")`;

export function Directives() {
  const [directives, setDirectives] = useState<CustomDirective[]>([]);
  const [flavors, setFlavors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flavorFilter, setFlavorFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");

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
    void load();
  }, [load]);

  useEffect(() => {
    void fetchFlavors()
      .then(setFlavors)
      .catch(() => {});
  }, []);

  const filtered = search
    ? directives.filter((d) => d.name.toLowerCase().includes(search.toLowerCase()))
    : directives;

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-1">
        <h1 className="text-xl font-semibold text-text">Custom Directives</h1>
        <p className="text-xs text-text-muted">
          Functions registered by agents and callable from the dashboard
        </p>
      </div>

      <div className="mb-4 mt-4 flex items-center gap-3">
        <Select
          value={flavorFilter ?? "__all__"}
          onValueChange={(v) => setFlavorFilter(v === "__all__" ? null : v)}
        >
          <SelectTrigger
            className="w-48"
            style={{
              height: 32,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--surface)",
              padding: "6px 10px",
              fontSize: 13,
              color: "var(--text)",
            }}
          >
            <SelectValue placeholder="All Agents" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All Agents</SelectItem>
            {flavors.map((f) => (
              <SelectItem key={f} value={f}>
                {f}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search directives..."
          aria-label="Search directives"
          style={{
            height: 32,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--surface)",
            padding: "6px 10px",
            fontSize: 13,
            color: "var(--text)",
          }}
          className="placeholder:text-text-muted focus:outline-none focus:border-[var(--primary)]"
        />
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-[var(--danger)]">
          {error}
          <Button size="sm" className="ml-2 h-5 px-2 text-[11px]" onClick={load}>
            Retry
          </Button>
        </div>
      )}

      {loading && (
        <div className="py-12 text-center text-sm text-text-muted">Loading directives...</div>
      )}

      {!loading && !error && filtered.length === 0 && directives.length === 0 && (
        <div className="py-12 text-center">
          <p className="mb-4 text-sm text-text-muted">
            No custom directives registered yet. Add @flightdeck_sensor.directive() to your agent
            code and call init() to register directives here.
          </p>
          <pre className="mx-auto inline-block rounded border border-border bg-surface-hover p-4 text-left text-xs text-text">
            {CODE_SNIPPET}
          </pre>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && directives.length > 0 && (
        <div className="py-12 text-center text-sm text-text-muted">
          No directives match &quot;{search}&quot;
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map((d) => (
            <DirectiveCard key={d.id} directive={d} />
          ))}
        </div>
      )}
    </div>
  );
}

function DirectiveCard({ directive }: { directive: CustomDirective }) {
  const { flavors } = useFleetStore();
  const [paramsOpen, setParamsOpen] = useState(false);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [targetMode, setTargetMode] = useState<"session" | "flavor">("flavor");
  const [sessionId, setSessionId] = useState("");

  // Sessions of this directive's flavor for targeting indicators
  const flavorSessions = useMemo(() => {
    const result: { session_id: string; state: string }[] = [];
    for (const f of flavors) {
      if (f.flavor === directive.flavor) {
        for (const s of f.sessions) {
          if (s.state === "active" || s.state === "idle") {
            result.push({ session_id: s.session_id, state: s.state });
          }
        }
      }
    }
    return result;
  }, [flavors, directive.flavor]);

  const isRecentlyRegistered = directive.last_seen_at &&
    Date.now() - new Date(directive.last_seen_at).getTime() < 10 * 60 * 1000;
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
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  function updateParam(name: string, value: unknown) {
    setParams((prev) => ({ ...prev, [name]: value }));
  }

  async function handleSubmit() {
    setSubmitting(true);
    setResult(null);
    try {
      const target =
        targetMode === "session" && sessionId
          ? { session_id: sessionId, flavor: directive.flavor }
          : { flavor: directive.flavor };
      await triggerCustomDirective({
        action: "custom",
        directive_name: directive.name,
        fingerprint: directive.fingerprint,
        ...target,
        parameters: directive.parameters.length > 0 ? params : undefined,
      });
      const label =
        targetMode === "session" && sessionId
          ? `session ${sessionId}`
          : `all ${directive.flavor} sessions`;
      setResult({ ok: true, message: `Directive sent to ${label}. Results will appear in the session timeline.` });
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-sm font-bold">{directive.name}</CardTitle>
          {directive.description && (
            <p className="mt-0.5 text-xs text-text-muted">{directive.description}</p>
          )}
        </div>
        <Badge>{directive.flavor}</Badge>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4 text-[11px] text-text-muted">
          <span>Last seen: {formatRelativeTime(directive.last_seen_at)}</span>
          <span>
            Registered: {new Date(directive.registered_at).toLocaleDateString()}
          </span>
        </div>

        {directive.parameters.length > 0 && (
          <button
            className="mt-2 flex items-center gap-1 text-[11px] text-text-muted hover:text-text"
            onClick={() => setParamsOpen(!paramsOpen)}
          >
            {paramsOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Parameters ({directive.parameters.length})
          </button>
        )}

        {paramsOpen && (
          <div className="mt-1.5 space-y-1 rounded border border-border p-2">
            {directive.parameters.map((p) => (
              <div key={p.name} className="text-[11px]">
                <span className="font-mono font-semibold text-text">{p.name}</span>
                <span className="ml-1 text-text-muted">({p.type})</span>
                {p.required && (
                  <span className="ml-1 text-[var(--danger)]">required</span>
                )}
                {p.description && (
                  <span className="ml-1 text-text-muted">— {p.description}</span>
                )}
                {p.options && p.options.length > 0 && (
                  <span className="ml-1 text-text-muted">
                    options: {p.options.join(", ")}
                  </span>
                )}
                {p.default !== null && p.default !== undefined && (
                  <span className="ml-1 text-text-muted">
                    default: {String(p.default)}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mt-3">
          {!triggerOpen ? (
            <Button
              size="sm"
              className="h-6 px-3 text-[11px]"
              onClick={() => setTriggerOpen(true)}
            >
              Trigger
            </Button>
          ) : (
            <div className="space-y-2 rounded border border-border p-2">
              <div className="flex items-center gap-2">
                <label className="text-[11px] text-text-muted">Target:</label>
                <Select
                  value={targetMode}
                  onValueChange={(v) => setTargetMode(v as "session" | "flavor")}
                >
                  <SelectTrigger className="h-6 w-40 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="flavor">
                      All {directive.flavor} sessions
                    </SelectItem>
                    <SelectItem value="session">Specific session</SelectItem>
                  </SelectContent>
                </Select>
                {targetMode === "session" && (
                  <input
                    type="text"
                    value={sessionId}
                    onChange={(e) => setSessionId(e.target.value)}
                    placeholder="Session ID"
                    aria-label="Session ID"
                    className="h-6 rounded border border-border bg-surface px-1.5 text-[11px] text-text focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
                  />
                )}
              </div>

              {/* Targeting indicators */}
              {targetMode === "flavor" && (
                <div className="text-[11px]" style={{ color: "var(--text-muted)" }} data-testid="flavor-disclaimer">
                  Sessions running older code may skip this directive.
                </div>
              )}
              {targetMode === "session" && flavorSessions.length > 0 && (
                <div className="space-y-0.5">
                  {flavorSessions.map((s) => (
                    <div key={s.session_id} className="flex items-center gap-1.5 text-[11px]">
                      <span
                        className="inline-block rounded-full"
                        style={{
                          width: 6,
                          height: 6,
                          background: isRecentlyRegistered
                            ? "var(--status-active)"
                            : "var(--status-idle)",
                          flexShrink: 0,
                        }}
                        data-testid="session-status-dot"
                      />
                      <span className="font-mono" style={{ color: "var(--text-secondary)" }}>
                        {truncateSessionId(s.session_id)}
                      </span>
                      <span style={{ color: isRecentlyRegistered ? "var(--status-active)" : "var(--status-idle)" }}>
                        {isRecentlyRegistered ? "registered" : "may not respond"}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {directive.parameters.length > 0 && (
                <div className="space-y-1.5">
                  {directive.parameters.map((p) => (
                    <ParamInput
                      key={p.name}
                      param={p}
                      value={params[p.name]}
                      onChange={(v) => updateParam(p.name, v)}
                    />
                  ))}
                </div>
              )}

              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-6 px-3 text-[11px]"
                  onClick={handleSubmit}
                  disabled={submitting}
                >
                  {submitting ? "Sending..." : "Send Directive"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => {
                    setTriggerOpen(false);
                    setResult(null);
                  }}
                >
                  Cancel
                </Button>
              </div>

              {result && (
                <div
                  className={`text-[11px] ${result.ok ? "text-success" : "text-[var(--danger)]"}`}
                >
                  {result.message}
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ParamInput({
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
        <span className="text-[11px] text-text-muted">{param.name}</span>
      </div>
    );
  }

  if (param.type === "string" && param.options && param.options.length > 0) {
    return (
      <div>
        {label}
        <Select value={String(value ?? "")} onValueChange={(v) => onChange(v)}>
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

  if (param.type === "integer" || param.type === "float") {
    return (
      <div>
        {label}
        <input
          type="number"
          step={param.type === "integer" ? 1 : 0.01}
          value={value === "" ? "" : Number(value)}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
          placeholder={param.description || param.name}
          aria-label={param.name}
          className="w-full rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
        />
      </div>
    );
  }

  return (
    <div>
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
