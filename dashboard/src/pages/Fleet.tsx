import { useFleet } from "@/hooks/useFleet";
import { useFleetStore, type AgentTypeFilter } from "@/store/fleet";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import { DirectivesPanel } from "@/components/fleet/DirectivesPanel";
import { Timeline } from "@/components/timeline/Timeline";
import { SessionDrawer } from "@/components/session/SessionDrawer";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";

const FILTER_OPTIONS: { label: string; value: AgentTypeFilter }[] = [
  { label: "All", value: "all" },
  { label: "Production", value: "production" },
  { label: "Developer", value: "developer" },
];

export function Fleet() {
  const { flavors, loading, error } = useFleet();
  const {
    selectedSessionId,
    selectSession,
    agentTypeFilter,
    setAgentTypeFilter,
    flavorFilter,
    setFlavorFilter,
  } = useFleetStore();

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

  function handleFlavorClick(flavor: string) {
    setFlavorFilter(flavorFilter === flavor ? null : flavor);
  }

  return (
    <div className="flex h-full">
      <FleetPanel
        flavors={flavors}
        onFlavorClick={handleFlavorClick}
        activeFlavorFilter={flavorFilter}
      >
        <DirectivesPanel
          flavorFilter={flavorFilter}
          selectedSessionId={selectedSessionId}
        />
      </FleetPanel>
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
          {flavorFilter && (
            <div className="ml-3 flex items-center gap-1">
              <span className="text-[11px] text-text-muted">Flavor:</span>
              <span className="text-[11px] font-mono text-[var(--primary)]">{flavorFilter}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-5 w-5 p-0"
                onClick={() => setFlavorFilter(null)}
              >
                <X className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>
        <Timeline
          flavors={flavors}
          flavorFilter={flavorFilter}
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
