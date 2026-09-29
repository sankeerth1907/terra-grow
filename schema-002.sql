-- TerraGrow migration 002 — area columns on analyses (for DBs created before this change).
-- Fresh setups: schema.sql already includes these columns, skip this file.
-- Existing DBs (local + remote), run ONCE:
--   wrangler d1 execute terragrow-db --local  --file=./schema-002.sql
--   wrangler d1 execute terragrow-db --remote --file=./schema-002.sql
ALTER TABLE analyses ADD COLUMN gsd_mpx REAL NOT NULL DEFAULT 0;
ALTER TABLE analyses ADD COLUMN area_total_ha REAL NOT NULL DEFAULT 0;
ALTER TABLE analyses ADD COLUMN area_under_ha REAL NOT NULL DEFAULT 0;
