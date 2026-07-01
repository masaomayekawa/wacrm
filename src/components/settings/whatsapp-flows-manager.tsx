'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Loader2 } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import type { WhatsAppFlow } from '@/types';
import { flowStatusConfig } from '@/lib/whatsapp-flow-status';

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

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setLoading(false);
      return;
    }
    fetchFlows();
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
          'Read-only roster of your PUBLISHED WhatsApp Flows from Meta Business Manager. Unrelated to the local Flows automation builder — Meta hosts and runs these. Use "Sync from Meta" after publishing or updating a flow.'
        }
        action={
          <Button
            variant="outline"
            onClick={handleSyncFromMeta}
            disabled={syncing}
            title="Pull published WhatsApp Flows from your Meta Business Account"
          >
            <RefreshCw className={`size-4 ${syncing ? 'animate-spin' : ''}`} />
            {syncing ? 'Syncing…' : 'Sync from Meta'}
          </Button>
        }
      />

      {flows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-muted-foreground text-sm">No published flows synced yet.</p>
            <p className="text-muted-foreground text-xs mt-1">
              Publish a flow in Meta Business Manager, then click &quot;Sync from Meta&quot;.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {flows.map((flow) => {
            const status = flowStatusConfig[flow.status];
            return (
              <Card key={flow.id}>
                <CardContent className="space-y-2 pt-4">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="font-medium text-foreground">{flow.name}</h3>
                    <Badge className={`text-xs border ${status.classes}`}>
                      {status.label}
                    </Badge>
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
                  <p className="text-xs text-muted-foreground">
                    Last synced {new Date(flow.synced_at).toLocaleString()}
                  </p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
