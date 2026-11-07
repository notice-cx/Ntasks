-- Migration number: 0003 	 2026-11-07T02:00:00.000Z

-- Whether a service credential may load rows into the task store while it is
-- empty, such as an import from Beads or a backup (POST /api/restore). The
-- owner chooses it when making the credential, and it never changes after,
-- like the backup choice.
ALTER TABLE access_service_credentials ADD COLUMN restore INTEGER NOT NULL DEFAULT 0 CHECK (restore IN (0, 1));

-- The rule that a credential changes only by being revoked, made again to
-- cover the new column.
DROP TRIGGER access_service_credentials_revoked_stays;

CREATE TRIGGER access_service_credentials_revoked_stays BEFORE UPDATE ON access_service_credentials
WHEN OLD.revoked_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.secret_hash IS NOT OLD.secret_hash
  OR NEW.name IS NOT OLD.name OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by
  OR NEW.backup IS NOT OLD.backup OR NEW.restore IS NOT OLD.restore
BEGIN
  SELECT raise(ABORT, 'ntasks: a service credential only changes by being revoked, once');
END;
