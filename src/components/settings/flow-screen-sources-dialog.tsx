'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { WhatsAppFlow } from '@/types';

interface SourceRow {
  id: string;
  trigger_screen: string;
  next_screen: string;
  request_url: string;
  request_method: 'GET' | 'POST';
  forward_fields: string[];
  response_items_path?: string | null;
  response_target_key: string;
  item_id_field?: string | null;
  item_title_field?: string | null;
  has_headers: boolean;
}

interface DraftSource {
  trigger_screen: string;
  next_screen: string;
  request_url: string;
  request_method: 'GET' | 'POST';
  forward_fields: string; // comma-separated in the form
  response_items_path: string;
  response_target_key: string;
  item_id_field: string;
  item_title_field: string;
  api_key_header: string; // e.g. "Authorization"
  api_key_value: string; // e.g. "Bearer xxx"
}

const emptyDraft: DraftSource = {
  trigger_screen: '',
  next_screen: '',
  request_url: '',
  request_method: 'GET',
  forward_fields: '',
  response_items_path: '',
  response_target_key: '',
  item_id_field: '',
  item_title_field: '',
  api_key_header: '',
  api_key_value: '',
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  flow: WhatsAppFlow | null;
}

export function FlowScreenSourcesDialog({ open, onOpenChange, flow }: Props) {
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [draft, setDraft] = useState<DraftSource>(emptyDraft);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!flow) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/whatsapp/flows/${flow.id}/screen-sources`);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to load');
      setSources(data.sources ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load sources');
    } finally {
      setLoading(false);
    }
  }, [flow]);

  useEffect(() => {
    if (open && flow) {
      load();
      setDraft(emptyDraft);
    }
  }, [open, flow, load]);

  async function addSource() {
    if (!flow) return;
    if (!draft.trigger_screen || !draft.next_screen || !draft.request_url || !draft.response_target_key) {
      toast.error('Trigger screen, next screen, request URL and target key are required.');
      return;
    }
    setSaving(true);
    try {
      const headers =
        draft.api_key_header && draft.api_key_value
          ? { [draft.api_key_header]: draft.api_key_value }
          : undefined;
      const res = await fetch(`/api/whatsapp/flows/${flow.id}/screen-sources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger_screen: draft.trigger_screen.trim(),
          next_screen: draft.next_screen.trim(),
          request_url: draft.request_url.trim(),
          request_method: draft.request_method,
          forward_fields: draft.forward_fields
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          response_items_path: draft.response_items_path.trim() || undefined,
          response_target_key: draft.response_target_key.trim(),
          item_id_field: draft.item_id_field.trim() || undefined,
          item_title_field: draft.item_title_field.trim() || undefined,
          headers,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Failed to add source');
      toast.success('Data source added.');
      setDraft(emptyDraft);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add source');
    } finally {
      setSaving(false);
    }
  }

  async function deleteSource(sourceId: string) {
    if (!flow) return;
    try {
      const res = await fetch(
        `/api/whatsapp/flows/${flow.id}/screen-sources/${sourceId}`,
        { method: 'DELETE' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || 'Failed to delete');
      setSources((prev) => prev.filter((s) => s.id !== sourceId));
      toast.success('Source removed.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete source');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            Data sources — {flow?.name}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            For each dynamic screen, tell the endpoint which external API to call
            and how to map fields. Use <code>__INIT__</code> as the trigger for the
            flow&apos;s initial data load.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-4">
            {sources.length > 0 && (
              <div className="space-y-2">
                {sources.map((s) => (
                  <div
                    key={s.id}
                    className="rounded border border-border bg-muted/40 p-3 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-foreground">
                        {s.trigger_screen} → {s.next_screen}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteSource(s.id)}
                        className="size-7 text-muted-foreground hover:text-red-400"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                    <p className="text-muted-foreground">
                      {s.request_method} {s.request_url}
                      {s.has_headers ? ' · 🔑 auth set' : ''}
                    </p>
                    <p className="text-muted-foreground">
                      forwards [{s.forward_fields.join(', ') || '—'}] → exposes{' '}
                      <code>{s.response_target_key}</code>
                      {s.response_items_path ? ` (from ${s.response_items_path})` : ''}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* Add-source form */}
            <div className="rounded border border-border p-3 space-y-3">
              <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
                <Plus className="size-3.5" />
                Add data source
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Trigger screen (or __INIT__)">
                  <Input
                    value={draft.trigger_screen}
                    onChange={(e) => setDraft({ ...draft, trigger_screen: e.target.value })}
                    placeholder="DEPARTMENT"
                    className="bg-muted border-border text-foreground h-8 text-xs"
                  />
                </Field>
                <Field label="Next screen">
                  <Input
                    value={draft.next_screen}
                    onChange={(e) => setDraft({ ...draft, next_screen: e.target.value })}
                    placeholder="PICK_TIME"
                    className="bg-muted border-border text-foreground h-8 text-xs"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <Field label="Request URL">
                  <Input
                    value={draft.request_url}
                    onChange={(e) => setDraft({ ...draft, request_url: e.target.value })}
                    placeholder="https://api.example.com/slots"
                    className="bg-muted border-border text-foreground h-8 text-xs"
                  />
                </Field>
                <Field label="Method">
                  <Select
                    value={draft.request_method}
                    onValueChange={(v) =>
                      setDraft({ ...draft, request_method: (v as 'GET' | 'POST') || 'GET' })
                    }
                  >
                    <SelectTrigger className="w-24 bg-muted border-border text-foreground h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-popover border-border">
                      <SelectItem value="GET">GET</SelectItem>
                      <SelectItem value="POST">POST</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label="Forward fields (comma-separated field names from the screen)">
                <Input
                  value={draft.forward_fields}
                  onChange={(e) => setDraft({ ...draft, forward_fields: e.target.value })}
                  placeholder="department, date"
                  className="bg-muted border-border text-foreground h-8 text-xs"
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Response items path (dot path, optional)">
                  <Input
                    value={draft.response_items_path}
                    onChange={(e) =>
                      setDraft({ ...draft, response_items_path: e.target.value })
                    }
                    placeholder="data"
                    className="bg-muted border-border text-foreground h-8 text-xs"
                  />
                </Field>
                <Field label="Expose under key (next screen data)">
                  <Input
                    value={draft.response_target_key}
                    onChange={(e) =>
                      setDraft({ ...draft, response_target_key: e.target.value })
                    }
                    placeholder="available_times"
                    className="bg-muted border-border text-foreground h-8 text-xs"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Item id field (for dropdowns)">
                  <Input
                    value={draft.item_id_field}
                    onChange={(e) => setDraft({ ...draft, item_id_field: e.target.value })}
                    placeholder="slot_id"
                    className="bg-muted border-border text-foreground h-8 text-xs"
                  />
                </Field>
                <Field label="Item title field">
                  <Input
                    value={draft.item_title_field}
                    onChange={(e) =>
                      setDraft({ ...draft, item_title_field: e.target.value })
                    }
                    placeholder="label"
                    className="bg-muted border-border text-foreground h-8 text-xs"
                  />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Auth header name (optional)">
                  <Input
                    value={draft.api_key_header}
                    onChange={(e) => setDraft({ ...draft, api_key_header: e.target.value })}
                    placeholder="Authorization"
                    className="bg-muted border-border text-foreground h-8 text-xs"
                  />
                </Field>
                <Field label="Auth header value (stored encrypted)">
                  <Input
                    type="password"
                    value={draft.api_key_value}
                    onChange={(e) => setDraft({ ...draft, api_key_value: e.target.value })}
                    placeholder="Bearer sk_live_…"
                    className="bg-muted border-border text-foreground h-8 text-xs"
                  />
                </Field>
              </div>
              <Button onClick={addSource} disabled={saving} size="sm">
                {saving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Saving…
                  </>
                ) : (
                  <>
                    <Save className="size-4" />
                    Add source
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
