'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  RefreshCw,
  Loader2,
  KeyRound,
  Copy,
  Check,
  ShieldCheck,
  ShieldAlert,
  Plus,
  Pencil,
  Trash2,
  Rocket,
  Database,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SettingsPanelHead } from './settings-panel-head';
import type { WhatsAppFlow } from '@/types';
import { flowStatusConfig } from '@/lib/whatsapp-flow-status';
import { FlowAuthoringDialog } from './flow-authoring-dialog';
import { FlowScreenSourcesDialog } from './flow-screen-sources-dialog';

interface EncryptionStatus {
  configured: boolean;
  uploaded_to_meta_at?: string | null;
  signature_status?: 'VALID' | 'MISMATCH' | null;
  endpoint_url?: string;
}

/**
 * Read-only roster of Meta WhatsApp Flows, pulled in via "Sync from
 * Meta" (POST /api/whatsapp/flows/sync). Unrelated to this app's own
 * local automation Flows at /flows — see migration 027 for why these
 * are a separate table/panel rather than merged into that builder.
 *
 * Only PUBLISHED flows are synced — a flow that isn't published can't
 * be sent to a customer, so there's nothing actionable to show for it
 * here yet (no send/launch support exists in the app either — this
 * panel is purely "what's available in Meta right now").
 */
