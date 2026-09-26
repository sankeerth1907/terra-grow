-- TerraGrow D1 schema — Phase 0/1/2
-- Apply: wrangler d1 execute terragrow-db --file=./schema.sql
-- Local:  wrangler d1 execute terragrow-db --local --file=./schema.sql

CREATE TABLE IF NOT EXISTS farms (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT 'local-farmer',
  name TEXT NOT NULL DEFAULT 'My Farm',
  boundary_geojson TEXT NOT NULL DEFAULT '{}',
  soil_type TEXT NOT NULL DEFAULT 'loam',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS imagery_index (
  id TEXT PRIMARY KEY,
  farm_id TEXT NOT NULL REFERENCES farms(id),
  r2_key TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  ndvi_avg REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'upload'
);

CREATE TABLE IF NOT EXISTS crop_master (
  crop_name TEXT NOT NULL,
  season TEXT NOT NULL,
  suitable_soil_types TEXT NOT NULL, -- comma list e.g. "loam,clay,black"
  notes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (crop_name, season)
);

CREATE TABLE IF NOT EXISTS monitoring_logs (
  id TEXT PRIMARY KEY,
  farm_id TEXT NOT NULL REFERENCES farms(id),
  imagery_id TEXT,
  growth_rate REAL NOT NULL DEFAULT 0,
  disease_flag TEXT NOT NULL DEFAULT 'none',
  health_score REAL NOT NULL DEFAULT 0,
  farm_pct REAL NOT NULL DEFAULT 0,
  barren_pct REAL NOT NULL DEFAULT 0,
  city_pct REAL NOT NULL DEFAULT 0,
  water_pct REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  farm_id TEXT NOT NULL REFERENCES farms(id),
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  created_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  contact_info TEXT NOT NULL DEFAULT '',
  auth_token_hash TEXT NOT NULL DEFAULT ''
);

-- Simple standalone upload analyses (no farm needed, powers current index.html flow)
CREATE TABLE IF NOT EXISTS analyses (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL DEFAULT '',
  farm REAL NOT NULL DEFAULT 0,
  barren REAL NOT NULL DEFAULT 0,
  city REAL NOT NULL DEFAULT 0,
  water REAL NOT NULL DEFAULT 0,
  c_farm INTEGER NOT NULL DEFAULT 0,
  c_barren INTEGER NOT NULL DEFAULT 0,
  c_city INTEGER NOT NULL DEFAULT 0,
  c_water INTEGER NOT NULL DEFAULT 0,
  pixels INTEGER NOT NULL DEFAULT 0,
  verdict TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_imagery_farm ON imagery_index(farm_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_monitor_farm ON monitoring_logs(farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_farm ON alerts(farm_id, created_at DESC);

-- Seed crop calendar (edit to your region)
INSERT OR IGNORE INTO crop_master (crop_name, season, suitable_soil_types, notes) VALUES
  ('Rice (Paddy)', 'kharif', 'clay,loam,black', 'Needs standing water, high NDVI fields ideal'),
  ('Maize (Corn)', 'kharif', 'loam,sandy-loam,black', 'Good for well-drained farm % > 40'),
  ('Cotton', 'kharif', 'black,loam', 'Deep black soil, low waterlogging'),
  ('Soybean', 'kharif', 'loam,black,sandy-loam', 'Needs moderate drainage'),
  ('Wheat', 'rabi', 'loam,clay,sandy-loam', 'Cool season, needs irrigation if water % low'),
  ('Mustard', 'rabi', 'loam,sandy-loam', 'Low water need, good for barren-edge plots'),
  ('Gram (Chickpea)', 'rabi', 'sandy-loam,loam,black', 'Drought tolerant'),
  ('Sugarcane', 'perennial', 'loam,clay,black', 'Year-round water need — water % >= 8 ideal'),
  ('Vegetables (Mixed)', 'perennial', 'loam,sandy-loam', 'Near-city plots benefit from market access');
