-- Per-policy revocation and unused service-account policy (IAM.md §9.5, §11.1). Additive only.
--
-- `access_policies.version` is folded into a host's site key when it is non-zero. A revocation
-- (removing or tightening a rule, rotating a service token, disabling the policy) bumps only that
-- policy's version, so visitors on other policies for the same project keep their cookies. Zero
-- falls back to the project's `site_session_epoch`, which keeps cookies issued before this
-- migration valid until the policy is first revoked.
ALTER TABLE access_policies ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- Whether the daily hygiene pass disables service accounts that have been unused for 90 days.
-- Off by default: the sweep only reports until an org opts in via `sso:manage`.
ALTER TABLE org_auth_policies ADD COLUMN auto_disable_unused_service_accounts INTEGER NOT NULL DEFAULT 0;
