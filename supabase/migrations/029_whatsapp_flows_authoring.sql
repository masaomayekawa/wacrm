SET search_path = public, extensions;

-- ============================================================
-- 029_whatsapp_flows_authoring.sql — author + run data_exchange Flows
--
-- Phase 2 of the WhatsApp Flows build. Migration 027 gave us a
-- read-only synced roster; this migration lets a flow be AUTHORED from
-- wacrm (create → upload JSON → publish on Meta) and RUN when it has a
-- `data_exchange` channel (dynamic screens backed by an external API).
--
-- Three changes:
--   1. Extend `whatsapp_flows` — distinguish synced vs authored rows,
--      hold the authored Flow JSON, and record the data channel.
--   2. `whatsapp_flow_screen_sources` — the generic per-screen adapter
--      that the data-exchange endpoint uses to fetch the next screen's
--      data from an external API (no code change per new flow).
--   3. `whatsapp_flow_sessions` — correlate a sent flow (flow_token) to
--      a contact/conversation and capture the final submitted response.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ---- 1. whatsapp_flows: authoring columns -------------------------
ALTER TABLE whatsapp_flows
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'synced'
    CHECK (origin IN ('synced', 'authored')),
  ADD COLUMN IF NOT EXISTS flow_json jsonb,
  ADD COLUMN IF NOT EXISTS data_channel text NOT NULL DEFAULT 'static'
    CHECK (data_channel IN ('static', 'data_exchange'));

COMMENT ON COLUMN whatsapp_flows.origin IS
  'synced = discovered via Sync-from-Meta (read-only); authored = created in wacrm.';
COMMENT ON COLUMN whatsapp_flows.data_channel IS
  'data_exchange = dynamic screens calling our endpoint; static = self-contained.';

-- ---- 2. whatsapp_flow_screen_sources ------------------------------
-- One row per (flow, trigger screen). When Meta posts a data_exchange
-- for `trigger_screen`, the endpoint forwards the chosen fields to an
-- external API, shapes the response, and routes to `next_screen`.
--
--   trigger_screen = '__INIT__' handles the flow's initial data load
--   (the INIT action, before the first screen renders).
CREATE TABLE IF NOT EXISTS whatsapp_flow_screen_sources (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  whatsapp_flow_id         uuid NOT NULL REFERENCES whatsapp_flows(id) ON DELETE CASCADE,
  trigger_screen           text NOT NULL,
  next_screen              text NOT NULL,
  request_url              text NOT NULL,
  request_method           text NOT NULL DEFAULT 'GET'
    CHECK (request_method IN ('GET', 'POST')),
  -- Encrypted at rest (AES-256-GCM) because it can carry an API key.
  request_headers_encrypted text,
  -- Field names from the incoming screen `data` to forward to the API
  -- (query string for GET, JSON body for POST).
  forward_fields           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Dot path to the array/object in the API response ('' = whole body).
  response_items_path      text,
  -- Key the shaped result is exposed under in the next screen's `data`.
  response_target_key      text NOT NULL,
  -- For array responses feeding a WhatsApp dropdown/radio, which item
  -- fields become {id} and {title} (Meta's required shape). When unset,
  -- the raw response is passed through under response_target_key.
  item_id_field            text,
  item_title_field         text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_flow_screen_sources_flow_trigger_key
  ON whatsapp_flow_screen_sources (whatsapp_flow_id, trigger_screen);
CREATE INDEX IF NOT EXISTS whatsapp_flow_screen_sources_account_idx
  ON whatsapp_flow_screen_sources (account_id);

ALTER TABLE whatsapp_flow_screen_sources ENABLE ROW LEVEL SECURITY;

-- Settings-class config (holds an encrypted API key) → admin+ only.
DROP POLICY IF EXISTS whatsapp_flow_screen_sources_select ON whatsapp_flow_screen_sources;
CREATE POLICY whatsapp_flow_screen_sources_select ON whatsapp_flow_screen_sources FOR SELECT
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS whatsapp_flow_screen_sources_insert ON whatsapp_flow_screen_sources;
CREATE POLICY whatsapp_flow_screen_sources_insert ON whatsapp_flow_screen_sources FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS whatsapp_flow_screen_sources_update ON whatsapp_flow_screen_sources;
CREATE POLICY whatsapp_flow_screen_sources_update ON whatsapp_flow_screen_sources FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
DROP POLICY IF EXISTS whatsapp_flow_screen_sources_delete ON whatsapp_flow_screen_sources;
CREATE POLICY whatsapp_flow_screen_sources_delete ON whatsapp_flow_screen_sources FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_flow_screen_sources;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_flow_screen_sources
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ---- 3. whatsapp_flow_sessions ------------------------------------
-- A sent flow instance. `flow_token` is the opaque id we generate at
-- send time and Meta echoes on every endpoint call + on the final
-- nfm_reply, letting us tie the interaction back to a conversation.
CREATE TABLE IF NOT EXISTS whatsapp_flow_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  whatsapp_flow_id  uuid REFERENCES whatsapp_flows(id) ON DELETE SET NULL,
  flow_token        text NOT NULL UNIQUE,
  contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id   uuid REFERENCES conversations(id) ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'in_progress', 'completed', 'expired')),
  response_data     jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz
);

CREATE INDEX IF NOT EXISTS whatsapp_flow_sessions_account_idx
  ON whatsapp_flow_sessions (account_id);
CREATE INDEX IF NOT EXISTS whatsapp_flow_sessions_flow_token_idx
  ON whatsapp_flow_sessions (flow_token);

ALTER TABLE whatsapp_flow_sessions ENABLE ROW LEVEL SECURITY;

-- Operational data tied to conversations → any member (viewer+) reads;
-- writes happen via the service-role client (send route + endpoint), so
-- member-level write policies here are just a defense-in-depth allowance
-- for future authenticated writers.
DROP POLICY IF EXISTS whatsapp_flow_sessions_select ON whatsapp_flow_sessions;
CREATE POLICY whatsapp_flow_sessions_select ON whatsapp_flow_sessions FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS whatsapp_flow_sessions_insert ON whatsapp_flow_sessions;
CREATE POLICY whatsapp_flow_sessions_insert ON whatsapp_flow_sessions FOR INSERT
  WITH CHECK (is_account_member(account_id));
DROP POLICY IF EXISTS whatsapp_flow_sessions_update ON whatsapp_flow_sessions;
CREATE POLICY whatsapp_flow_sessions_update ON whatsapp_flow_sessions FOR UPDATE
  USING (is_account_member(account_id));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_flow_sessions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_flow_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
