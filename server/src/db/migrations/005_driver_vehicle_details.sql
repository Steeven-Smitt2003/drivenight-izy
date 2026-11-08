ALTER TABLE driver_profiles RENAME TO driver_profiles_before_vehicle_signup;

CREATE TABLE driver_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  validation_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (validation_status IN ('pending', 'approved', 'rejected')),
  vehicle_category TEXT NOT NULL CHECK (vehicle_category IN ('moto', 'taxi', 'voiture')),
  vehicle_make TEXT,
  vehicle_model TEXT,
  vehicle_color TEXT,
  vehicle_registration TEXT NOT NULL UNIQUE,
  is_online INTEGER NOT NULL DEFAULT 0 CHECK (is_online IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO driver_profiles (
  user_id, validation_status, vehicle_category, vehicle_make, vehicle_model,
  vehicle_color, vehicle_registration, is_online, created_at, updated_at
)
SELECT
  user_id, validation_status, vehicle_category, vehicle_make, vehicle_model,
  vehicle_color, vehicle_registration, is_online, created_at, updated_at
FROM driver_profiles_before_vehicle_signup;

DROP TABLE driver_profiles_before_vehicle_signup;
