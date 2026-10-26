import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getProvider, isProvider, providerLabel } from "@/lib/models";

// The Go twins (api and workers modelid packages) read this file; the
// dashboard reads it too, so its provider rule cannot drift from the
// one the API groups analytics by.
const vectors = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../workers/internal/modelid/testdata/vectors.json"),
    "utf8",
  ),
) as { provider: Record<string, string> };

describe("getProvider", () => {
  it("matches the API's provider for every shared vector", () => {
    // An empty id is the one deliberate difference: the dashboard shows
    // "unknown" for an event with no model, where the API buckets it
    // as "other". ("ft:", an empty fine-tune base, agrees: "other".)
    const entries = Object.entries(vectors.provider).filter(([model]) => model !== "");
    expect(entries.length).toBeGreaterThan(10);
    for (const [model, want] of entries) {
      expect(getProvider(model), model).toBe(want);
    }
  });

  it("returns unknown for a missing model", () => {
    expect(getProvider(null)).toBe("unknown");
    expect(getProvider("")).toBe("unknown");
    expect(getProvider("   ")).toBe("unknown");
  });

  it("reads the base model of a fine-tune and a Bedrock vendor prefix", () => {
    expect(getProvider("ft:gpt-4o-2024-08-06:org:custom:abc")).toBe("openai");
    expect(getProvider("meta.llama3-70b-instruct-v1:0")).toBe("meta");
    expect(getProvider("deepseek-chat")).toBe("deepseek");
  });
});

describe("isProvider / providerLabel", () => {
  it("knows deepseek and labels it", () => {
    expect(isProvider("deepseek")).toBe(true);
    expect(providerLabel("deepseek")).toBe("DeepSeek");
  });

  it("passes an unknown dimension through", () => {
    expect(isProvider("toString")).toBe(false);
    expect(providerLabel("some-gateway")).toBe("some-gateway");
  });
});
