import { describe, expect, it } from "vitest";
import { findLostSubAgent } from "@/lib/swimlane-lost-sub-agent";
import type { Session } from "@/lib/types";

// Pins the recency invariant on the SwimLane sub-agent lost-dot
// helper. The dot must fire only when the MOST RECENT session per
// sub-agent role is in ``lost`` state — an older lost run that has
// since been retried successfully must not keep the dot lit (the
// "stickiness" bug the helper was extracted to fix).

function mkSession(p: {
	id: string;
	role?: string | null;
	state: Session["state"];
	startedAt: string;
	parentId?: string | null;
}): Session {
	return {
		session_id: p.id,
		flavor: "test-flavor",
		agent_type: "production",
		host: null,
		framework: null,
		model: null,
		state: p.state,
		started_at: p.startedAt,
		last_seen_at: p.startedAt,
		ended_at: null,
		tokens_used: 0,
		token_limit: null,
		parent_session_id: p.parentId ?? null,
		agent_role: p.role ?? null,
	};
}

describe("findLostSubAgent", () => {
	it("returns null when the only sub-agent session is healthy", () => {
		const sessions = [
			mkSession({
				id: "a",
				role: "Researcher",
				state: "active",
				startedAt: "2026-05-13T10:00:00Z",
				parentId: "p1",
			}),
		];
		expect(findLostSubAgent(sessions)).toBeNull();
	});

	it("fires when the only sub-agent session is in lost state", () => {
		const sessions = [
			mkSession({
				id: "abcdef1234567890",
				role: "Researcher",
				state: "lost",
				startedAt: "2026-05-13T10:00:00Z",
				parentId: "p1",
			}),
		];
		const result = findLostSubAgent(sessions);
		expect(result).not.toBeNull();
		expect(result?.role).toBe("Researcher");
		expect(result?.sessionIdSuffix).toBe("34567890");
	});

	it("does NOT fire when an old-lost session is followed by a healthy retry for the same role", () => {
		// The stickiness regression: pre-fix, the dot lit as soon as
		// any historical session for the role was in ``lost`` state.
		// Post-fix, only the most-recent session per role counts.
		const sessions = [
			mkSession({
				id: "old-lost",
				role: "Researcher",
				state: "lost",
				startedAt: "2026-05-13T10:00:00Z",
				parentId: "p1",
			}),
			mkSession({
				id: "new-healthy",
				role: "Researcher",
				state: "closed",
				startedAt: "2026-05-13T11:00:00Z",
				parentId: "p1",
			}),
		];
		expect(findLostSubAgent(sessions)).toBeNull();
	});

	it("fires when the most-recent session for any role is lost (old healthy + new lost)", () => {
		// Inverse of the previous case: an old healthy run followed
		// by a new lost run should fire the dot. This pins the
		// "MOST RECENT" rule from both directions so neither sort
		// order accidentally satisfies it.
		const sessions = [
			mkSession({
				id: "old-healthy",
				role: "Researcher",
				state: "closed",
				startedAt: "2026-05-13T10:00:00Z",
				parentId: "p1",
			}),
			mkSession({
				id: "new-lost-1234abcd",
				role: "Researcher",
				state: "lost",
				startedAt: "2026-05-13T11:00:00Z",
				parentId: "p1",
			}),
		];
		const result = findLostSubAgent(sessions);
		expect(result).not.toBeNull();
		expect(result?.role).toBe("Researcher");
	});

	it("ignores parent-only sessions (no parent_session_id)", () => {
		// Root sessions are NOT sub-agents; the dot is a sub-agent
		// failure cue, not a generic lost-session cue.
		const sessions = [
			mkSession({
				id: "root-lost",
				role: null,
				state: "lost",
				startedAt: "2026-05-13T10:00:00Z",
				parentId: null,
			}),
		];
		expect(findLostSubAgent(sessions)).toBeNull();
	});

	it("buckets sub-agents with no agent_role under a synthetic key and still applies recency", () => {
		const sessions = [
			mkSession({
				id: "no-role-lost",
				role: null,
				state: "lost",
				startedAt: "2026-05-13T10:00:00Z",
				parentId: "p1",
			}),
			mkSession({
				id: "no-role-healthy",
				role: null,
				state: "closed",
				startedAt: "2026-05-13T11:00:00Z",
				parentId: "p1",
			}),
		];
		// Both roles bucket under "(no-role)"; the newer healthy
		// session is the latest, so the dot stays off.
		expect(findLostSubAgent(sessions)).toBeNull();
	});

	it("distinguishes roles: one role lost + another role healthy fires the dot", () => {
		const sessions = [
			mkSession({
				id: "researcher-lost",
				role: "Researcher",
				state: "lost",
				startedAt: "2026-05-13T10:00:00Z",
				parentId: "p1",
			}),
			mkSession({
				id: "writer-active",
				role: "Writer",
				state: "active",
				startedAt: "2026-05-13T11:00:00Z",
				parentId: "p1",
			}),
		];
		const result = findLostSubAgent(sessions);
		expect(result).not.toBeNull();
		expect(result?.role).toBe("Researcher");
	});
});
