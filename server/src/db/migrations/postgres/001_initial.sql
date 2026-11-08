CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('passenger', 'driver', 'admin')),
  name TEXT NOT NULL,
  photo_url TEXT,
  average_rating DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (average_rating BETWEEN 0 AND 5),
  rating_count INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  is_active SMALLINT NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  email TEXT,
  email_verified_at TIMESTAMPTZ,
  password_hash TEXT,
  terms_accepted_at TIMESTAMPTZ,
  terms_version TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS users_by_email ON users (email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS driver_vehicles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('moto', 'voiture')),
  vehicle_make TEXT,
  vehicle_model TEXT,
  vehicle_color TEXT,
  vehicle_registration TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, category),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS driver_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  validation_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (validation_status IN ('pending', 'approved', 'rejected')),
  vehicle_category TEXT NOT NULL CHECK (vehicle_category IN ('moto', 'taxi', 'voiture')),
  vehicle_make TEXT,
  vehicle_model TEXT,
  vehicle_color TEXT,
  vehicle_registration TEXT NOT NULL UNIQUE,
  is_online SMALLINT NOT NULL DEFAULT 0 CHECK (is_online IN (0, 1)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active_vehicle_id TEXT REFERENCES driver_vehicles(id)
);

CREATE TABLE IF NOT EXISTS rides (
  id TEXT PRIMARY KEY,
  passenger_id TEXT NOT NULL REFERENCES users(id),
  driver_id TEXT REFERENCES users(id),
  origin_label TEXT NOT NULL,
  origin_latitude DOUBLE PRECISION NOT NULL,
  origin_longitude DOUBLE PRECISION NOT NULL,
  destination_label TEXT NOT NULL,
  destination_latitude DOUBLE PRECISION NOT NULL,
  destination_longitude DOUBLE PRECISION NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('moto', 'taxi', 'voiture')),
  proposed_price_mga INTEGER NOT NULL CHECK (proposed_price_mga > 0),
  agreed_price_mga INTEGER CHECK (agreed_price_mga IS NULL OR agreed_price_mga > 0),
  status TEXT NOT NULL CHECK (
    status IN ('searching', 'negotiating', 'driver_en_route', 'driver_arrived',
      'in_progress', 'completed', 'cancelled')
  ),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ride_offers (
  id TEXT PRIMARY KEY,
  ride_id TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  proposer_id TEXT NOT NULL REFERENCES users(id),
  amount_mga INTEGER NOT NULL CHECK (amount_mga > 0),
  responds_to_offer_id TEXT REFERENCES ride_offers(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  ride_id TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  ride_id TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  rater_id TEXT NOT NULL REFERENCES users(id),
  ratee_id TEXT NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR length(comment) <= 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ride_id, rater_id),
  CHECK (rater_id <> ratee_id)
);

CREATE TABLE IF NOT EXISTS ride_locations (
  ride_id TEXT PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
  driver_id TEXT NOT NULL REFERENCES users(id),
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS rides_by_passenger_created ON rides (passenger_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rides_by_driver_created ON rides (driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rides_searchable ON rides (status, category, requested_at DESC);
CREATE INDEX IF NOT EXISTS offers_by_ride_created ON ride_offers (ride_id, created_at);
CREATE INDEX IF NOT EXISTS messages_by_ride_created ON chat_messages (ride_id, created_at);
CREATE INDEX IF NOT EXISTS ratings_by_ratee ON ratings (ratee_id, created_at);
