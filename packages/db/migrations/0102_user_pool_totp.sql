-- TOTP MFA for the native user-pool identity engine (IAM.md I27, §11.2). Additive only.
--
-- One row per pool user who has started or completed TOTP enrolment. The shared secret is sealed
-- with the organisation data key (`SecretsService.seal`); plaintext never reaches this table or a
-- log. `confirmed_at` stays NULL between "show the QR/secret" and the first valid code, so an
-- abandoned enrolment cannot be used to sign in.
--
-- `last_step` is the last accepted RFC 6238 time step. A later code with the same or an earlier
-- step is refused, which is the replay guard; the compare-and-set update in the engine makes two
-- simultaneous requests unable to both accept one code.
--
-- `recovery_codes_json` is a JSON array of `{ hash, usedAt }` entries. Only SHA-256 hashes are
-- stored, and a used entry is retained as `usedAt` so the codes remaining can be shown honestly
-- without ever reprinting a code. The raw codes are returned exactly once, at confirmation (or a
-- deliberate rotation).
--
-- The generated migrations bundle (`packages/db/src/migrations.ts`) is regenerated separately by
-- `scripts/generate-migrations.ts`; this slice does not rewrite it.

CREATE TABLE IF NOT EXISTS user_pool_totp (
  user_id TEXT NOT NULL,
  pool_id TEXT NOT NULL,
  -- `nonce.ciphertext` produced by SecretsService.seal with the org data key. Never plaintext.
  secret_sealed TEXT NOT NULL,
  -- NULL until the first valid code proves the authenticator. Unconfirmed rows cannot sign in.
  confirmed_at INTEGER,
  -- Last accepted TOTP step (RFC 6238), for replay rejection.
  last_step INTEGER,
  -- JSON array of { hash, usedAt }. Hashes only; no recoverable code.
  recovery_codes_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (pool_id, user_id)
);
