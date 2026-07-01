import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildScreenSourceRow } from '@/lib/whatsapp/flow-screen-source'

export const runtime = 'nodejs'

/**
 * Per-screen data sources for a data_exchange flow.
 *
 *   GET  — list this flow's sources (headers are NOT returned decrypted;
 *          only a `has_headers` flag, so the API key never round-trips).
 *   POST — create a source. `headers` (object, may hold an API key) is
 *          encrypted at rest.
 *
 * Admin-only via RLS on whatsapp_flow_screen_sources.
 */

async function resolveAccountAndFlow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  flowId: string,
) {
  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  const accountId = profile?.account_id as string | undefined
  if (!accountId) return { error: 'no_account' as const }

  const { data: flow } = await supabase
    .from('whatsapp_flows')
    .select('id')
    .eq('id', flowId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (!flow) return { error: 'no_flow' as const }
  return { accountId }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const resolved = await resolveAccountAndFlow(supabase, user.id, id)
  if ('error' in resolved) {
    return NextResponse.json({ sources: [] })
  }

  const { data, error } = await supabase
    .from('whatsapp_flow_screen_sources')
    .select(
      'id, trigger_screen, next_screen, request_url, request_method, request_headers_encrypted, forward_fields, response_items_path, response_target_key, item_id_field, item_title_field, updated_at',
    )
    .eq('whatsapp_flow_id', id)
    .order('trigger_screen', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Strip the encrypted blob; expose only whether headers are set.
  const sources = (data ?? []).map((s) => {
    const { request_headers_encrypted, ...rest } = s
    return { ...rest, has_headers: !!request_headers_encrypted }
  })
  return NextResponse.json({ sources })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const resolved = await resolveAccountAndFlow(supabase, user.id, id)
  if ('error' in resolved) {
    return NextResponse.json(
      { error: 'Flow not found for your account.' },
      { status: 404 },
    )
  }
  const { accountId } = resolved

  const body = await request.json().catch(() => ({}))
  const row = buildScreenSourceRow(body, accountId, id)
  if ('error' in row) {
    return NextResponse.json({ error: row.error }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('whatsapp_flow_screen_sources')
    .insert(row.value)
    .select('id')
    .single()
  if (error) {
    // Unique (flow, trigger_screen) collision → friendly message.
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'A source for this trigger screen already exists. Edit it instead.' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, id: data.id })
}
