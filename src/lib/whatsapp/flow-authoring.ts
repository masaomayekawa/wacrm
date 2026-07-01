import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from './encryption'

/**
 * Shared resolver for the WhatsApp Flows authoring routes.
 *
 * Every authoring call needs the same context: the caller's account,
 * their WABA id + phone number, a decrypted access token, and — for
 * `data_exchange` flows — the account's data-exchange endpoint URL
 * (built from the encryption key's rotatable endpoint_token, Phase 0).
 */

export interface FlowAuthoringContext {
  accountId: string
  wabaId: string
  phoneNumberId: string
  accessToken: string
  /** null when the account hasn't generated an encryption key yet. */
  endpointUrl: string | null
}

export type FlowAuthoringResolution =
  | { ok: true; ctx: FlowAuthoringContext }
  | { ok: false; status: number; error: string }

function endpointUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ?? ''
  return `${base}/api/whatsapp/flows/data-exchange/${token}`
}

export async function resolveFlowAuthoringContext(
  supabase: SupabaseClient,
  userId: string,
): Promise<FlowAuthoringResolution> {
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) {
    return {
      ok: false,
      status: 403,
      error: 'Your profile is not linked to an account.',
    }
  }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single()
  if (!config) {
    return {
      ok: false,
      status: 400,
      error:
        'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
    }
  }
  if (!config.waba_id) {
    return {
      ok: false,
      status: 400,
      error: 'WABA ID missing. Re-connect your account in Settings.',
    }
  }

  const { data: key } = await supabase
    .from('whatsapp_flow_encryption_keys')
    .select('endpoint_token')
    .eq('account_id', accountId)
    .maybeSingle()

  return {
    ok: true,
    ctx: {
      accountId,
      wabaId: config.waba_id as string,
      phoneNumberId: config.phone_number_id as string,
      accessToken: decrypt(config.access_token as string),
      endpointUrl: key?.endpoint_token
        ? endpointUrl(key.endpoint_token as string)
        : null,
    },
  }
}
