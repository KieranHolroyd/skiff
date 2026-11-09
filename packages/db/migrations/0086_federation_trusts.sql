-- Federation trusts for RFC 8693 token exchange (docs/IAM.md I16–I17, §4, §7.3). Additive only.
--
-- A trust maps an external (or another Yoal) OIDC issuer to one org-owned service account. A
-- subject token is accepted when its `iss` equals `issuer`, its `aud` is one of `audiences`, its
-- `sub` matches `subject_pattern` (glob: `*` within a segment, `**` across segments), and every
-- entry in `claim_conditions_json` matches the token's claims. The exchange then mints a token for
-- `service_account_id`, narrowed by `restriction_json` and the caller's optional `scope`.
--
-- `audiences` and `restriction_json` are JSON. `restriction_json` has the credential shape used
-- elsewhere (`{ permissions: string[], resources: string[] }`, docs/IAM.md §2). `max_ttl_seconds`
-- caps the minted token at one hour. A trust is enabled while its service account is not disabled;
-- there is no separate enabled flag (docs/IAM.md §4).

CREATE TABLE IF NOT EXISTS federation_trusts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  service_account_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  audiences TEXT NOT NULL DEFAULT '[]',
  subject_pattern TEXT NOT NULL DEFAULT '*',
  claim_conditions_json TEXT NOT NULL DEFAULT '{}',
  max_ttl_seconds INTEGER NOT NULL DEFAULT 900,
  restriction_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS federation_trusts_org_idx ON federation_trusts (org_id);
CREATE INDEX IF NOT EXISTS federation_trusts_issuer_idx ON federation_trusts (issuer);
