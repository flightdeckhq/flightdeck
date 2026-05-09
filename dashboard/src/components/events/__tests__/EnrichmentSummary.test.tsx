import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EnrichmentSummary } from "../EnrichmentSummary";
import type { AgentEvent } from "@/lib/types";

function makeEvent(payload: Record<string, unknown> = {}): AgentEvent {
  return {
    id: "evt-1",
    session_id: "ses-1",
    flavor: "test",
    event_type: "post_call",
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    occurred_at: "2026-05-09T07:00:00Z",
    payload,
  };
}

describe("EnrichmentSummary", () => {
  it("renders nothing when payload has no enrichment fields", () => {
    const { container } = render(<EnrichmentSummary event={makeEvent()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders policy_decision_pre block with reason", () => {
    render(
      <EnrichmentSummary
        event={makeEvent({
          policy_decision_pre: {
            policy_id: "abc12345-0000-0000-0000-000000000000",
            scope: "flavor:test",
            decision: "warn",
            reason: "Pre-call check: would cross warn threshold (50%)",
          },
        })}
      />,
    );
    expect(screen.getByText("Policy decision (pre-call)")).toBeInTheDocument();
    expect(screen.getByText("warn")).toBeInTheDocument();
    expect(
      screen.getByText("Pre-call check: would cross warn threshold (50%)"),
    ).toBeInTheDocument();
  });

  it("renders provider_metadata as a key-value table", () => {
    render(
      <EnrichmentSummary
        event={makeEvent({
          provider_metadata: {
            ratelimit_remaining_tokens: 8000,
            request_id: "req_abc123",
          },
        })}
      />,
    );
    expect(screen.getByText("Provider metadata")).toBeInTheDocument();
    expect(screen.getByText("ratelimit_remaining_tokens")).toBeInTheDocument();
    expect(screen.getByText("8000")).toBeInTheDocument();
    expect(screen.getByText("req_abc123")).toBeInTheDocument();
  });

  it("renders output_dimensions with total floats computed", () => {
    render(
      <EnrichmentSummary
        event={makeEvent({
          output_dimensions: { count: 12, dimension: 1536 },
        })}
      />,
    );
    expect(screen.getByText("count")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("1536")).toBeInTheDocument();
    expect(screen.getByText("18,432")).toBeInTheDocument();
  });

  it("renders retry_attempt + terminal red flag", () => {
    render(
      <EnrichmentSummary
        event={makeEvent({
          estimated_via: "tiktoken",
          retry_attempt: 3,
          terminal: true,
        })}
      />,
    );
    expect(screen.getByText("retry_attempt")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("terminal")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
  });

  it("renders close_reason on session_end", () => {
    render(
      <EnrichmentSummary
        event={makeEvent({
          close_reason: "directive_shutdown",
          last_event_id: "abcdef12-0000-0000-0000-000000000000",
        })}
      />,
    );
    expect(screen.getByText("Close reason")).toBeInTheDocument();
    expect(screen.getByText("directive_shutdown")).toBeInTheDocument();
    expect(screen.getByText(/last event abcdef12/)).toBeInTheDocument();
  });

  it("renders policy_actions_summary on session_end", () => {
    render(
      <EnrichmentSummary
        event={makeEvent({
          policy_actions_summary: { policy_warn: 2, policy_mcp_block: 1 },
        })}
      />,
    );
    expect(screen.getByText("Policy actions in this session")).toBeInTheDocument();
    expect(screen.getByText("policy_warn")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("policy_mcp_block")).toBeInTheDocument();
  });

  it("renders policy_entries_orphaned with sample IDs", () => {
    render(
      <EnrichmentSummary
        event={makeEvent({
          policy_entries_orphaned: {
            count: 3,
            sample_entry_ids: [
              "11111111-0000-0000-0000-000000000000",
              "22222222-0000-0000-0000-000000000000",
            ],
            affected_policies: [],
          },
        })}
      />,
    );
    expect(screen.getByText("Orphaned policy entries")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("11111111, 22222222")).toBeInTheDocument();
  });

  it("clicks the originating-jump and calls the callback", () => {
    const onJump = vi.fn();
    render(
      <EnrichmentSummary
        event={makeEvent({
          originating_event_id: "abcdef12-0000-0000-0000-000000000000",
        })}
        onJumpToOriginator={onJump}
      />,
    );
    const btn = screen.getByTestId("originating-jump");
    fireEvent.click(btn);
    expect(onJump).toHaveBeenCalledWith("abcdef12-0000-0000-0000-000000000000");
  });

  it("renders sensor_version + selected interceptor versions", () => {
    render(
      <EnrichmentSummary
        event={makeEvent({
          sensor_version: "0.6.0",
          interceptor_versions: { anthropic: "0.94.0", openai: "2.34.0" },
        })}
      />,
    );
    expect(screen.getByText("sensor_version")).toBeInTheDocument();
    expect(screen.getByText("0.6.0")).toBeInTheDocument();
    expect(screen.getByText("anthropic")).toBeInTheDocument();
    expect(screen.getByText("0.94.0")).toBeInTheDocument();
  });
});
