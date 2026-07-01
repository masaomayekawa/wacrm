import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveFlowAuthoringContext } from '@/lib/whatsapp/flow-authoring'
import {
  uploadFlowAsset,
  updateFlowMetadata,
  deleteFlow,
} from '@/lib/whatsapp/meta-api'

export const runtime = 'nodejs'

/**
 * PATCH — edit an AUTHORED flow's JSON and/or metadata, then re-validate
 *         with Meta. Only DRAFT flows are editable this way; a published
 *         flow must be re-authored (Meta locks published assets).
 * DELETE — remove an authored DRAFT from Meta and locally. Synced rows
 *          and published flows are rejected (Meta won't delete published).
 */

async function loadAuthoredRow(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
  id: string,
) {
  const { data } = await supabase
    .from('whatsapp_flows')
    .select('id, meta_flow_id, status, origin, data_channel, name, categories')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  return data
}

export async function PATCH(
  request: Request,
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

    const existing = await loadAuthoredRow(supabase, ctx.accountId, id)
    if (!existing) {
      return NextResponse.json({ error: 'Flow not found.' }, { status: 404 })
    }
    if (existing.origin !== 'authored') {
      return NextResponse.json(
        { error: 'Only flows authored in wacrm can be edited here.' },
        { status: 400 },
      )
    }
    if (existing.status !== 'DRAFT') {
      return NextResponse.json(
        { error: 'Only DRAFT flows can be edited. Published flows are locked by Meta.' },
        { status: 400 },
      )
    }

    const body = await request.json().catch(() => ({}))
    const name = typeof body.name === 'string' ? body.name.trim() : undefined
    const categories: string[] | undefined = Array.isArray(body.categories)
      ? body.categories
      : undefined
    const flowJsonRaw = body.flow_json

    // Metadata edit (name / categories) — optional.
    if (name || categories) {
      try {
        await updateFlowMetadata({
          flowId: existing.meta_flow_id,
          accessToken: ctx.accessToken,
          name,
          categories,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Meta update failed.'
        return NextResponse.json(
          { error: `Failed to update metadata: ${message}` },
          { status: 502 },
        )
      }
    }

    // Flow JSON edit — re-upload + re-validate.
    let validationErrors: unknown[] = []
    let flowJsonParsed: unknown = undefined
    if (flowJsonRaw != null && flowJsonRaw !== '') {
      try {
        flowJsonParsed =
          typeof flowJsonRaw === 'string' ? JSON.parse(flowJsonRaw) : flowJsonRaw
      } catch {
        return NextResponse.json(
          { error: 'Flow JSON is not valid JSON.' },
          { status: 400 },
        )
      }
      try {
        const result = await uploadFlowAsset({
          flowId: existing.meta_flow_id,
          accessToken: ctx.accessToken,
          flowJson: JSON.stringify(flowJsonParsed),
        })
        validationErrors = result.validation_errors
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Asset upload failed.'
        return NextResponse.json(
          { error: `JSON upload failed: ${message}` },
          { status: 502 },
        )
      }
    }

    const updateRow: Record<string, unknown> = {
      validation_errors: validationErrors.length ? validationErrors : null,
    }
    if (name) updateRow.name = name
    if (categories) updateRow.categories = categories
    if (flowJsonParsed !== undefined) updateRow.flow_json = flowJsonParsed

    const { data: updated, error: updErr } = await supabase
      .from('whatsapp_flows')
      .update(updateRow)
      .eq('id', id)
      .select('*')
      .single()
    if (updErr) {
      return NextResponse.json({ error: updErr.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      flow: updated,
      validation_errors: validationErrors,
    })
  } catch (error) {
    console.error('Error editing WhatsApp Flow:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to edit flow' },
      { status: 500 },
    )
  }
}

export async function DELETE(
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

    const existing = await loadAuthoredRow(supabase, ctx.accountId, id)
    if (!existing) {
      return NextResponse.json({ error: 'Flow not found.' }, { status: 404 })
    }
    if (existing.origin !== 'authored') {
      return NextResponse.json(
        { error: 'Only flows authored in wacrm can be deleted here.' },
        { status: 400 },
      )
    }

    // Best-effort delete on Meta (only DRAFT deletes succeed there). We
    // still remove the local row afterwards so the roster stays clean.
    try {
      await deleteFlow(existing.meta_flow_id, ctx.accessToken)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Meta delete failed.'
      return NextResponse.json(
        { error: `Meta rejected the delete: ${message}` },
        { status: 502 },
      )
    }

    const { error: delErr } = await supabase
      .from('whatsapp_flows')
      .delete()
      .eq('id', id)
    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error deleting WhatsApp Flow:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete flow' },
      { status: 500 },
    )
  }
}
