import { describe, expect, it } from 'vitest'
import {
  buildFlowInteractive,
  mintFlowToken,
  parseFlowTokenFlowId,
} from './flow-send'

describe('buildFlowInteractive', () => {
  it('builds a navigate payload with the required parameters', () => {
    const payload = buildFlowInteractive({
      flowId: '123456',
      flowToken: 'flow-1.abcdef',
      flowCta: 'Book appointment',
      bodyText: 'Tap below to book.',
    })
    expect(payload.type).toBe('flow')
    expect(payload.body).toEqual({ text: 'Tap below to book.' })
    expect(payload.action.name).toBe('flow')
    expect(payload.action.parameters).toMatchObject({
      flow_message_version: '3',
      flow_token: 'flow-1.abcdef',
      flow_id: '123456',
      flow_cta: 'Book appointment',
      flow_action: 'navigate',
    })
    // navigate without a first screen omits the payload
    expect(payload.action.parameters.flow_action_payload).toBeUndefined()
  })

  it('includes flow_action_payload with screen+data for data_exchange', () => {
    const payload = buildFlowInteractive({
      flowId: '123456',
      flowToken: 'flow-1.abcdef',
      flowCta: 'Start',
      bodyText: 'Begin',
      flowAction: 'data_exchange',
      firstScreen: 'DEPARTMENT',
      initialData: { locale: 'es' },
    })
    expect(payload.action.parameters.flow_action).toBe('data_exchange')
    expect(payload.action.parameters.flow_action_payload).toEqual({
      screen: 'DEPARTMENT',
      data: { locale: 'es' },
    })
  })

  it('adds header/footer and mode when provided', () => {
    const payload = buildFlowInteractive({
      flowId: '1',
      flowToken: 't',
      flowCta: 'Go',
      bodyText: 'b',
      headerText: 'Welcome',
      footerText: 'Powered by wacrm',
      mode: 'draft',
    })
    expect(payload.header).toEqual({ type: 'text', text: 'Welcome' })
    expect(payload.footer).toEqual({ text: 'Powered by wacrm' })
    expect(payload.action.parameters.mode).toBe('draft')
  })
})

describe('flow token round-trip', () => {
  it('mints a token embedding the flow id and parses it back', () => {
    const flowId = '7fbd09c1-c8d1-472d-988b-c819b4f14cff'
    const token = mintFlowToken(flowId)
    expect(token.startsWith(`${flowId}.`)).toBe(true)
    expect(parseFlowTokenFlowId(token)).toBe(flowId)
  })

  it('returns null for an empty token', () => {
    expect(parseFlowTokenFlowId('')).toBeNull()
  })
})
