CREATE TABLE users (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('passenger', 'driver', 'admin')),
  name TEXT NOT NULL,
  photo_url TEXT,
  average_rating REAL NOT NULL DEFAULT 0 CHECK (average_rating BETWEEN 0 AND 5),
  rating_count INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE driver_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  validation_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (validation_status IN ('pending', 'approved', 'rejected')),
  vehicle_category TEXT NOT NULL CHECK (vehicle_category IN ('moto', 'taxi', 'voiture')),
  vehicle_make TEXT NOT NULL,
  vehicle_model TEXT NOT NULL,
  vehicle_color TEXT NOT NULL,
  vehicle_registration TEXT NOT NULL UNIQUE,
  is_online INTEGER NOT NULL DEFAULT 0 CHECK (is_online IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE rides (
  id TEXT PRIMARY KEY,
  passenger_id TEXT NOT NULL REFERENCES users(id),
  driver_id TEXT REFERENCES users(id),
  origin_label TEXT NOT NULL,
  origin_latitude REAL NOT NULL,
  origin_longitude REAL NOT NULL,
  destination_label TEXT NOT NULL,
  destination_latitude REAL NOT NULL,
  destination_longitude REAL NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('moto', 'taxi', 'voiture')),
  proposed_price_mga INTEGER NOT NULL CHECK (proposed_price_mga > 0),
  agreed_price_mga INTEGER CHECK (agreed_price_mga IS NULL OR agreed_price_mga > 0),
  status TEXT NOT NULL CHECK (
    status IN ('searching', 'negotiating', 'driver_en_route', 'driver_arrived',
      'in_progress', 'completed', 'cancelled')
  ),
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  accepted_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ride_offers (
  id TEXT PRIMARY KEY,
  ride_id TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  proposer_id TEXT NOT NULL REFERENCES users(id),
  amount_mga INTEGER NOT NULL CHECK (amount_mga > 0),
  responds_to_offer_id TEXT REFERENCES ride_offers(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  responded_at TEXT
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  ride_id TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (length(trim(body)) > 0 AND length(body) <= 2000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ratings (
  id TEXT PRIMARY KEY,
  ride_id TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  rater_id TEXT NOT NULL REFERENCES users(id),
  ratee_id TEXT NOT NULL REFERENCES users(id),
  stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  comment TEXT CHECK (comment IS NULL OR length(comment) <= 1000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ride_id, rater_id),
  CHECK (rater_id <> ratee_id)
);

CREATE INDEX rides_by_passenger_created ON rides (passenger_id, created_at DESC);
CREATE INDEX rides_by_driver_created ON rides (driver_id, created_at DESC);
CREATE INDEX rides_searchable ON rides (status, category, requested_at DESC);
CREATE INDEX offers_by_ride_created ON ride_offers (ride_id, created_at);
CREATE INDEX messages_by_ride_created ON chat_messages (ride_id, created_at);
CREATE INDEX ratings_by_ratee ON ratings (ratee_id, created_at);
