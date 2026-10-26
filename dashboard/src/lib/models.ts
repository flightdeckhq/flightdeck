export type Provider =
  | "anthropic"
  | "openai"
  | "google"
  | "xai"
  | "mistral"
  | "meta"
  | "deepseek"
  | "other"
  | "unknown";

// The provider rule below mirrors modelid.Provider in the api and
// workers modules (api/internal/modelid/canonical.go); a Vitest parity
// test reads the same vectors file the Go twins do, so the dashboard
// cannot drift from the provider the API groups analytics by.

/** OpenAI model families, by id prefix. */
const OPENAI_MODEL =
  /^(gpt-|chatgpt-|o[1-9](-|$)|codex-|text-embedding-|dall-e-|gpt-image-|whisper-|tts-|omni-moderation)/;

/** Vendor prefix of a Bedrock id that keeps it ("meta.llama3-..."). */
const BEDROCK_VENDORS: Record<string, Provider> = {
  anthropic: "anthropic",
  meta: "meta",
  mistral: "mistral",
  deepseek: "deepseek",
  openai: "openai",
  amazon: "other",
  cohere: "other",
  ai21: "other",
  qwen: "other",
  writer: "other",
};

const MISTRAL_PREFIXES = [
  "mistral", "mixtral", "codestral", "ministral", "pixtral",
  "magistral", "devstral", "open-mistral", "open-mixtral",
];

/** The provider of a model id, by the same rule the API applies to
 *  canonical ids (events store the canonical id in ``model``). */
export function getProvider(model: string | null | undefined): Provider {
  if (!model) return "unknown";
  const id = model.trim().toLowerCase();
  if (id.startsWith("ft:")) return getProvider(id.slice(3));
  const dot = id.indexOf(".");
  if (dot > 0) {
    const vendor = BEDROCK_VENDORS[id.slice(0, dot)];
    if (vendor) return vendor;
  }
  if (id.startsWith("claude")) return "anthropic";
  if (OPENAI_MODEL.test(id)) return "openai";
  if (id.startsWith("gemini") || id.startsWith("gemma")) return "google";
  if (id.startsWith("grok")) return "xai";
  if (MISTRAL_PREFIXES.some((p) => id.startsWith(p))) return "mistral";
  if (id.startsWith("llama")) return "meta";
  if (id.startsWith("deepseek")) return "deepseek";
  return "other";
}

/** Provider metadata used across every UI surface that displays a
 *  provider name: charts, tooltips, legends, summary cards. Keep the
 *  color column in sync with the SQL CASE expression in
 *  api/internal/store/analytics.go; label is always the
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
  deepseek: { label: "DeepSeek", color: "var(--chart-deepseek)" },
  other: { label: "Other", color: "var(--text-muted)" },
  unknown: { label: "Unknown", color: "var(--text-muted)" },
};

/** True when an analytics dimension value names a known provider. */
export function isProvider(value: string): value is Provider {
  return Object.prototype.hasOwnProperty.call(PROVIDER_META, value);
}

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
  return isProvider(dimension) ? PROVIDER_META[dimension].label : dimension;
}

// ---------------------------------------------------------------------
// Claude Code session detection
// ---------------------------------------------------------------------

/**
 * True when a session originated from the Claude Code plugin. Detects
 * via ``flavor="claude-code"`` (the plugin's default; can in theory be
 * overridden by the operator via ``AGENT_FLAVOR``) OR via any entry in
 * ``context.frameworks`` starting with ``"claude-code"`` (the plugin
 * always stamps one of those). The OR makes the helper resilient to a
 * fleet where somebody renamed the flavor but the framework tag still
 * reveals the origin.
 */
export function isClaudeCodeSession(session: {
  flavor?: string;
  context?: Record<string, unknown>;
}): boolean {
  if (session.flavor === "claude-code") return true;
  const frameworks = session.context?.frameworks;
  if (Array.isArray(frameworks)) {
    for (const fw of frameworks) {
      if (typeof fw === "string" && fw.startsWith("claude-code")) return true;
    }
  }
  return false;
}

/**
 * Return the Claude Code client version string when the session carries
 * a ``claude-code/<version>`` entry in ``context.frameworks``, or null
 * otherwise. The plugin reads the version from the transcript JSONL's
 * ``message.version`` field; older Claude Code releases or transcripts
 * missing the field leave the helper with a bare ``"claude-code"``
 * entry and this function returns null.
 */
export function getClaudeCodeVersion(session: {
  context?: Record<string, unknown>;
}): string | null {
  const frameworks = session.context?.frameworks;
  if (!Array.isArray(frameworks)) return null;
  for (const fw of frameworks) {
    if (typeof fw !== "string") continue;
    if (fw === "claude-code") continue;
    if (fw.startsWith("claude-code/")) {
      const v = fw.slice("claude-code/".length);
      return v || null;
    }
  }
  return null;
}
