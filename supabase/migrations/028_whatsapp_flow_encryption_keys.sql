SET search_path = public, extensions;

-- ============================================================
-- 028_whatsapp_flow_encryption_keys.sql — RSA keys for the
--     WhatsApp Flows data-exchange endpoint (Phase 0 of authoring)
--
-- WhatsApp Flows with a `data_exchange` channel (dynamic screens)
-- talk to a business-hosted HTTPS endpoint. Meta encrypts every
-- request to that endpoint with a 128-bit AES key, and encrypts THAT
-- key with an RSA public key the business registers per phone number
-- (`POST /{phone-number-id}/whatsapp_business_encryption`). Our
-- endpoint decrypts with the matching private key.
--
--   Reference (verified against Meta's official sample):
--     https://developers.facebook.com/docs/whatsapp/flows/guides/implementingyourflowendpoint/
--     https://github.com/WhatsApp/WhatsApp-Flows-Tools (encryption.js)
--
-- Design notes
--   - One key pair per account (a wacrm account owns one WABA / one
--     phone number, enforced by whatsapp_config's unique phone_number_id
--     in migration 013). `account_id` is therefore UNIQUE here.
--   - `private_key_pem` is stored ENCRYPTED AT REST with the same
--     AES-256-GCM `encrypt()` helper used for `whatsapp_config.access_token`
--     (src/lib/whatsapp/encryption.ts). A leaked DB snapshot alone can't
--     decrypt Flow traffic — the attacker also needs ENCRYPTION_KEY.
--   - `public_key_pem` is not secret (it's uploaded to Meta) so it's
--     stored in the clear for easy re-upload / diffing.
--   - `endpoint_token` is a random, rotatable, URL-safe id used in the
--     public data-exchange URL
--     (`/api/whatsapp/flows/data-exchange/{endpoint_token}`) so the
--     public endpoint never exposes the internal account UUID and can
--     be rotated without touching account_id. The token is how the
--     (unauthenticated, Meta-signed) endpoint route selects which
--     account's private key to decrypt with.
--   - `signature_status` mirrors Meta's GET response
--     (`business_public_key_signature_status`: VALID | MISMATCH) so the
--     settings UI can show whether Meta accepted the key.
--
-- RLS
--   Settings-class + holds a (at-rest-encrypted) private key, so ALL
--   ops are admin+ only — stricter than message_templates (viewer read).
--   The data-exchange endpoint reads the private key with the
--   service-role client (RLS-bypassing) because a Meta-originated
--   request has no Supabase session.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_flow_encryption_keys (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint_token      text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(16), 'hex'),
  private_key_pem     text NOT NULL,             -- AES-256-GCM encrypted at rest
  public_key_pem      text NOT NULL,             -- public, stored plaintext
  phone_number_id     text,                      -- the number the key was uploaded to (audit)
  uploaded_to_meta_at timestamptz,
  signature_status    text CHECK (signature_status IN ('VALID', 'MISMATCH')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- endpoint_token: the hot path is the per-request lookup by token from
-- the public data-exchange route. UNIQUE already indexes it; spelled
-- out so the intent survives a future drop of the UNIQUE constraint.
CREATE INDEX IF NOT EXISTS whatsapp_flow_encryption_keys_endpoint_token_idx
  ON whatsapp_flow_encryption_keys (endpoint_token);

ALTER TABLE whatsapp_flow_encryption_keys ENABLE ROW LEVEL SECURITY;

-- All ops admin+ only (holds a private key, even if encrypted at rest).
DROP POLICY IF EXISTS whatsapp_flow_encryption_keys_select ON whatsapp_flow_encryption_keys;
CREATE POLICY whatsapp_flow_encryption_keys_select ON whatsapp_flow_encryption_keys FOR SELECT
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_flow_encryption_keys_insert ON whatsapp_flow_encryption_keys;
CREATE POLICY whatsapp_flow_encryption_keys_insert ON whatsapp_flow_encryption_keys FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_flow_encryption_keys_update ON whatsapp_flow_encryption_keys;
CREATE POLICY whatsapp_flow_encryption_keys_update ON whatsapp_flow_encryption_keys FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS whatsapp_flow_encryption_keys_delete ON whatsapp_flow_encryption_keys;
CREATE POLICY whatsapp_flow_encryption_keys_delete ON whatsapp_flow_encryption_keys FOR DELETE
  USING (is_account_member(account_id, 'admin'));

DROP TRIGGER IF EXISTS set_updated_at ON whatsapp_flow_encryption_keys;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON whatsapp_flow_encryption_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
