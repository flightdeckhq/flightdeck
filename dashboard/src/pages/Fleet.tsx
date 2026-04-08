import { useFleet } from "@/hooks/useFleet";
import { useFleetStore } from "@/store/fleet";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import { Timeline } from "@/components/timeline/Timeline";
import { SessionDrawer } from "@/components/session/SessionDrawer";

export function Fleet() {
  const { flavors, loading, error } = useFleet();
  const { selectedSessionId, selectSession } = useFleetStore();

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
