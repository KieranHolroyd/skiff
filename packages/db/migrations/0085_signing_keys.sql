-- The platform signing-key ring (docs/IAM.md I15, §4, §7.3). Additive only.
--
-- One ring per purpose (`sts`, `registry`, `oidc`, `workload`, or `pool:<id>`), so every token Yoal
-- mints can share one issuer and one JWKS. A key moves next → active → retired: a `next` key is
-- published 24 hours before it signs anything, and a `retired` key stays published until every
-- token it signed has expired (plus a margin). `retire_after` is epoch milliseconds and is NULL
-- for keys that have not retired yet.
--
-- `public_jwk` is the public half as JWK JSON (never contains `d`). `private_sealed` is the private
-- JWK sealed with the platform master key (`encrypt` in packages/core/src/util.ts), stored as
-- `{"nonce":"…","ciphertext":"…"}`. The key never leaves the control plane.

CREATE TABLE IF NOT EXISTS signing_keys (
  kid TEXT PRIMARY KEY,
  alg TEXT NOT NULL DEFAULT 'ES256',
  purpose TEXT NOT NULL,
  public_jwk TEXT NOT NULL,
  private_sealed TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('next','active','retired')),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  retire_after INTEGER
);

CREATE INDEX IF NOT EXISTS signing_keys_purpose_state_idx ON signing_keys (purpose, state);
