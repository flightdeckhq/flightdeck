// Unified Policies page (D146). Token Budget and MCP Protection
// live as sub-tabs under one route. Token Budget is the default
// (preserves pre-D146 behavior where /policies has always meant
// the token-budget surface). ``?policy=mcp`` deep-links the MCP
// Protection sub-tab; the param is dropped on Token Budget so the
// default URL stays clean.
//
// Tab state is stored in the URL query param via React Router's
// useSearchParams so deep-linking + browser back/forward + copy-
// paste survive natively. Component-level state would lose the
// URL contract.
//
// The MCP Protection sub-tab content lives in
// ``components/policy/MCPProtectionTab.tsx`` (renamed from the
// retired pages/MCPPolicies.tsx); Token Budget content stays
// inline as a private function below since it's small.

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { MCPProtectionTab } from "@/components/policy/MCPProtectionTab";
import { PolicyEditor } from "@/components/policy/PolicyEditor";
import { PolicyTable } from "@/components/policy/PolicyTable";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  createPolicy,
  deletePolicy,
  fetchPolicies,
  updatePolicy,
} from "@/lib/api";
import type { Policy, PolicyRequest } from "@/lib/types";

const POLICY_TAB_PARAM = "policy";
const TOKEN_BUDGET_VALUE = "token-budget";
const MCP_PROTECTION_VALUE = "mcp";

export function Policies() {
  const [searchParams, setSearchParams] = useSearchParams();
  const active =
    searchParams.get(POLICY_TAB_PARAM) === MCP_PROTECTION_VALUE
      ? MCP_PROTECTION_VALUE
      : TOKEN_BUDGET_VALUE;

  function handleTabChange(next: string) {
    if (next === MCP_PROTECTION_VALUE) {
      setSearchParams({ [POLICY_TAB_PARAM]: MCP_PROTECTION_VALUE });
    } else {
      // Drop the param entirely on Token Budget — the default URL
      // shape stays clean (D146 / Q3 of step 6.8 plan readback).
      setSearchParams({});
    }
  }

  return (
    <div className="h-full overflow-auto">
      <Tabs
        value={active}
        onValueChange={handleTabChange}
        className="w-full"
      >
        <div
          className="border-b px-6 py-3"
          style={{ borderColor: "var(--border)" }}
        >
          <TabsList>
            <TabsTrigger
              value={TOKEN_BUDGET_VALUE}
              data-testid="policies-tab-token-budget"
            >
              Token Budget
            </TabsTrigger>
            <TabsTrigger
              value={MCP_PROTECTION_VALUE}
              data-testid="policies-tab-mcp-protection"
            >
              MCP Protection
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value={TOKEN_BUDGET_VALUE}>
          <TokenBudgetTab />
        </TabsContent>
        <TabsContent value={MCP_PROTECTION_VALUE}>
          <MCPProtectionTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TokenBudgetTab() {
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
      setError(
        editingPolicy ? "Failed to update policy" : "Failed to create policy",
      );
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
    <div className="p-6" data-testid="policies-tab-token-budget-content">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-text">
          Token Usage Enforcement Policies
        </h1>
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
