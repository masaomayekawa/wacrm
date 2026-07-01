import { describe, expect, it, vi } from 'vitest'
import {
  runScreenSource,
  getByPath,
  type ScreenSourceConfig,
} from './flow-data-exchange'

function source(overrides: Partial<ScreenSourceConfig> = {}): ScreenSourceConfig {
  return {
    trigger_screen: 'DEPARTMENT',
    next_screen: 'PICK_TIME',
    request_url: 'https://appts.example.com/slots',
    request_method: 'GET',
    headers: { Authorization: 'Bearer api-key-123' },
    forward_fields: ['department', 'date'],
    response_items_path: 'data',
    response_target_key: 'available_times',
    item_id_field: 'slot_id',
    item_title_field: 'label',
    ...overrides,
  }
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response
}

describe('getByPath', () => {
  it('reads a nested dot path', () => {
    expect(getByPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42)
  })
  it('returns the whole value for empty path', () => {
    expect(getByPath({ x: 1 }, '')).toEqual({ x: 1 })
    expect(getByPath({ x: 1 })).toEqual({ x: 1 })
  })
  it('returns undefined for a missing path', () => {
    expect(getByPath({ a: 1 }, 'a.b.c')).toBeUndefined()
  })
})

describe('runScreenSource — GET', () => {
  it('forwards selected fields as query params and shapes the response', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        'https://appts.example.com/slots?department=cardiology&date=2026-07-10',
      )
      expect(init?.method).toBe('GET')
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        'Bearer api-key-123',
      )
      return jsonResponse({
        data: [
          { slot_id: 's1', label: '9:00 AM' },
          { slot_id: 's2', label: '10:30 AM' },
        ],
      })
    })

    const result = await runScreenSource(
      source(),
      { department: 'cardiology', date: '2026-07-10', ignored: 'x' },
      fetchImpl as unknown as typeof fetch,
    )

    expect(result).toEqual({
      screen: 'PICK_TIME',
      data: {
        available_times: [
          { id: 's1', title: '9:00 AM' },
          { id: 's2', title: '10:30 AM' },
        ],
      },
    })
  })

  it('only forwards fields present in the incoming data', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      // `date` absent → not appended
      expect(String(url)).toBe('https://appts.example.com/slots?department=cardiology')
      return jsonResponse({ data: [] })
    })
    await runScreenSource(
      source(),
      { department: 'cardiology' },
      fetchImpl as unknown as typeof fetch,
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

describe('runScreenSource — POST', () => {
  it('sends forwarded fields as a JSON body', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(init?.body as string)).toEqual({ department: 'cardiology' })
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json',
      )
      return jsonResponse({ data: [] })
    })
    await runScreenSource(
      source({ request_method: 'POST' }),
      { department: 'cardiology' },
      fetchImpl as unknown as typeof fetch,
    )
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

describe('runScreenSource — passthrough (no id/title shaping)', () => {
  it('exposes the raw extracted value when item fields are unset', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ result: { greeting: 'hola' } }),
    )
    const result = await runScreenSource(
      source({
        response_items_path: 'result',
        response_target_key: 'payload',
        item_id_field: null,
        item_title_field: null,
      }),
      {},
      fetchImpl as unknown as typeof fetch,
    )
    expect(result.data).toEqual({ payload: { greeting: 'hola' } })
  })
})

describe('runScreenSource — external error', () => {
  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false))
    await expect(
      runScreenSource(source(), {}, fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('External API returned 500')
  })
})
