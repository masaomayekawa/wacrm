import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { decrypt } from '@/lib/whatsapp/encryption'

/**
 * Sync WhatsApp Flows from Meta → local `whatsapp_flows` table.
 *
 * Unrelated to this app's own local automation Flows (`flows` /
 * `flow_nodes` / `flow_runs`) — this is Meta's WhatsApp Flows product
 * (interactive forms authored and published in Meta Business
 * Manager). See migration 027 for why they live in a separate table.
 *
 * Only PUBLISHED flows are kept locally — a DRAFT flow can't be sent
 * to a customer, and a flow that later moves off PUBLISHED
 * (DEPRECATED / THROTTLED / BLOCKED) is removed from the local table
 * on the next sync so the roster never shows a stale "usable" flow.
 */

const META_API_VERSION = 'v21.0'
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`

interface MetaFlow {
  id: string
  name: string
  status: string
  categories?: string[]
  validation_errors?: unknown
  json_version?: string
  data_api_version?: string
  endpoint_uri?: string
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

    // Resolve the caller's account_id — both whatsapp_config and the
    // whatsapp_flows we sync into are account-scoped.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
        },
        { status: 400 },
      )
    }

    if (!config.waba_id) {
      return NextResponse.json(
        {
          error:
            'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
        },
        { status: 400 },
      )
    }

    const accessToken = decrypt(config.access_token)

    const metaFlows: MetaFlow[] = []
    let nextUrl: string | null =
      `${META_API_BASE}/${config.waba_id}/flows?limit=100&fields=id,name,status,categories,validation_errors,json_version,data_api_version,endpoint_uri`
    const PAGE_CAP = 20
    let pageCount = 0

    while (nextUrl && pageCount < PAGE_CAP) {
      pageCount++
      const metaRes: Response = await fetch(nextUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!metaRes.ok) {
        let metaErr = `Meta API error: ${metaRes.status}`
        try {
          const errBody = await metaRes.json()
          if (errBody?.error?.message) metaErr = errBody.error.message
        } catch {
          // response wasn't JSON — keep the fallback
        }
        return NextResponse.json({ error: metaErr }, { status: 502 })
      }

      const metaBody: {
        data?: MetaFlow[]
        paging?: { next?: string }
      } = await metaRes.json()
      if (metaBody.data) metaFlows.push(...metaBody.data)
      nextUrl = metaBody.paging?.next ?? null
    }

    let inserted = 0
    let updated = 0
    let removed = 0
    let skipped = 0
    const errors: { name: string; message: string }[] = []

    for (const f of metaFlows) {
      const isPublished = f.status?.toUpperCase() === 'PUBLISHED'

      if (!isPublished) {
        skipped++
        // If a previously-synced flow has moved off PUBLISHED, drop it
        // from the local roster so "Sync from Meta" never leaves a
        // stale, no-longer-usable flow marked as available. Scope the
        // delete to origin='synced' so an AUTHORED draft (created in
        // wacrm, migration 029) is never destroyed by a sync — those
        // rows are owned by the authoring flow, not the read-only sync.
        // The (account_id, meta_flow_id) unique index means this matches
        // at most one row, so a plain success check is enough.
        const { data: deleted, error: delErr } = await supabase
          .from('whatsapp_flows')
          .delete()
          .eq('account_id', accountId)
          .eq('meta_flow_id', f.id)
          .eq('origin', 'synced')
          .select('id')
        if (delErr) {
          errors.push({ name: f.name, message: delErr.message })
        } else if (deleted && deleted.length > 0) {
          removed += deleted.length
        }
        continue
      }

      const row = {
        account_id: accountId,
        synced_by: user.id,
        meta_flow_id: f.id,
        name: f.name,
        status: f.status.toUpperCase(),
        categories: f.categories ?? null,
        json_version: f.json_version ?? null,
        data_api_version: f.data_api_version ?? null,
        endpoint_uri: f.endpoint_uri ?? null,
        validation_errors: f.validation_errors ?? null,
        synced_at: new Date().toISOString(),
      }

      const { data: existing, error: lookupErr } = await supabase
        .from('whatsapp_flows')
        .select('id')
        .eq('account_id', accountId)
        .eq('meta_flow_id', f.id)
        .maybeSingle()

      if (lookupErr) {
        errors.push({ name: f.name, message: lookupErr.message })
        continue
      }

      if (existing?.id) {
        const { error: updErr } = await supabase
          .from('whatsapp_flows')
          .update(row)
          .eq('id', existing.id)
        if (updErr) {
          errors.push({ name: f.name, message: updErr.message })
        } else {
          updated++
        }
      } else {
        const { error: insErr } = await supabase
          .from('whatsapp_flows')
          .insert(row)
        if (insErr) {
          errors.push({ name: f.name, message: insErr.message })
        } else {
          inserted++
        }
      }
    }

    return NextResponse.json({
      success: errors.length === 0,
      total: metaFlows.length,
      inserted,
      updated,
      removed,
      skipped,
      errors,
      truncated: pageCount >= PAGE_CAP && nextUrl !== null,
    })
  } catch (error) {
    console.error('Error syncing WhatsApp Flows:', error)
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to sync flows',
      },
      { status: 500 },
    )
  }
}
