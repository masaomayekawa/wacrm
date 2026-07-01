import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import {
  decryptFlowRequest,
  encryptFlowResponse,
  FlowEndpointError,
  type FlowRequestBody,
} from '@/lib/whatsapp/flow-crypto'
import {
  runScreenSource,
  type ScreenSourceConfig,
} from '@/lib/whatsapp/flow-data-exchange'

// RSA-OAEP + AES-GCM need the Node runtime, and the body is
// signature-verified raw — no static optimisation.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Public data-exchange endpoint for WhatsApp Flows (`data_exchange`
 * channel). Meta POSTs an encrypted request here for every dynamic
 * screen; we decrypt, decide what the next screen shows, and return an
 * encrypted response.
 *
 * The `[token]` path segment is the account's `endpoint_token` — it
 * selects which account's RSA private key to decrypt with WITHOUT
 * exposing the internal account id, and lets an operator rotate the
 * public URL without touching account_id. Each published flow points
 * its `endpoint_uri` at this URL for its own account.
 *
 * ── Phase 1 scope ──────────────────────────────────────────────
 * This handler implements the CRYPTO + the `ping` health check that
 * Meta requires before a flow can be published. Real screen routing
 * (INIT / data_exchange / BACK → next screen from a configured data
 * source) is Phase 4 — those actions currently return a well-formed
 * "endpoint not configured" error so a misfire is legible rather than
 * a silent 500.
 *
 * Reference (verified): Meta's official endpoint sample
 *   https://github.com/WhatsApp/WhatsApp-Flows-Tools
 */

/** text/plain base64 body — Meta's required response envelope. */
function encryptedText(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  // 1. Verify Meta's signature over the EXACT raw bytes before doing
  //    any work — same HMAC(App Secret) scheme as the main webhook.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')
  if (!verifyMetaWebhookSignature(rawBody, signature)) {
    console.warn('[flow-endpoint] rejected request with invalid signature')
    return new Response('Invalid signature', { status: 401 })
  }

  // 2. Resolve the account's private key by endpoint token. Service-role
  //    client: a Meta-originated request carries no Supabase session.
  const admin = supabaseAdmin()
  const { data: keyRow, error: keyErr } = await admin
    .from('whatsapp_flow_encryption_keys')
    .select('private_key_pem, account_id')
    .eq('endpoint_token', token)
    .maybeSingle()

  if (keyErr || !keyRow) {
    // Unknown token — nothing to decrypt with. 432 isn't a Meta code;
    // a plain 404 is the honest answer for an unrecognised endpoint.
    console.warn('[flow-endpoint] no key for endpoint token')
    return new Response('Not found', { status: 404 })
  }

  let privatePem: string
  try {
    privatePem = decrypt(keyRow.private_key_pem as string)
  } catch (err) {
    console.error('[flow-endpoint] failed to decrypt stored private key:', err)
    return new Response('Server misconfigured', { status: 500 })
  }

  // 3. Parse + decrypt the encrypted envelope.
  let encryptedBody: Record<string, unknown>
  try {
    encryptedBody = JSON.parse(rawBody)
  } catch {
    return new Response('Invalid JSON', { status: 400 })
  }

  let decrypted
  try {
    decrypted = decryptFlowRequest(encryptedBody, privatePem)
  } catch (err) {
    if (err instanceof FlowEndpointError) {
      // 421 → Meta refreshes our public key and retries.
      return new Response(err.message, { status: err.statusCode })
    }
    console.error('[flow-endpoint] decrypt failed:', err)
    return new Response('Bad request', { status: 400 })
  }

  const { decryptedBody, aesKeyBuffer, initialVectorBuffer } = decrypted

  // 4. Dispatch on action.
  const responsePayload = await dispatchFlowAction(
    decryptedBody,
    keyRow.account_id as string,
    admin,
  )

  // 5. Encrypt + return as text/plain base64.
  const encryptedResponse = encryptFlowResponse(
    responsePayload,
    aesKeyBuffer,
    initialVectorBuffer,
  )
  return encryptedText(encryptedResponse)
}

/** The screen id used for a flow's initial (INIT) data load. */
const INIT_TRIGGER = '__INIT__'

/**
 * Decide the response payload for a decrypted Flow request.
 *
 *   - `ping`  → Meta's health check.
 *   - `INIT`  → initial data load (trigger screen `__INIT__`).
 *   - `data_exchange` → a screen was submitted; fetch the next screen's
 *      data from its configured external source.
 *   - `BACK`  → treated like a re-fetch of the target screen if a
 *      source exists, else acknowledged.
 *
 * The flow is identified by the prefix of `flow_token` (`<flowId>.<rand>`),
 * generated at send time (and settable in Meta's preview tool). Screen
 * routing is driven entirely by the per-screen sources configured in
 * Settings — no code change per flow.
 */
async function dispatchFlowAction(
  body: FlowRequestBody,
  accountId: string,
  admin: SupabaseClient,
): Promise<Record<string, unknown>> {
  if (body.action === 'ping') {
    // Meta's health check — the only response shape it accepts.
    return { data: { status: 'active' } }
  }

  const flowId = body.flow_token?.split('.')[0]
  if (!flowId) {
    return errorResponse(body, 'Missing flow reference in flow_token.')
  }

  const triggerScreen = body.action === 'INIT' ? INIT_TRIGGER : body.screen
  if (!triggerScreen) {
    return errorResponse(body, 'No screen provided for data exchange.')
  }

  // Load the per-screen source, scoped to this account + flow.
  const { data: src } = await admin
    .from('whatsapp_flow_screen_sources')
    .select('*')
    .eq('account_id', accountId)
    .eq('whatsapp_flow_id', flowId)
    .eq('trigger_screen', triggerScreen)
    .maybeSingle()

  if (!src) {
    console.warn(
      `[flow-endpoint] no screen source for flow ${flowId} / screen ${triggerScreen}`,
    )
    return errorResponse(
      body,
      'This screen is not configured to fetch data yet.',
    )
  }

  // Decrypt the stored headers (may carry an API key).
  let headers: Record<string, string> = {}
  if (src.request_headers_encrypted) {
    try {
      headers = JSON.parse(decrypt(src.request_headers_encrypted as string))
    } catch (err) {
      console.error('[flow-endpoint] header decrypt/parse failed:', err)
    }
  }

  const config: ScreenSourceConfig = {
    trigger_screen: src.trigger_screen,
    next_screen: src.next_screen,
    request_url: src.request_url,
    request_method: src.request_method,
    headers,
    forward_fields: Array.isArray(src.forward_fields) ? src.forward_fields : [],
    response_items_path: src.response_items_path,
    response_target_key: src.response_target_key,
    item_id_field: src.item_id_field,
    item_title_field: src.item_title_field,
  }

  try {
    const result = await runScreenSource(config, body.data ?? {})
    return {
      version: body.version,
      screen: result.screen,
      data: result.data,
    }
  } catch (err) {
    console.error('[flow-endpoint] screen source fetch failed:', err)
    return errorResponse(body, 'Could not load data. Please try again.')
  }
}

/**
 * A response that surfaces a message to the user without breaking the
 * flow. Meta renders `error_message` in the current screen's error slot.
 */
function errorResponse(
  body: FlowRequestBody,
  message: string,
): Record<string, unknown> {
  return {
    version: body.version,
    data: { error_message: message, acknowledged: true },
  }
}
