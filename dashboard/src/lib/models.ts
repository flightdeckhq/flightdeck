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

export type Provider = "anthropic" | "openai" | "unknown";

export function getProvider(model: string | null | undefined): Provider {
  if (!model) return "unknown";
  if (ANTHROPIC_MODELS.has(model)) return "anthropic";
  if (OPENAI_MODELS.has(model)) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) return "openai";
  return "unknown";
}
