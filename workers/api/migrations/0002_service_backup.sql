-- Migration number: 0002 	 2026-11-07T00:30:00.000Z

-- Whether a service credential may read the whole task store for a backup
-- (GET /api/backup): every project, including those made after the
-- credential, whatever its grants. The owner chooses it when making the
-- credential, and it never changes after, like the credential's name.
ALTER TABLE access_service_credentials ADD COLUMN backup INTEGER NOT NULL DEFAULT 0 CHECK (backup IN (0, 1));

-- The rule that a credential changes only by being revoked, made again to
-- cover the new column.
DROP TRIGGER access_service_credentials_revoked_stays;

CREATE TRIGGER access_service_credentials_revoked_stays BEFORE UPDATE ON access_service_credentials
WHEN OLD.revoked_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.secret_hash IS NOT OLD.secret_hash
  OR NEW.name IS NOT OLD.name OR NEW.created_at IS NOT OLD.created_at OR NEW.created_by IS NOT OLD.created_by
  OR NEW.backup IS NOT OLD.backup
BEGIN
  SELECT raise(ABORT, 'ntasks: a service credential only changes by being revoked, once');
END;
