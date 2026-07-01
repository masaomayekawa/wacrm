/**
 * The data_exchange engine — turns a submitted screen into the next
 * screen's data by calling a configured external API.
 *
 * Kept pure and dependency-injected (the fetch impl is a parameter) so
 * the field-mapping logic is unit-testable without a live API or DB.
 * The route layer (data-exchange/[token]) loads the config + decrypts
 * headers, then calls `runScreenSource`.
 *
 * WhatsApp dropdowns/radios bind to an array of `{ id, title }`; a
 * screen source can shape an arbitrary API array into that form via
 * `item_id_field` / `item_title_field`.
 */

export interface ScreenSourceConfig {
  trigger_screen: string
  next_screen: string
  request_url: string
  request_method: 'GET' | 'POST'
  /** Decrypted headers (may carry an API key). */
  headers: Record<string, string>
  forward_fields: string[]
  response_items_path?: string | null
  response_target_key: string
  item_id_field?: string | null
  item_title_field?: string | null
}

export interface DataExchangeResult {
  screen: string
  data: Record<string, unknown>
}

/** Read a dot-path (`a.b.c`) out of a nested object; '' / undefined → whole value. */
export function getByPath(value: unknown, path?: string | null): unknown {
  if (!path) return value
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, value)
}

/** Pull only the forward_fields out of the incoming screen data. */
function pickForwarded(
  data: Record<string, unknown>,
  fields: string[],
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields) {
    const v = data[f]
    if (v !== undefined && v !== null) out[f] = String(v)
  }
  return out
}

/**
 * Shape an extracted API value for the next screen. When id/title fields
 * are configured AND the value is an array, map each item to Meta's
 * `{ id, title }` shape; otherwise pass the value through untouched.
 */
function shapeResponse(
  extracted: unknown,
  source: ScreenSourceConfig,
): unknown {
  const { item_id_field, item_title_field } = source
  if (item_id_field && item_title_field && Array.isArray(extracted)) {
    return extracted.map((item) => {
      const rec = (item ?? {}) as Record<string, unknown>
      return {
        id: String(rec[item_id_field] ?? ''),
        title: String(rec[item_title_field] ?? ''),
      }
    })
  }
  return extracted
}

/**
 * Execute one screen source: forward the chosen fields to the external
 * API, shape the response, and return the next screen + its data.
 *
 * @throws Error on a non-2xx external response (caller maps to an error
 *         screen so the user sees a message, not a broken flow).
 */
export async function runScreenSource(
  source: ScreenSourceConfig,
  incomingData: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<DataExchangeResult> {
  const forwarded = pickForwarded(incomingData, source.forward_fields)

  let url = source.request_url
  const init: RequestInit = {
    method: source.request_method,
    headers: { ...source.headers },
  }

  if (source.request_method === 'GET') {
    const qs = new URLSearchParams(forwarded).toString()
    if (qs) url += (url.includes('?') ? '&' : '?') + qs
  } else {
    init.headers = { ...source.headers, 'Content-Type': 'application/json' }
    init.body = JSON.stringify(forwarded)
  }

  const res = await fetchImpl(url, init)
  if (!res.ok) {
    throw new Error(`External API returned ${res.status}`)
  }
  const json = await res.json()

  const extracted = getByPath(json, source.response_items_path)
  const shaped = shapeResponse(extracted, source)

  return {
    screen: source.next_screen,
    data: { [source.response_target_key]: shaped },
  }
}
