import { useState, useEffect, useCallback, useRef } from "react";
import { AlertTriangle, Check, Copy, Loader2, Pencil, Trash2 } from "lucide-react";
import type { AccessToken, CreatedAccessToken } from "@/lib/types";
import {
  fetchAccessTokens,
  createAccessToken,
  deleteAccessToken,
  renameAccessToken,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const DEV_TOKEN_NAME = "Development Token";

// Returns the `"3 days ago"`-style relative string used across the
// dashboard. Mirrors the helper in PolicyTable so the Settings page
// doesn't introduce yet another formatter; kept local to avoid a
// cross-feature import.
function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function Settings() {
  const [tokens, setTokens] = useState<AccessToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchAccessTokens();
      setTokens(rows);
    } catch {
      setError("Failed to load access tokens");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The dashboard cannot read ENVIRONMENT directly from the server,
  // so we heuristically assume "dev mode" whenever the only token on
  // the server is the protected Development Token row. As soon as an
  // operator provisions a real ftd_ token, the banner disappears --
  // that first real token is the signal that someone is moving the
  // deployment toward production.
  const isDevMode =
    !loading &&
    tokens.length === 1 &&
    tokens[0]?.name === DEV_TOKEN_NAME;

  return (
    <div className="h-full overflow-auto p-6">
      <h1 className="mb-6 text-xl font-semibold text-text">Settings</h1>

      <section>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-text">Access Tokens</h2>
          <Button onClick={() => setCreateOpen(true)}>Create Access Token</Button>
        </div>
        <p className="mb-4 text-xs text-text-muted">
          Manage access tokens for connecting agents and services to Flightdeck.
        </p>

        {isDevMode && <DevModeBanner />}

        {error && (
          <div
            data-testid="settings-error"
            className="mb-4 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            {error}
          </div>
        )}

        <AccessTokenTable
          tokens={tokens}
          loading={loading}
          onChanged={load}
          onError={setError}
        />
      </section>

      <CreateAccessTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={load}
      />
    </div>
  );
}

// ---- Dev-mode banner --------------------------------------------------

function DevModeBanner() {
  return (
    <div
      data-testid="settings-dev-banner"
      className="mb-4 flex items-start gap-3 rounded-md border px-3 py-2.5 text-xs"
      style={{
        borderColor: "var(--warning)",
        background: "color-mix(in srgb, var(--warning) 12%, transparent)",
        color: "var(--text)",
      }}
    >
      <AlertTriangle
        size={16}
        style={{ color: "var(--warning)", flexShrink: 0, marginTop: 1 }}
      />
      <div>
        <span className="font-medium" style={{ color: "var(--warning)" }}>
          Development mode is active.
        </span>{" "}
        <span style={{ color: "var(--text)" }}>
          tok_dev is accepted by all services. Create a production access token
          before deploying.
        </span>
      </div>
    </div>
  );
}

// ---- Access token table ---------------------------------------------

interface TableProps {
  tokens: AccessToken[];
  loading: boolean;
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
}

function AccessTokenTable({ tokens, loading, onChanged, onError }: TableProps) {
  return (
    <TooltipProvider delayDuration={200}>
      <div
        className="overflow-hidden rounded-md border"
        style={{ borderColor: "var(--border)" }}
      >
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-left text-xs"
              style={{
                background: "var(--surface)",
                color: "var(--text-muted)",
              }}
            >
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Prefix</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Last Used</th>
              <th className="px-3 py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonRows />
            ) : tokens.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-8 text-center text-xs text-text-muted"
                >
                  No access tokens yet.
                </td>
              </tr>
            ) : (
              tokens.map((token) => (
                <TokenRow
                  key={token.id}
                  token={token}
                  onChanged={onChanged}
                  onError={onError}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1].map((i) => (
        <tr key={i}>
          {Array.from({ length: 5 }).map((_, j) => (
            <td key={j} className="px-3 py-3">
              <div
                className="h-4 animate-pulse rounded"
                style={{ background: "var(--border)" }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

interface TokenRowProps {
  token: AccessToken;
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
}

function TokenRow({ token, onChanged, onError }: TokenRowProps) {
  const isDev = token.name === DEV_TOKEN_NAME;
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(token.name);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) {
      // Delay to the next frame so Radix-style focus traps from any
      // open Dialog don't steal focus back on the same tick.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing]);

  const startEdit = () => {
    if (isDev) return;
    onError(null);
    setDraftName(token.name);
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraftName(token.name);
  };

  const saveEdit = async () => {
    const next = draftName.trim();
    if (!next || next === token.name) {
      cancelEdit();
      return;
    }
    setSaving(true);
    try {
      await renameAccessToken(token.id, next);
      setEditing(false);
      await onChanged();
    } catch {
      onError("Failed to rename access token");
    } finally {
      setSaving(false);
    }
  };

  const askDelete = () => {
    if (isDev) return;
    onError(null);
    setConfirmDelete(true);
  };

  const confirmDeleteNow = async () => {
    setDeleting(true);
    try {
      await deleteAccessToken(token.id);
      await onChanged();
    } catch {
      onError("Failed to delete access token");
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <tr
      data-testid={`access-token-row-${token.id}`}
      data-dev={isDev || undefined}
      style={{ borderTop: "1px solid var(--border)" }}
    >
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          {editing ? (
            <>
              <input
                ref={inputRef}
                data-testid={`access-token-name-input-${token.id}`}
                value={draftName}
                disabled={saving}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelEdit();
                  }
                }}
                onBlur={() => {
                  // Blur commits the same way Enter does so click-out
                  // on the table saves instead of silently discarding.
                  // If the value hasn't changed saveEdit short-circuits.
                  void saveEdit();
                }}
                className="w-full rounded border px-2 py-1 text-sm focus:outline-none"
                style={{
                  background: "var(--bg)",
                  borderColor: "var(--border)",
                  color: "var(--text)",
                }}
              />
              {saving && (
                <Loader2
                  size={14}
                  className="animate-spin"
                  style={{ color: "var(--text-muted)" }}
                />
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={startEdit}
                disabled={isDev}
                className="truncate text-left text-sm"
                style={{
                  color: "var(--text)",
                  cursor: isDev ? "default" : "text",
                }}
                // Interactive element can't host <TruncatedText/>
                // (which renders span/div). Native ``title`` gives
                // hover reveal; the trade-off vs. the TruncatedText
                // auto-detection is acceptable here because token
                // names are short and usually fit.
                title={token.name}
                data-testid={`access-token-name-${token.id}`}
              >
                {token.name}
              </button>
              {isDev && (
                <span
                  data-testid={`access-token-dev-badge-${token.id}`}
                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                  style={{
                    background:
                      "color-mix(in srgb, var(--warning) 20%, transparent)",
                    color: "var(--warning)",
                  }}
                >
                  Dev
                </span>
              )}
            </>
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        <span
          className="font-mono text-xs"
          style={{ color: "var(--text-muted)" }}
        >
          {token.prefix}
        </span>
      </td>
      <td className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
        {relativeTime(token.created_at)}
      </td>
      <td className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
        {relativeTime(token.last_used_at)}
      </td>
      <td className="px-3 py-2 text-right">
        {confirmDelete ? (
          <div className="flex items-center justify-end gap-2">
            <span className="text-xs" style={{ color: "var(--text)" }}>
              Delete?
            </span>
            <Button
              size="sm"
              variant="destructive"
              onClick={confirmDeleteNow}
              disabled={deleting}
              data-testid={`access-token-confirm-delete-${token.id}`}
            >
              {deleting ? "Deleting..." : "Confirm"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-end gap-1">
            <DevGatedAction
              isDev={isDev}
              label="Rename"
              icon={<Pencil size={14} />}
              onClick={startEdit}
              testId={`access-token-rename-${token.id}`}
            />
            <DevGatedAction
              isDev={isDev}
              label="Delete"
              icon={<Trash2 size={14} />}
              onClick={askDelete}
              testId={`access-token-delete-${token.id}`}
            />
          </div>
        )}
      </td>
    </tr>
  );
}

function DevGatedAction({
  isDev,
  label,
  icon,
  onClick,
  testId,
}: {
  isDev: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  testId: string;
}) {
  const btn = (
    <Button
      size="icon"
      variant="ghost"
      className="h-7 w-7"
      onClick={onClick}
      disabled={isDev}
      aria-label={label}
      data-testid={testId}
    >
      {icon}
    </Button>
  );
  if (!isDev) return btn;
  // Wrap the disabled button in a span so Radix tooltip's event
  // detection still fires (a disabled <button> does not receive
  // pointer events). Tooltip explains why the action is inert.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{btn}</span>
      </TooltipTrigger>
      <TooltipContent>The development token cannot be modified</TooltipContent>
    </Tooltip>
  );
}

// ---- Create dialog (two-step) ---------------------------------------

interface CreateDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => Promise<void>;
}

function CreateAccessTokenDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateDialogProps) {
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedAccessToken | null>(null);

  // Reset dialog internals every time it opens so a previous run's
  // state (leftover name, old created token) can never flash back
  // onto a fresh create flow.
  useEffect(() => {
    if (open) {
      setName("");
      setSubmitting(false);
      setError(null);
      setCreated(null);
    }
  }, [open]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await createAccessToken(trimmed);
      setCreated(result);
    } catch {
      setError("Failed to create access token");
    } finally {
      setSubmitting(false);
    }
  };

  const closeAndRefresh = async () => {
    onOpenChange(false);
    if (created) await onCreated();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        // When an access token has been created, close-by-overlay /
        // close-by-escape still counts as "done" and should refresh
        // the list. Going forward the row shows up in the table.
        if (!v && created) {
          void onCreated();
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="w-full max-w-lg">
        {created ? (
          <CreatedStep token={created} onDone={closeAndRefresh} />
        ) : (
          <NameStep
            name={name}
            error={error}
            submitting={submitting}
            onNameChange={setName}
            onSubmit={submit}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NameStep({
  name,
  error,
  submitting,
  onNameChange,
  onSubmit,
  onCancel,
}: {
  name: string;
  error: string | null;
  submitting: boolean;
  onNameChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <DialogTitle>Create Access Token</DialogTitle>
      <div className="mt-4 space-y-3">
        <label
          className="block text-xs font-medium"
          style={{ color: "var(--text)" }}
        >
          Token name
          <input
            data-testid="create-access-token-name-input"
            autoFocus
            type="text"
            value={name}
            disabled={submitting}
            placeholder="e.g. Production K8s Cluster"
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit();
              }
            }}
            className="mt-1 w-full rounded border px-2 py-1.5 text-sm focus:outline-none focus:ring-1"
            style={{
              background: "var(--bg)",
              borderColor: "var(--border)",
              color: "var(--text)",
            }}
          />
        </label>
        {error && (
          <p className="text-xs" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
      </div>
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={onSubmit}
          disabled={submitting}
          data-testid="create-access-token-submit"
        >
          {submitting ? "Creating..." : "Create"}
        </Button>
      </div>
    </>
  );
}

function CreatedStep({
  token,
  onDone,
}: {
  token: CreatedAccessToken;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* Clipboard API can fail under http://non-localhost or in
         sandboxed iframes. Leave the token visible so the user can
         select + copy manually; no banner spam -- the raw value is
         on screen either way. */
    }
  };

  return (
    <>
      <DialogTitle>Access Token Created</DialogTitle>
      <div className="mt-4 space-y-4">
        <div
          data-testid="created-access-token-warning"
          className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
          style={{
            borderColor: "var(--warning)",
            background: "color-mix(in srgb, var(--warning) 12%, transparent)",
            color: "var(--text)",
          }}
        >
          <AlertTriangle
            size={14}
            style={{ color: "var(--warning)", flexShrink: 0, marginTop: 2 }}
          />
          <span>
            This token will not be shown again. Copy it now and store it
            securely.
          </span>
        </div>

        <div
          className="flex items-center gap-2 rounded-md border px-3 py-2"
          style={{
            borderColor: "var(--border)",
            background: "var(--bg)",
          }}
        >
          <code
            data-testid="created-access-token-value"
            className="flex-1 truncate font-mono text-xs"
            style={{ color: "var(--text)" }}
            // <code> element; TruncatedText renders span/div. Native
            // ``title`` surfaces the full token. Token value is
            // deliberately long; hover reveal is the whole point.
            title={token.token}
          >
            {token.token}
          </code>
          <Button
            size="sm"
            variant="outline"
            onClick={copy}
            data-testid="created-access-token-copy"
            aria-label={copied ? "Copied" : "Copy access token"}
          >
            {copied ? (
              <>
                <Check size={14} className="mr-1.5" />
                Copied
              </>
            ) : (
              <>
                <Copy size={14} className="mr-1.5" />
                Copy
              </>
            )}
          </Button>
        </div>

        <div
          className="rounded-md border p-3"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          <p
            className="mb-2 text-[11px] font-medium uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            Usage
          </p>
          <pre
            className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-5"
            style={{ color: "var(--text)" }}
          >
{`export FLIGHTDECK_TOKEN=${token.token}

# or in Python:
flightdeck_sensor.init(
    server="http://<flightdeck-host>/ingest",
    token="${token.token}",
)`}
          </pre>
        </div>
      </div>
      <div className="mt-6 flex justify-end">
        <Button onClick={onDone} data-testid="created-access-token-done">
          Done
        </Button>
      </div>
    </>
  );
}
