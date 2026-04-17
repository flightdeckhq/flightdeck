export const ANTHROPIC_MODELS = new Set([
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  "claude-3-opus-20240229",
]);

export const OPENAI_MODELS = new Set([
  "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
  "gpt-5.2", "gpt-5", "gpt-5-mini", "gpt-5-nano",
  "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
  "gpt-4o", "gpt-4o-mini", "gpt-4-turbo",
  "o4-mini", "o3", "o3-pro", "o3-mini", "o1", "o1-mini",
]);

export const ANTHROPIC_MODEL_LIST = [...ANTHROPIC_MODELS];
export const OPENAI_MODEL_LIST = [...OPENAI_MODELS];
export const ALL_MODELS = [...ANTHROPIC_MODEL_LIST, ...OPENAI_MODEL_LIST];

export type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "mistral"
  | "meta"
  | "other"
  | "unknown";

export function getProvider(model: string | null | undefined): Provider {
  if (!model) return "unknown";
  if (ANTHROPIC_MODELS.has(model)) return "anthropic";
  if (OPENAI_MODELS.has(model)) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4") ||
    model.startsWith("text-embedding-") ||
    model.startsWith("dall-e-")
  ) {
    return "openai";
  }
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("grok-")) return "xai";
  if (model.startsWith("mistral-") || model.startsWith("mixtral-")) return "mistral";
  if (model.startsWith("llama-")) return "meta";
  return "other";
}

/** Provider metadata used across every UI surface that displays a
 *  provider name: charts, tooltips, legends, summary cards. Keep the
 *  color column in sync with the SQL CASE expression in
 *  api/internal/store/analytics.go (D098); label is always the
 *  brand-capitalised form rather than the lowercase key.
 *
 *  The single map replaces a previous PROVIDER_COLOR lookup + ad-hoc
 *  label capitalisation scattered across chart components. Consumers
 *  should read PROVIDER_META[provider].label / .color, and the
 *  PROVIDER_COLOR alias below is kept as a drop-in for code that only
 *  needs the color (StackedSeriesChart etc.). */
export interface ProviderMeta {
  label: string;
  color: string;
}

export const PROVIDER_META: Record<Provider, ProviderMeta> = {
  anthropic: { label: "Anthropic", color: "var(--accent)" },
  openai: { label: "OpenAI", color: "var(--chart-openai)" },
  google: { label: "Google", color: "var(--chart-google)" },
  xai: { label: "xAI", color: "var(--chart-xai)" },
  mistral: { label: "Mistral", color: "var(--chart-mistral)" },
  meta: { label: "Meta", color: "var(--chart-meta)" },
  other: { label: "Other", color: "var(--text-muted)" },
  unknown: { label: "Unknown", color: "var(--text-muted)" },
};

/** Legacy alias: PROVIDER_COLOR[p] === PROVIDER_META[p].color. Kept so
 *  callers that only need the color stay short, and so existing
 *  imports don't have to change. */
export const PROVIDER_COLOR: Record<Provider, string> = Object.fromEntries(
  (Object.entries(PROVIDER_META) as [Provider, ProviderMeta][]).map(
    ([k, v]) => [k, v.color],
  ),
) as Record<Provider, string>;

/** Resolve an arbitrary dimension string (from analytics series) to a
 *  human-readable provider label, falling back to the raw string if it
 *  does not match a known provider. */
export function providerLabel(dimension: string): string {
  if (dimension in PROVIDER_META) {
    return PROVIDER_META[dimension as Provider].label;
  }
  return dimension;
}
