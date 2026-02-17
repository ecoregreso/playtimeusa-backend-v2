ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS external_id TEXT;

UPDATE tenants
SET external_id = id::text
WHERE external_id IS NULL
   OR btrim(external_id) = '';

ALTER TABLE tenants
  ALTER COLUMN external_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tenants_external_id_uq
  ON tenants (external_id);
