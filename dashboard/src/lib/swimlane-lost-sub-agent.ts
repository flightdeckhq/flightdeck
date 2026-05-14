import type { Session } from "@/lib/types";

export interface LostSubAgentInfo {
	role: string | undefined;
	sessionIdSuffix: string;
}

// findLostSubAgent surfaces a sub-agent that ended in ``lost`` state
// on a swimlane row's label strip. A sub-agent role may run multiple
// times on the same agent (retried prompts, re-runs, etc.); the dot
// must fire only when the MOST RECENT session for a given role is in
// ``lost`` state. An old lost session followed by a healthy re-run
// must NOT keep the dot lit — that was the stickiness bug. Sub-agent
// sessions with no ``agent_role`` bucket under a synthetic
// ``(no-role)`` key so the same recency rule applies.
//
// Returns ``null`` when no sub-agent role's latest session is in
// ``lost`` state; otherwise returns the role label + the last 8
// characters of the offending session_id (used as the tooltip
// disambiguator on the dot itself).
export function findLostSubAgent(sessions: Session[]): LostSubAgentInfo | null {
	const latestPerRole = new Map<string, Session>();
	for (const s of sessions) {
		if (s.parent_session_id == null) continue;
		const roleKey = s.agent_role ?? "(no-role)";
		const prior = latestPerRole.get(roleKey);
		const sMs = new Date(s.started_at).getTime();
		const priorMs = prior ? new Date(prior.started_at).getTime() : -Infinity;
		// Strict ``>`` so identical-timestamp duplicates keep the
		// first session encountered; otherwise iteration order on
		// the input array would tip the recency winner.
		if (sMs > priorMs) latestPerRole.set(roleKey, s);
	}
	for (const [, s] of latestPerRole) {
		if (s.state === "lost") {
			return {
				role: s.agent_role ?? undefined,
				sessionIdSuffix: s.session_id.slice(-8),
			};
		}
	}
	return null;
}
