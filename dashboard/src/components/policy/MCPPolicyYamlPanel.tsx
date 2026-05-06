import { useState } from "react";
import { Download, FileCode, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ApiError, exportMCPPolicyYAML, importMCPPolicyYAML } from "@/lib/api";

export interface MCPPolicyYamlPanelProps {
  flavor: string;
  scopeKey: string;
  /** Trigger when an import succeeds — parent reloads the policy. */
  onImported: () => Promise<void>;
}

/**
 * YAML import / export for one MCP Protection Policy scope. The
 * surface is two halves of one card:
 *
 * - **Import.** Plain ``<textarea>`` (D138 — no schema validator
 *   in the dashboard, the API is the source of truth). Submit
 *   posts the textarea body to ``POST /:flavor/import`` with
 *   ``Content-Type: application/yaml``; the API's 400 response
 *   surfaces inline beneath the textarea so the operator can fix
 *   without leaving the page.
 * - **Export.** Single button that fetches
 *   ``GET /:flavor/export`` and triggers a Blob download. The
 *   export is structured YAML matching the import format —
 *   round-trips cleanly.
 *
 * Both sides are admin-only (adminGate); 403 surfaces "Admin
 * token required" copy, consistent with the rest of the page.
 */
export function MCPPolicyYamlPanel({
  flavor,
  scopeKey,
  onImported,
}: MCPPolicyYamlPanelProps) {
  const [yaml, setYaml] = useState("");
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  async function handleImport() {
    if (!yaml.trim()) {
      setImportError("Paste a YAML body before importing.");
      return;
    }
    setImporting(true);
    setImportError(null);
    setImportSuccess(null);
    try {
      const updated = await importMCPPolicyYAML(flavor, yaml);
      setImportSuccess(`Imported successfully — now at v${updated.version}.`);
      setYaml("");
      await onImported();
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setImportError("Admin token required to import.");
      } else if (err instanceof Error) {
        setImportError(err.message || "Import failed");
      } else {
        setImportError("Import failed");
      }
    } finally {
      setImporting(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    setExportError(null);
    try {
      const body = await exportMCPPolicyYAML(flavor);
      const blob = new Blob([body], { type: "application/yaml" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `mcp-policy-${flavor}.yaml`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setExportError("Admin token required to export.");
      } else {
        setExportError(err instanceof Error ? err.message : "Export failed");
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <section
      className="rounded-md border"
      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      data-testid={`mcp-policy-yaml-${scopeKey}`}
    >
      <header
        className="flex items-center justify-between gap-2 border-b px-4 py-3"
        style={{ borderColor: "var(--border)" }}
      >
        <div className="flex items-center gap-2">
          <FileCode
            className="h-4 w-4"
            style={{ color: "var(--text-muted)" }}
            aria-hidden="true"
          />
          <h2
            className="text-sm font-semibold"
            style={{ color: "var(--text)" }}
          >
            YAML import / export
          </h2>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleExport}
          disabled={exporting}
          className="gap-1.5"
          data-testid={`mcp-policy-yaml-export-${scopeKey}`}
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
          {exporting ? "Exporting…" : "Export YAML"}
        </Button>
      </header>

      <div className="space-y-3 p-4">
        <div>
          <label
            htmlFor={`mcp-policy-yaml-textarea-${scopeKey}`}
            className="mb-1 block text-[11px] font-medium uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            Paste YAML body to import
          </label>
          <textarea
            id={`mcp-policy-yaml-textarea-${scopeKey}`}
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            rows={10}
            spellCheck={false}
            placeholder={"scope: flavor\nblock_on_uncertainty: false\nentries:\n  - server_url: https://...\n    server_name: example\n    entry_kind: allow"}
            className="block w-full resize-y rounded-md border px-3 py-2 font-mono text-[12px] outline-none transition-colors focus:border-[var(--accent)]"
            style={{
              borderColor: "var(--border)",
              background: "var(--background-elevated)",
              color: "var(--text)",
            }}
            data-testid={`mcp-policy-yaml-textarea-${scopeKey}`}
          />
        </div>

        {importError ? (
          <div
            className="rounded-md border px-3 py-2 text-xs"
            style={{
              borderColor: "var(--danger)",
              background: "color-mix(in srgb, var(--danger) 10%, transparent)",
              color: "var(--danger)",
            }}
            data-testid={`mcp-policy-yaml-import-error-${scopeKey}`}
          >
            {importError}
          </div>
        ) : null}

        {importSuccess ? (
          <div
            className="rounded-md border px-3 py-2 text-xs"
            style={{
              borderColor: "var(--success, #16a34a)",
              background:
                "color-mix(in srgb, var(--success, #16a34a) 10%, transparent)",
              color: "var(--success, #16a34a)",
            }}
            data-testid={`mcp-policy-yaml-import-success-${scopeKey}`}
          >
            {importSuccess}
          </div>
        ) : null}

        {exportError ? (
          <div
            className="rounded-md border px-3 py-2 text-xs"
            style={{
              borderColor: "var(--danger)",
              background: "color-mix(in srgb, var(--danger) 10%, transparent)",
              color: "var(--danger)",
            }}
            data-testid={`mcp-policy-yaml-export-error-${scopeKey}`}
          >
            {exportError}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <span
            className="text-[11px]"
            style={{ color: "var(--text-muted)" }}
          >
            Import replaces the entire policy. Bumps a new version.
          </span>
          <Button
            size="sm"
            onClick={handleImport}
            disabled={importing || !yaml.trim()}
            className="gap-1.5"
            data-testid={`mcp-policy-yaml-import-${scopeKey}`}
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            {importing ? "Importing…" : "Import YAML"}
          </Button>
        </div>
      </div>
    </section>
  );
}
