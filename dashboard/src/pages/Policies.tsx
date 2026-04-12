import { useState, useEffect, useCallback } from "react";
import type { Policy, PolicyRequest } from "@/lib/types";
import {
  fetchPolicies,
  createPolicy,
  updatePolicy,
  deletePolicy,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PolicyEditor } from "@/components/policy/PolicyEditor";
import { PolicyTable } from "@/components/policy/PolicyTable";

export function Policies() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<Policy | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPolicies();
      setPolicies(data);
    } catch {
      setError("Failed to load policies");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditingPolicy(undefined);
    setEditorOpen(true);
  }

  function openEdit(policy: Policy) {
    setEditingPolicy(policy);
    setEditorOpen(true);
  }

  async function handleSave(data: PolicyRequest) {
    setError(null);
    try {
      if (editingPolicy) {
        await updatePolicy(editingPolicy.id, data);
      } else {
        await createPolicy(data);
      }
      setEditorOpen(false);
      await load();
    } catch {
      setError(editingPolicy ? "Failed to update policy" : "Failed to create policy");
    }
  }

  async function handleDelete(policy: Policy) {
    setError(null);
    try {
      await deletePolicy(policy.id);
      await load();
    } catch {
      setError("Failed to delete policy");
    }
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text">Token Usage Enforcement Policies</h1>
        <Button onClick={openCreate}>Create Policy</Button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <PolicyTable
        policies={policies}
        onEdit={openEdit}
        onDelete={handleDelete}
        onCreate={openCreate}
        loading={loading}
      />

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="w-full max-w-md">
          <DialogTitle>
            {editingPolicy ? "Edit Policy" : "Create Policy"}
          </DialogTitle>
          <div className="mt-4">
            <PolicyEditor
              policy={editingPolicy}
              onSave={handleSave}
              onCancel={() => setEditorOpen(false)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
