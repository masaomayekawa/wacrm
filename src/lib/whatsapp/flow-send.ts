import crypto from 'node:crypto'

/**
 * Build the `interactive` payload for sending a WhatsApp Flow as a
 * message (POST /{phone-number-id}/messages). Kept pure + separate from
 * the network call so the payload shape is unit-testable.
 *
 * Format verified against Meta's "Sending a Flow" guide.
 *
 * NOTE: this is the low-level capability. Wiring it into a template's
 * FLOW button / the composer is a later step — this module just shapes
 * the payload and mints flow tokens.
 */

export interface FlowMessageParams {
  /** Meta's flow id (the `flow_id` on the flow). */
  flowId: string
  /** Our per-send token — carries the local flow row id (see mintFlowToken). */
  flowToken: string
  /** Button label that opens the flow. */
  flowCta: string
  bodyText: string
  headerText?: string
  footerText?: string
  /**
   * 'navigate' opens a fixed first screen; 'data_exchange' asks our
   * endpoint (via INIT) what to show first — required for dynamic flows.
   */
  flowAction?: 'navigate' | 'data_exchange'
  /** First screen id (required for data_exchange, optional for navigate). */
  firstScreen?: string
  /** Initial data passed to the first screen. */
  initialData?: Record<string, unknown>
  /** 'draft' lets you test an unpublished flow; defaults to 'published'. */
  mode?: 'draft' | 'published'
}

export interface FlowInteractivePayload {
  type: 'flow'
  header?: { type: 'text'; text: string }
  body: { text: string }
  footer?: { text: string }
  action: {
    name: 'flow'
    parameters: Record<string, unknown>
  }
}

export function buildFlowInteractive(
  params: FlowMessageParams,
): FlowInteractivePayload {
  const action = params.flowAction ?? 'navigate'
  const parameters: Record<string, unknown> = {
    flow_message_version: '3',
    flow_token: params.flowToken,
    flow_id: params.flowId,
    flow_cta: params.flowCta,
    flow_action: action,
  }
  if (params.mode) parameters.mode = params.mode

  // data_exchange REQUIRES a payload with screen + data; navigate may
  // include one to preset the entry screen.
  if (action === 'data_exchange' || params.firstScreen) {
    parameters.flow_action_payload = {
      ...(params.firstScreen ? { screen: params.firstScreen } : {}),
      data: params.initialData ?? {},
    }
  }

  const payload: FlowInteractivePayload = {
    type: 'flow',
    body: { text: params.bodyText },
    action: { name: 'flow', parameters },
  }
  if (params.headerText) payload.header = { type: 'text', text: params.headerText }
  if (params.footerText) payload.footer = { text: params.footerText }
  return payload
}

/**
 * Mint a flow token that embeds the local whatsapp_flows row id as a
 * prefix (`<flowId>.<random>`). The data-exchange endpoint parses the
 * prefix to know which flow's screen sources to use; the random suffix
 * makes each send unique so sessions don't collide. UUIDs contain '-'
 * but never '.', so the separator is unambiguous.
 */
export function mintFlowToken(whatsappFlowId: string): string {
  return `${whatsappFlowId}.${crypto.randomBytes(12).toString('hex')}`
}

/** Recover the local flow id embedded in a flow token. */
export function parseFlowTokenFlowId(flowToken: string): string | null {
  const [id] = flowToken.split('.')
  return id || null
}
