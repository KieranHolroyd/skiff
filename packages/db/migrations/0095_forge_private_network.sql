-- Forge connections on private networks (docs/FORGES.md §2, D173). Additive only.
-- `allow_private_network` is set only when a platform admin connects a GitLab/Gitea/Forgejo instance
-- on a private address (a homelab forge). Every other connection's requests are refused when the host
-- resolves to a loopback, private, link-local or CGNAT address (SSRF guard, as for log drains).
-- Connections created before this migration keep working only on public addresses until a platform
-- admin re-creates them.

ALTER TABLE forge_connections ADD COLUMN allow_private_network INTEGER NOT NULL DEFAULT 0;
