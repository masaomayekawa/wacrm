SET search_path = public, extensions;

-- ============================================================
-- 027_whatsapp_flows.sql — Meta WhatsApp Flows sync (read-only)
--
-- Adds the `whatsapp_flows` table backing "Sync from Meta" on the
-- Flows settings panel — the same idea as `message_templates` (see
-- migration 014), but for Meta's WhatsApp Flows product (interactive
-- forms defined and published in Meta Business Manager), not for
-- this app's own local flow-builder (`flows` / `flow_nodes` /
-- `flow_runs`, migration 010). The two "flows" concepts are unrelated
-- — this table exists so a completely separate Meta feature doesn't
-- get bolted onto the local automation-engine schema, which has its
-- own NOT NULL / CHECK shape (trigger_type, flow_nodes cascade) that
-- doesn't apply to a Meta-hosted flow.
--
-- Design notes
--   - Account-scoped, never user-scoped — same reasoning as
--     `api_keys` (migration 026): a synced flow belongs to the
--     WhatsApp Business Account tied to the wacrm account, not to
--     whichever teammate happened to click "Sync from Meta".
--     `synced_by` only records who last triggered a sync (audit),
--     ON DELETE SET NULL so removing a teammate doesn't cascade.
--   - `status` stores Meta's raw enum (DRAFT / PUBLISHED / DEPRECATED
--     / THROTTLED / BLOCKED) verbatim — same "no translation table"
--     reasoning as `message_templates.status` (migration 014). The
--     sync route only pulls PUBLISHED flows in practice, but the
--     column allows any value in case a flow is later deprecated
--     without a fresh sync noticing.
--   - `categories`, `validation_errors` stored as JSONB straight from
--     Meta's response — informational, not queried by shape.
--   - No `flow_json` column: this is a read-only listing/reference
--     feature (see PR discussion) — we don't fetch or store the full
--     flow asset (`GET /{flow_id}/assets`) because nothing in the app
--     renders or edits it yet. Adding it later is a single
--     `ADD COLUMN IF NOT EXISTS` away.
--
-- RLS
--   Settings-class table, same shape as `message_templates` /
--   `api_keys`: any account member (viewer+) may read the synced
--   roster; only admin+ may write (the sync route runs as the
--   calling user via the request-scoped Supabase client, not a
--   service-role client, so RLS is the actual enforcement here, not
--   just a defense-in-depth layer).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_flows (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  synced_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  meta_flow_id      text NOT NULL,
  name              text NOT NULL,
  status            text NOT NULL CHECK (
    status IN ('DRAFT', 'PUBLISHED', 'DEPRECATED', 'THROTTLED', 'BLOCKED')
  ),
  categories        jsonb,
  json_version      text,
  data_api_version  text,
  endpoint_uri      text,
  validation_errors jsonb,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One row per (account, Meta flow) — the sync upsert matches on this
-- so re-running "Sync from Meta" refreshes rows instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_flows_account_meta_flow_id_key
  ON whatsapp_flows (account_id, meta_flow_id);

-- account_id: every "list this account's flows" query filters on it.
CREATE INDEX IF NOT EXISTS whatsapp_flows_account_id_idx
  ON whatsapp_flows (account_id);

ALTER TABLE whatsapp_flows ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see the synced roster.
DROP POLICY IF EXISTS whatsapp_flows_select ON whatsapp_flows;
CREATE POLICY whatsapp_flows_select ON whatsapp_flows FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only (settings-class, mirrors
-- message_templates_insert/update/delete from migration 017 and
-- api_keys_insert/update/delete from migration 026).
DROP POLICY IF EXISTS whatsapp_flows_insert ON whatsapp_flows;
CREATE POLICY whatsapp_flows_insert ON whatsapp_flows FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_flows_update ON whatsapp_flows;
CREATE POLICY whatsapp_flows_update ON whatsapp_flows FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_flows_delete ON whatsapp_flows;
CREATE POLICY whatsapp_flows_delete ON whatsapp_flows FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_flows;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_flows
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
