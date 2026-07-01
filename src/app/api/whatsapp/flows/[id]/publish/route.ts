import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveFlowAuthoringContext } from '@/lib/whatsapp/flow-authoring'
import { publishFlow, getFlowDetail } from '@/lib/whatsapp/meta-api'

export const runtime = 'nodejs'

/**
 * Publish an authored DRAFT flow. Meta rejects publish if the JSON has
 * validation errors or (for data_exchange) the endpoint health check
 * hasn't passed — we surface that error verbatim. On success we refresh
 * the local status from Meta so the roster reflects PUBLISHED.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const resolved = await resolveFlowAuthoringContext(supabase, user.id)
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status })
    }
    const { ctx } = resolved

    const { data: existing } = await supabase
      .from('whatsapp_flows')
      .select('id, meta_flow_id, origin, status')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (!existing) {
      return NextResponse.json({ error: 'Flow not found.' }, { status: 404 })
    }
    if (existing.origin !== 'authored') {
      return NextResponse.json(
        { error: 'Only flows authored in wacrm can be published here.' },
        { status: 400 },
      )
    }

    try {
      await publishFlow(existing.meta_flow_id, ctx.accessToken)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Meta publish failed.'
      return NextResponse.json(
        { error: `Meta rejected publish: ${message}` },
        { status: 502 },
      )
    }

    // Refresh status + validation from Meta (best-effort).
    let newStatus = 'PUBLISHED'
    let validationErrors: unknown[] = []
    try {
      const detail = await getFlowDetail(existing.meta_flow_id, ctx.accessToken)
      if (detail.status) newStatus = detail.status.toUpperCase()
      validationErrors = detail.validation_errors ?? []
    } catch (err) {
      console.warn('[flows/publish] detail read-back failed:', err)
    }

    const { data: updated, error: updErr } = await supabase
      .from('whatsapp_flows')
      .update({
        status: newStatus,
        validation_errors: validationErrors.length ? validationErrors : null,
      })
      .eq('id', id)
      .select('*')
      .single()
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, flow: updated })
  } catch (error) {
    console.error('Error publishing WhatsApp Flow:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to publish flow' },
      { status: 500 },
    )
  }
}
