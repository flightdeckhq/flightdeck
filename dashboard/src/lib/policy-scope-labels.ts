export type PolicyScope = "org" | "flavor" | "session";

export const POLICY_SCOPE_LABELS: Record<PolicyScope, string> = {
  org: "Organization",
  flavor: "Agent",
  session: "Run",
};
