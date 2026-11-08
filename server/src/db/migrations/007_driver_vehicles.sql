CREATE TABLE driver_vehicles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('moto', 'voiture')),
  vehicle_make TEXT,
  vehicle_model TEXT,
  vehicle_color TEXT,
  vehicle_registration TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, category)
);

ALTER TABLE driver_profiles
ADD COLUMN active_vehicle_id TEXT REFERENCES driver_vehicles(id);

INSERT INTO driver_vehicles (
  id, user_id, category, vehicle_make, vehicle_model, vehicle_color,
  vehicle_registration, created_at, updated_at
)
SELECT lower(hex(randomblob(16))), user_id,
  CASE vehicle_category WHEN 'taxi' THEN 'voiture' ELSE vehicle_category END,
  vehicle_make, vehicle_model, vehicle_color, vehicle_registration,
  created_at, updated_at
FROM driver_profiles;

UPDATE driver_profiles
SET vehicle_category = CASE vehicle_category WHEN 'taxi' THEN 'voiture' ELSE vehicle_category END,
  active_vehicle_id = (
    SELECT driver_vehicles.id
    FROM driver_vehicles
    WHERE driver_vehicles.user_id = driver_profiles.user_id
  );
