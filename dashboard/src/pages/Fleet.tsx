import { useFleet } from "@/hooks/useFleet";
import { useFleetStore, type AgentTypeFilter } from "@/store/fleet";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import { Timeline } from "@/components/timeline/Timeline";
import { SessionDrawer } from "@/components/session/SessionDrawer";
import { Button } from "@/components/ui/button";

const FILTER_OPTIONS: { label: string; value: AgentTypeFilter }[] = [
  { label: "All", value: "all" },
  { label: "Production", value: "production" },
  { label: "Developer", value: "developer" },
];

export function Fleet() {
  const { flavors, loading, error } = useFleet();
  const { selectedSessionId, selectSession, agentTypeFilter, setAgentTypeFilter } = useFleetStore();

  if (loading && flavors.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        Loading fleet...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-danger">
        {error}
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <FleetPanel flavors={flavors} />
      <div className="flex-1 overflow-hidden p-4">
        <div className="mb-3 flex items-center gap-1">
          {FILTER_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              size="sm"
              variant={agentTypeFilter === opt.value ? "default" : "ghost"}
              onClick={() => setAgentTypeFilter(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
        <Timeline
          flavors={flavors}
          onNodeClick={(id) => selectSession(id)}
        />
      </div>
      <SessionDrawer
        sessionId={selectedSessionId}
        onClose={() => selectSession(null)}
      />
    </div>
  );
}
