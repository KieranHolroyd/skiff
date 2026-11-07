-- Protected sites: a password per scope, and "sign out everyone" (DESIGN §6.4). Additive only.
--
-- Until now a project had one `access_secret_hash` shared by production and previews, and setting
-- either scope to a mode other than `password` cleared it, which could leave the other scope in
-- password mode with no password. Each scope now keeps its own hash: production and previews on the
-- project, named environments on their own row. Every scope currently in password mode gets a copy
-- of the old hash, so nobody's password changes. `access_secret_hash` stays (additive rule) but is
-- no longer read or written.
--
-- `site_session_epoch` is mixed into the project's site key. Bumping it rotates the key, so every
-- visitor cookie and callback token signed with the old key stops verifying on the agents. Zero
-- keeps the key every existing cookie was signed with. `share_redemptions.site_epoch` records the
-- epoch a share session was minted under, so listings can leave out sessions that were signed out.

ALTER TABLE projects ADD COLUMN production_password_hash TEXT;
ALTER TABLE projects ADD COLUMN preview_password_hash TEXT;
ALTER TABLE projects ADD COLUMN site_session_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE environments ADD COLUMN password_hash TEXT;
ALTER TABLE share_redemptions ADD COLUMN site_epoch INTEGER NOT NULL DEFAULT 0;

UPDATE projects SET production_password_hash = access_secret_hash
  WHERE production_access = 'password' AND access_secret_hash IS NOT NULL;
UPDATE projects SET preview_password_hash = access_secret_hash
  WHERE preview_access = 'password' AND access_secret_hash IS NOT NULL;
UPDATE environments SET password_hash = (
  SELECT access_secret_hash FROM projects WHERE projects.id = environments.project_id
) WHERE access = 'password' AND is_production = 0;
