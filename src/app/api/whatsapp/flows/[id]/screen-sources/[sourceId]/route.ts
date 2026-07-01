import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildScreenSourceRow } from '@/lib/whatsapp/flow-screen-source'

export const runtime = 'nodejs'

/**
 * PATCH  — edit a screen source. Omit `headers` to keep the stored
 *          (API-key-bearing) headers; include it to replace them.
 * DELETE — remove a screen source.
 * Admin-only via RLS; we additionally scope by account for a clean 404.
 */

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  return (data?.account_id as string | undefined) ?? null
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; sourceId: string }> },
) {
  const { id, sourceId } = await params
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const accountId = await resolveAccountId(supabase, user.id)
  if (!accountId) {
    return NextResponse.json({ error: 'No account.' }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  const built = buildScreenSourceRow(body, accountId, id)
  if ('error' in built) {
    return NextResponse.json({ error: built.error }, { status: 400 })
  }
  // account_id / whatsapp_flow_id are immutable on edit — drop them.
  const updateRow = { ...built.value }
  delete updateRow.account_id
  delete updateRow.whatsapp_flow_id

  const { error } = await supabase
    .from('whatsapp_flow_screen_sources')
    .update(updateRow)
    .eq('id', sourceId)
    .eq('account_id', accountId)
    .eq('whatsapp_flow_id', id)
  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: 'Another source already uses this trigger screen.' },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; sourceId: string }> },
) {
  const { id, sourceId } = await params
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const accountId = await resolveAccountId(supabase, user.id)
  if (!accountId) {
    return NextResponse.json({ error: 'No account.' }, { status: 403 })
  }

  const { error } = await supabase
    .from('whatsapp_flow_screen_sources')
    .delete()
    .eq('id', sourceId)
    .eq('account_id', accountId)
    .eq('whatsapp_flow_id', id)
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ success: true })
}
