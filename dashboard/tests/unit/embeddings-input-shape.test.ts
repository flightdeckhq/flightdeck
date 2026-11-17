import { describe, it, expect } from "vitest";
import { classifyEmbeddingInput } from "@/components/session/EmbeddingsContentViewer";

// The shape of a stored embeddings ``input`` is read from its JSON type
// alone. The embeddings API takes a string, a list of strings, a list
// of token ids (one input) or a list of token-id lists (one input
// each); anything else is shown as its JSON.

describe("classifyEmbeddingInput", () => {
  it("a string is one text input", () => {
    expect(classifyEmbeddingInput("hello")).toEqual({ kind: "string", text: "hello" });
    expect(classifyEmbeddingInput("")).toEqual({ kind: "string", text: "" });
  });

  it("a list of strings is one text input per item", () => {
    expect(classifyEmbeddingInput(["a", "b"])).toEqual({ kind: "list", items: ["a", "b"] });
  });

  it("a list of token ids is one input", () => {
    expect(classifyEmbeddingInput([101, 202, 303])).toEqual({ kind: "tokens", ids: [101, 202, 303] });
    expect(classifyEmbeddingInput([0])).toEqual({ kind: "tokens", ids: [0] });
  });

  it("a list of token-id lists is one input per list", () => {
    expect(classifyEmbeddingInput([[1, 2, 3], [4, 5, 6]])).toEqual({
      kind: "list",
      items: [[1, 2, 3], [4, 5, 6]],
    });
  });

  it("null and absent are absent", () => {
    expect(classifyEmbeddingInput(null)).toEqual({ kind: "absent" });
    expect(classifyEmbeddingInput(undefined)).toEqual({ kind: "absent" });
  });

  it.each([
    ["an empty list", []],
    ["a list mixing text and token ids", ["a", 1]],
    ["a list mixing token ids and token-id lists", [1, [2]]],
    ["a list of text and token-id lists", ["a", [1, 2]]],
    ["a list holding an empty token-id list", [[1, 2], []]],
    ["a list nested three deep", [[[1]]]],
    ["fractions", [0.5, 1]],
    ["a negative number", [-1, 2]],
    ["an object", { input: "a" }],
    ["a number", 42],
    ["a boolean", true],
  ])("%s is JSON", (_name, input) => {
    expect(classifyEmbeddingInput(input)).toEqual({ kind: "json", value: input });
  });
});
