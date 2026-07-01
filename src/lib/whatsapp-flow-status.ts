/**
 * Shared display config for whatsapp_flows.status — Meta's raw WhatsApp
 * Flows enum (DRAFT / PUBLISHED / DEPRECATED / THROTTLED / BLOCKED).
 * Mirrors `src/lib/template-status.ts`'s pattern for message templates.
 */

import type { WhatsAppFlowStatus } from '@/types';

export interface FlowStatusDisplay {
  label: string;
  classes: string;
}

export const flowStatusConfig: Record<WhatsAppFlowStatus, FlowStatusDisplay> = {
  DRAFT: {
    label: 'Draft',
    classes: 'bg-slate-600/20 text-muted-foreground border-slate-600/30',
  },
  PUBLISHED: {
    label: 'Published',
    classes: 'bg-primary/20 text-primary border-primary/30',
  },
  DEPRECATED: {
    label: 'Deprecated',
    classes: 'bg-slate-700/30 text-muted-foreground border-slate-700/40',
  },
  THROTTLED: {
    label: 'Throttled',
    classes: 'bg-orange-600/20 text-orange-400 border-orange-600/30',
  },
  BLOCKED: {
    label: 'Blocked',
    classes: 'bg-red-600/20 text-red-400 border-red-600/30',
  },
};
