import { encrypt } from './encryption'

/**
 * Validate + shape a screen-source payload into a DB row for
 * `whatsapp_flow_screen_sources`. Shared by the create (POST) and edit
 * (PATCH) routes. `headers` is encrypted at rest; omit it on PATCH to
 * leave the existing (possibly API-key-bearing) headers untouched.
 */
export function buildScreenSourceRow(
  body: Record<string, unknown>,
  accountId: string,
  flowId: string,
): { value: Record<string, unknown> } | { error: string } {
  const triggerScreen =
    typeof body.trigger_screen === 'string' ? body.trigger_screen.trim() : ''
  const nextScreen =
    typeof body.next_screen === 'string' ? body.next_screen.trim() : ''
  const requestUrl =
    typeof body.request_url === 'string' ? body.request_url.trim() : ''
  const method = body.request_method === 'POST' ? 'POST' : 'GET'
  const responseTargetKey =
    typeof body.response_target_key === 'string'
      ? body.response_target_key.trim()
      : ''

  if (!triggerScreen) return { error: 'Trigger screen is required.' }
  if (!nextScreen) return { error: 'Next screen is required.' }
  if (!requestUrl) return { error: 'Request URL is required.' }
  if (!responseTargetKey) return { error: 'Response target key is required.' }
  try {
    const u = new URL(requestUrl)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      return { error: 'Request URL must be http(s).' }
    }
  } catch {
    return { error: 'Request URL is not a valid URL.' }
  }

  const forwardFields = Array.isArray(body.forward_fields)
    ? body.forward_fields.filter((f): f is string => typeof f === 'string')
    : []

  const value: Record<string, unknown> = {
    account_id: accountId,
    whatsapp_flow_id: flowId,
    trigger_screen: triggerScreen,
    next_screen: nextScreen,
    request_url: requestUrl,
    request_method: method,
    forward_fields: forwardFields,
    response_items_path:
      typeof body.response_items_path === 'string'
        ? body.response_items_path.trim() || null
        : null,
    response_target_key: responseTargetKey,
    item_id_field:
      typeof body.item_id_field === 'string'
        ? body.item_id_field.trim() || null
        : null,
    item_title_field:
      typeof body.item_title_field === 'string'
        ? body.item_title_field.trim() || null
        : null,
  }

  if (body.headers && typeof body.headers === 'object') {
    value.request_headers_encrypted = encrypt(JSON.stringify(body.headers))
  }

  return { value }
}
