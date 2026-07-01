import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { generateFlowKeyPair } from '@/lib/whatsapp/flow-crypto'
import {
  setBusinessPublicKey,
  getBusinessPublicKey,
} from '@/lib/whatsapp/meta-api'

// RSA-OAEP + generateKeyPairSync need the Node runtime, not Edge.
export const runtime = 'nodejs'

/**
 * Phase 0 of WhatsApp Flows authoring — the business encryption key.
 *
 * A Flow with a `data_exchange` channel needs an RSA key pair: Meta
 * encrypts each endpoint request's AES key with our public key, and
 * our data-exchange endpoint decrypts with the private key. This route
 * generates the pair, uploads the public half to Meta on the account's
 * phone number, and stores the private half encrypted at rest.
 *
 *   POST — (re)generate + upload + persist. Admin only (RLS).
 *   GET  — report current status for the settings UI.
 */

function endpointUrl(token: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') ?? ''
  return `${base}/api/whatsapp/flows/data-exchange/${token}`
}

async function resolveConfig(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) return { error: 'no_account' as const }

  const { data: config } = await supabase
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .single()
  return { accountId, config }
}

export async function GET() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json({ configured: false, reason: 'no_account' })
    }

    // RLS restricts this select to admins — a non-admin simply sees
    // `configured: false`, which is the correct "you can't manage this"
    // signal for the panel.
    const { data: key } = await supabase
      .from('whatsapp_flow_encryption_keys')
      .select('endpoint_token, uploaded_to_meta_at, signature_status, updated_at')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!key) {
      return NextResponse.json({ configured: false })
    }

    return NextResponse.json({
      configured: true,
      uploaded_to_meta_at: key.uploaded_to_meta_at,
      signature_status: key.signature_status,
      updated_at: key.updated_at,
      endpoint_url: endpointUrl(key.endpoint_token),
    })
  } catch (error) {
    console.error('Error reading flow encryption status:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read status' },
      { status: 500 },
    )
  }
}

export async function POST() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const resolved = await resolveConfig(supabase, user.id)
    if ('error' in resolved) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }
    const { accountId, config } = resolved

    if (!config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
        },
        { status: 400 },
      )
    }
    if (!config.phone_number_id) {
      return NextResponse.json(
        { error: 'Phone Number ID missing. Re-connect your account in Settings.' },
        { status: 400 },
      )
    }

    const accessToken = decrypt(config.access_token)

    // 1. Generate a fresh RSA-2048 pair.
    const { publicKeyPem, privateKeyPem } = generateFlowKeyPair()

    // 2. Upload the public key to Meta on this phone number.
    try {
      await setBusinessPublicKey({
        phoneNumberId: config.phone_number_id,
        accessToken,
        publicKeyPem,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Meta upload failed.'
      return NextResponse.json(
        { error: `Failed to upload public key to Meta: ${message}` },
        { status: 502 },
      )
    }

    // 3. Read the signature status back (best-effort — a transient read
    //    failure shouldn't lose the key we just uploaded + are about to
    //    persist).
    let signatureStatus: 'VALID' | 'MISMATCH' | null = null
    try {
      const info = await getBusinessPublicKey({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
      signatureStatus = info.business_public_key_signature_status ?? null
    } catch (err) {
      console.warn('[flows/encryption] status read-back failed:', err)
    }

    // 4. Persist: private key encrypted at rest, public key in the clear.
    //    Upsert on account_id (one key per account) — regenerating
    //    replaces the row and keeps the same endpoint_token unless it's
    //    the first time (DB default fills it on insert).
    const nowIso = new Date().toISOString()
    const { data: existing } = await supabase
      .from('whatsapp_flow_encryption_keys')
      .select('id, endpoint_token')
      .eq('account_id', accountId)
      .maybeSingle()

    const baseRow = {
      private_key_pem: encrypt(privateKeyPem),
      public_key_pem: publicKeyPem,
      phone_number_id: config.phone_number_id,
      uploaded_to_meta_at: nowIso,
      signature_status: signatureStatus,
    }

    let endpointToken: string
    if (existing?.id) {
      endpointToken = existing.endpoint_token as string
      const { error: updErr } = await supabase
        .from('whatsapp_flow_encryption_keys')
        .update(baseRow)
        .eq('id', existing.id)
      if (updErr) {
        return NextResponse.json({ error: updErr.message }, { status: 500 })
      }
    } else {
      const { data: inserted, error: insErr } = await supabase
        .from('whatsapp_flow_encryption_keys')
        .insert({ account_id: accountId, ...baseRow })
        .select('endpoint_token')
        .single()
      if (insErr || !inserted) {
        return NextResponse.json(
          { error: insErr?.message ?? 'Failed to store key.' },
          { status: 500 },
        )
      }
      endpointToken = inserted.endpoint_token as string
    }

    return NextResponse.json({
      success: true,
      signature_status: signatureStatus,
      endpoint_url: endpointUrl(endpointToken),
    })
  } catch (error) {
    console.error('Error configuring flow encryption:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to configure' },
      { status: 500 },
    )
  }
}