export function WhatsAppFlowsManager() {
  const supabase = createClient();
  const { user, loading: authLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [flows, setFlows] = useState<WhatsAppFlow[]>([]);
  const [syncing, setSyncing] = useState(false);

  const [encStatus, setEncStatus] = useState<EncryptionStatus | null>(null);
  const [configuring, setConfiguring] = useState(false);
  const [copied, setCopied] = useState(false);

  const [authoringOpen, setAuthoringOpen] = useState(false);
  const [editingFlow, setEditingFlow] = useState<WhatsAppFlow | null>(null);
  const [sourcesFlow, setSourcesFlow] = useState<WhatsAppFlow | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    fetchFlows();
    fetchEncryptionStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

  async function fetchFlows() {
    try {
      setLoading(true);
      // Scoped by RLS (whatsapp_flows_select → is_account_member), same
      // pattern as message_templates — no manual account_id filter needed.
      const { data, error } = await supabase
        .from('whatsapp_flows')
        .select('*')
        .order('name', { ascending: true });
      if (error) throw error;
      setFlows(data || []);
    } catch (err) {
      console.error('Failed to fetch WhatsApp Flows:', err);
      toast.error('Failed to load WhatsApp Flows');
    } finally {
      setLoading(false);
    }
  }

  async function fetchEncryptionStatus() {
    try {
      const res = await fetch('/api/whatsapp/flows/encryption');
      if (!res.ok) return; // non-admins / no-account → leave null, panel hides
      const data = (await res.json()) as EncryptionStatus;
      setEncStatus(data);
    } catch (err) {
      console.error('Failed to fetch encryption status:', err);
    }
  }

  async function handleConfigureEncryption() {
    setConfiguring(true);
    try {
      const res = await fetch('/api/whatsapp/flows/encryption', {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Failed (HTTP ${res.status})`);
      }
      toast.success('Encryption key generated and uploaded to Meta.');
      await fetchEncryptionStatus();
    } catch (err) {
      console.error('Configure encryption error:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to configure endpoint');
    } finally {
      setConfiguring(false);
    }
  }

  async function handleCopyEndpoint() {
    if (!encStatus?.endpoint_url) return;
    try {
      await navigator.clipboard.writeText(encStatus.endpoint_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  }

  async function handleSyncFromMeta() {
    if (!user) return;
    setSyncing(true);
    try {
      const res = await fetch('/api/whatsapp/flows/sync', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Sync failed (HTTP ${res.status})`);
      }
      const parts = [`${data.inserted ?? 0} new`, `${data.updated ?? 0} updated`];
      if (data.removed) parts.push(`${data.removed} removed (no longer published)`);
      toast.success(`Synced ${data.total} flow${data.total === 1 ? '' : 's'} from Meta (${parts.join(', ')})`);
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        const preview = data.errors.slice(0, 3).map((e: { name: string }) => e.name);
        const suffix = data.errors.length > 3 ? `, +${data.errors.length - 3} more` : '';
        toast.error(`Failed to sync: ${preview.join(', ')}${suffix}`);
      }
      if (data.truncated) {
        toast.error(
          'Synced the first 2000 flows only — your account has more. Sync again to continue.',
          { duration: 10000 },
        );
      }
      await fetchFlows();
    } catch (err) {
      console.error('WhatsApp Flows sync error:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to sync flows');
    } finally {
      setSyncing(false);
    }
  }

  async function handlePublish(flow: WhatsAppFlow) {
    setPublishingId(flow.id);
    try {
      const res = await fetch(`/api/whatsapp/flows/${flow.id}/publish`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Failed (HTTP ${res.status})`);
      toast.success('Flow published.');
      await fetchFlows();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to publish');
    } finally {
      setPublishingId(null);
    }
  }

  async function handleDelete(flow: WhatsAppFlow) {
    setDeletingId(flow.id);
    try {
      const res = await fetch(`/api/whatsapp/flows/${flow.id}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Failed (HTTP ${res.status})`);
      toast.success('Flow deleted.');
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeletingId(null);
    }
  }

  function openCreate() {
    setEditingFlow(null);
    setAuthoringOpen(true);
  }

  function openEdit(flow: WhatsAppFlow) {
    setEditingFlow(flow);
    setAuthoringOpen(true);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title="WhatsApp Flows"
        description={
          'Author WhatsApp Flows from wacrm (create → validate → publish on Meta) or pull ones published elsewhere with "Sync from Meta". Dynamic (data_exchange) flows call your endpoint below. Unrelated to the local Flows automation builder.'
        }
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleSyncFromMeta}
              disabled={syncing}
              title="Pull published WhatsApp Flows from your Meta Business Account"
            >
              <RefreshCw className={`size-4 ${syncing ? 'animate-spin' : ''}`} />
              {syncing ? 'Syncing…' : 'Sync from Meta'}
            </Button>
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              New flow
            </Button>
          </div>
        }
      />

      {/* Data-exchange endpoint & encryption (Phase 0). Only rendered
          for admins — the GET returns configured:false / non-200 for
          everyone else, leaving encStatus null. */}
      {encStatus && (
        <Card>
          <CardContent className="space-y-3 pt-4">
            <div className="flex items-start gap-2">
              <KeyRound className="size-4 mt-0.5 text-primary shrink-0" />
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-medium text-foreground">
                  Data-exchange endpoint
                </h3>
                <p className="text-xs text-muted-foreground mt-0.5 max-w-[70ch]">
                  Flows with dynamic screens (<code>data_exchange</code>) call a
                  secure endpoint hosted here. Generate an encryption key — we
                  upload the public half to Meta and keep the private half
                  encrypted. Then paste the URL below into the flow&apos;s
                  endpoint setting in Meta.
                </p>
              </div>
            </div>

            {!encStatus.configured ? (
              <Button onClick={handleConfigureEncryption} disabled={configuring}>
                {configuring ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Generating…
                  </>
                ) : (
                  <>
                    <KeyRound className="size-4" />
                    Generate &amp; upload key
                  </>
                )}
              </Button>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  {encStatus.signature_status === 'VALID' ? (
                    <Badge className="text-xs border bg-primary/20 text-primary border-primary/30">
                      <ShieldCheck className="size-3" />
                      Key verified (VALID)
                    </Badge>
                  ) : encStatus.signature_status === 'MISMATCH' ? (
                    <Badge className="text-xs border bg-red-600/20 text-red-400 border-red-600/30">
                      <ShieldAlert className="size-3" />
                      Signature MISMATCH — regenerate
                    </Badge>
                  ) : (
                    <Badge className="text-xs border bg-yellow-600/20 text-yellow-400 border-yellow-600/30">
                      Key uploaded — status pending
                    </Badge>
                  )}
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">
                    Endpoint URL (paste into Meta → Flow → Endpoint)
                  </label>
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={encStatus.endpoint_url ?? ''}
                      className="bg-muted border-border text-foreground font-mono text-xs"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={handleCopyEndpoint}
                      title="Copy endpoint URL"
                    >
                      {copied ? (
                        <Check className="size-4 text-primary" />
                      ) : (
                        <Copy className="size-4" />
                      )}
                    </Button>
                  </div>
                </div>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleConfigureEncryption}
                  disabled={configuring}
                >
                  {configuring ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Regenerating…
                    </>
                  ) : (
                    <>
                      <RefreshCw className="size-4" />
                      Regenerate key
                    </>
                  )}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {flows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-muted-foreground text-sm">No flows yet.</p>
            <p className="text-muted-foreground text-xs mt-1">
              Create one with &quot;New flow&quot;, or pull existing ones with
              &quot;Sync from Meta&quot;.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {flows.map((flow) => {
            const status = flowStatusConfig[flow.status];
            const authored = flow.origin === 'authored';
            const isDraft = flow.status === 'DRAFT';
            const hasErrors =
              Array.isArray(flow.validation_errors) &&
              flow.validation_errors.length > 0;
            return (
              <Card key={flow.id}>
                <CardContent className="space-y-2 pt-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-foreground">{flow.name}</h3>
                    <Badge className={`text-xs border ${status.classes}`}>
                      {status.label}
                    </Badge>
                    {authored && (
                      <Badge className="text-xs border bg-blue-600/20 text-blue-400 border-blue-600/30">
                        Authored
                      </Badge>
                    )}
                    {flow.data_channel === 'data_exchange' && (
                      <Badge className="text-xs border bg-slate-600/20 text-muted-foreground border-slate-600/30">
                        dynamic
                      </Badge>
                    )}
                    {flow.categories?.map((c) => (
                      <span
                        key={c}
                        className="text-[10px] uppercase text-muted-foreground"
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Meta flow ID: <span className="font-mono">{flow.meta_flow_id}</span>
                  </p>
                  {hasErrors && (
                    <p className="text-xs text-red-400">
                      Has validation errors — fix in Edit before publishing.
                    </p>
                  )}

                  {authored && (
                    <div className="flex flex-wrap items-center gap-1 pt-1">
                      {isDraft && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEdit(flow)}
                          className="h-8 px-2 text-muted-foreground hover:text-primary"
                        >
                          <Pencil className="size-3.5" />
                          Edit
                        </Button>
                      )}
                      {flow.data_channel === 'data_exchange' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSourcesFlow(flow)}
                          className="h-8 px-2 text-muted-foreground hover:text-primary"
                        >
                          <Database className="size-3.5" />
                          Data sources
                        </Button>
                      )}
                      {isDraft && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handlePublish(flow)}
                          disabled={publishingId === flow.id || hasErrors}
                          className="h-8 px-2 text-muted-foreground hover:text-primary"
                          title={hasErrors ? 'Fix validation errors first' : 'Publish to Meta'}
                        >
                          {publishingId === flow.id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Rocket className="size-3.5" />
                          )}
                          Publish
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(flow)}
                        disabled={deletingId === flow.id}
                        className="h-8 px-2 text-muted-foreground hover:text-red-400"
                      >
                        {deletingId === flow.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Trash2 className="size-3.5" />
                        )}
                        Delete
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <FlowAuthoringDialog
        open={authoringOpen}
        onOpenChange={setAuthoringOpen}
        editing={editingFlow}
        onSaved={fetchFlows}
      />
      <FlowScreenSourcesDialog
        open={sourcesFlow !== null}
        onOpenChange={(o) => {
          if (!o) setSourcesFlow(null);
        }}
        flow={sourcesFlow}
      />
    </section>
  );
}
