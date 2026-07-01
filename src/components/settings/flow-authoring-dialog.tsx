'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  WHATSAPP_FLOW_CATEGORIES,
  type WhatsAppFlow,
  type WhatsAppFlowCategory,
} from '@/types';

interface FlowValidationError {
  message?: string;
  error?: string;
  line_start?: number;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Non-null when editing an existing authored DRAFT. */
  editing: WhatsAppFlow | null;
  onSaved: () => void;
}

export function FlowAuthoringDialog({ open, onOpenChange, editing, onSaved }: Props) {
  const [name, setName] = useState('');
  const [categories, setCategories] = useState<WhatsAppFlowCategory[]>([]);
  const [dataChannel, setDataChannel] = useState<'static' | 'data_exchange'>(
    'data_exchange',
  );
  const [flowJson, setFlowJson] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<FlowValidationError[]>([]);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setName(editing.name);
      setCategories((editing.categories ?? []) as WhatsAppFlowCategory[]);
      setDataChannel(editing.data_channel);
      setFlowJson(
        editing.flow_json ? JSON.stringify(editing.flow_json, null, 2) : '',
      );
    } else {
      setName('');
      setCategories([]);
      setDataChannel('data_exchange');
      setFlowJson('');
    }
    setValidationErrors([]);
  }, [open, editing]);

  function toggleCategory(cat: WhatsAppFlowCategory) {
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
  }

  async function handleSubmit() {
    if (!name.trim()) {
      toast.error('Flow name is required.');
      return;
    }
    if (categories.length === 0) {
      toast.error('Pick at least one category.');
      return;
    }
    setSubmitting(true);
    setValidationErrors([]);
    try {
      const isEdit = editing !== null;
      const url = isEdit
        ? `/api/whatsapp/flows/${editing.id}`
        : '/api/whatsapp/flows';
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          categories,
          data_channel: dataChannel,
          flow_json: flowJson.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || `Failed (HTTP ${res.status})`);
      }
      const errs: FlowValidationError[] = data.validation_errors ?? [];
      setValidationErrors(errs);
      if (errs.length > 0) {
        toast.warning(
          `Saved as draft, but Meta flagged ${errs.length} validation issue(s). Fix them before publishing.`,
        );
      } else {
        toast.success(isEdit ? 'Flow updated.' : 'Flow created as draft.');
        onOpenChange(false);
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save flow');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {editing ? 'Edit WhatsApp Flow' : 'New WhatsApp Flow'}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Build the Flow JSON in Meta&apos;s Flow Builder, then paste it here.
            wacrm creates it on Meta, validates it, and (for dynamic flows) wires
            it to your data-exchange endpoint. Publishing is a separate step.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="text-muted-foreground">Flow name</Label>
            <Input
              placeholder="e.g. appointment_booking"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="bg-muted border-border text-foreground"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Categories</Label>
            <div className="flex flex-wrap gap-2">
              {WHATSAPP_FLOW_CATEGORIES.map((cat) => {
                const active = categories.includes(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => toggleCategory(cat)}
                    className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                      active
                        ? 'border-primary/40 bg-primary/20 text-primary'
                        : 'border-border bg-muted text-muted-foreground hover:bg-muted/70'
                    }`}
                  >
                    {cat}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Data channel</Label>
            <div className="flex gap-2">
              {(['data_exchange', 'static'] as const).map((dc) => (
                <button
                  key={dc}
                  type="button"
                  onClick={() => setDataChannel(dc)}
                  className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                    dataChannel === dc
                      ? 'border-primary/40 bg-primary/20 text-primary'
                      : 'border-border bg-muted text-muted-foreground hover:bg-muted/70'
                  }`}
                >
                  {dc === 'data_exchange' ? 'Dynamic (data_exchange)' : 'Static'}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {dataChannel === 'data_exchange'
                ? 'Screens fetch data from your endpoint at runtime. Requires the encryption key (above) and per-screen data sources (configured after saving).'
                : 'Self-contained flow — no server round-trips.'}
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Flow JSON</Label>
            <Textarea
              placeholder='{"version": "3.0", "screens": [ ... ]}'
              value={flowJson}
              onChange={(e) => setFlowJson(e.target.value)}
              rows={12}
              className="bg-muted border-border text-foreground font-mono text-xs resize-none"
            />
            <p className="text-[11px] text-muted-foreground">
              Paste the JSON exported from Meta&apos;s Flow Builder. Leave empty
              to create an empty draft and add the JSON later.
            </p>
          </div>

          {validationErrors.length > 0 && (
            <div className="space-y-1.5 rounded border border-red-900/40 bg-red-950/20 p-3">
              <div className="flex items-center gap-1.5 text-xs font-medium text-red-400">
                <AlertCircle className="size-3.5" />
                Meta validation errors
              </div>
              <ul className="space-y-1 text-[11px] text-red-300">
                {validationErrors.slice(0, 8).map((e, i) => (
                  <li key={i}>
                    {e.line_start ? `Line ${e.line_start}: ` : ''}
                    {e.message || e.error || 'Unknown error'}
                  </li>
                ))}
                {validationErrors.length > 8 && (
                  <li>+{validationErrors.length - 8} more…</li>
                )}
              </ul>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving…
              </>
            ) : editing ? (
              'Save changes'
            ) : (
              'Create draft'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
