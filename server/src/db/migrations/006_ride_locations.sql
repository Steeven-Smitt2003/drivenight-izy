CREATE TABLE ride_locations (
  ride_id TEXT PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
  driver_id TEXT NOT NULL REFERENCES users(id),
  latitude REAL NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude REAL NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  updated_at TEXT NOT NULL
);
