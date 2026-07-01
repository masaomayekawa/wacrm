import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveFlowAuthoringContext } from '@/lib/whatsapp/flow-authoring'
import { createFlow, uploadFlowAsset } from '@/lib/whatsapp/meta-api'
import { WHATSAPP_FLOW_CATEGORIES } from '@/types'

export const runtime = 'nodejs'

/**
 * Create an AUTHORED WhatsApp Flow from wacrm.
 *
 *   1. Create a DRAFT shell on Meta (name + categories + endpoint_uri).
 *   2. Upload the Flow JSON asset → Meta validates and returns errors.
 *   3. Store the row locally (origin='authored', flow_json, validation
 *      errors, DRAFT status). Publishing is a separate explicit step.
 *
 * A `data_exchange` flow REQUIRES the account's encryption endpoint
 * (Phase 0) to exist — that's what Meta calls for dynamic screens.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => ({}))
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const categories: string[] = Array.isArray(body.categories)
      ? body.categories
      : []
    const dataChannel: 'static' | 'data_exchange' =
      body.data_channel === 'data_exchange' ? 'data_exchange' : 'static'
    const flowJsonRaw = body.flow_json

    if (!name) {
      return NextResponse.json({ error: 'Flow name is required.' }, { status: 400 })
    }
    if (categories.length === 0) {
      return NextResponse.json(
        { error: 'Pick at least one category.' },
        { status: 400 },
      )
    }
    const invalidCat = categories.find(
      (c) => !(WHATSAPP_FLOW_CATEGORIES as readonly string[]).includes(c),
    )
    if (invalidCat) {
      return NextResponse.json(
        { error: `Unknown category: ${invalidCat}` },
        { status: 400 },
      )
    }

    // Normalise the Flow JSON to a string for Meta + validate it parses.
    let flowJsonString: string | null = null
    let flowJsonParsed: unknown = null
    if (flowJsonRaw != null && flowJsonRaw !== '') {
      try {
        flowJsonParsed =
          typeof flowJsonRaw === 'string' ? JSON.parse(flowJsonRaw) : flowJsonRaw
        flowJsonString = JSON.stringify(flowJsonParsed)
      } catch {
        return NextResponse.json(
          { error: 'Flow JSON is not valid JSON.' },
          { status: 400 },
        )
      }
    }

    const resolved = await resolveFlowAuthoringContext(supabase, user.id)
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status })
    }
    const { ctx } = resolved

    if (dataChannel === 'data_exchange' && !ctx.endpointUrl) {
      return NextResponse.json(
        {
          error:
            'Generate the data-exchange encryption key first (the "Generate & upload key" button above) — a dynamic flow needs an endpoint.',
        },
        { status: 400 },
      )
    }

    // 1. Create the DRAFT shell on Meta.
    let metaFlowId: string
    try {
      metaFlowId = await createFlow({
        wabaId: ctx.wabaId,
        accessToken: ctx.accessToken,
        name,
        categories,
        endpointUri: dataChannel === 'data_exchange' ? ctx.endpointUrl! : undefined,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Meta create failed.'
      return NextResponse.json(
        { error: `Failed to create flow on Meta: ${message}` },
        { status: 502 },
      )
    }

    // 2. Upload the JSON asset (if provided) and capture validation errors.
    let validationErrors: unknown[] = []
    if (flowJsonString) {
      try {
        const result = await uploadFlowAsset({
          flowId: metaFlowId,
          accessToken: ctx.accessToken,
          flowJson: flowJsonString,
        })
        validationErrors = result.validation_errors
      } catch (err) {
        // The shell exists on Meta but the asset failed — surface it;
        // the local row below still records the flow so the user can retry.
        const message = err instanceof Error ? err.message : 'Asset upload failed.'
        // Best-effort: also set endpoint again is unnecessary. Just report.
        return NextResponse.json(
          {
            error: `Flow created but JSON upload failed: ${message}`,
            meta_flow_id: metaFlowId,
          },
          { status: 502 },
        )
      }
    }

    // 3. Persist locally as an authored DRAFT.
    const { data: inserted, error: insErr } = await supabase
      .from('whatsapp_flows')
      .insert({
        account_id: ctx.accountId,
        synced_by: user.id,
        meta_flow_id: metaFlowId,
        name,
        status: 'DRAFT',
        categories,
        endpoint_uri: dataChannel === 'data_exchange' ? ctx.endpointUrl : null,
        validation_errors: validationErrors.length ? validationErrors : null,
        origin: 'authored',
        flow_json: flowJsonParsed,
        data_channel: dataChannel,
        synced_at: new Date().toISOString(),
      })
      .select('*')
      .single()

    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      flow: inserted,
      validation_errors: validationErrors,
    })
  } catch (error) {
    console.error('Error creating WhatsApp Flow:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create flow' },
      { status: 500 },
    )
  }
}
