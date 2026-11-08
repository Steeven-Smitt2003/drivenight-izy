INSERT INTO users (id, phone, role, name, password_hash) VALUES
  ('demo-passenger-01', '+261340000001', 'passenger', 'Miora Rakoto', 'scrypt$32768$8$1$64726976656e696768742d64656d6f2d32303236$0c1ffbaf8e41318e00af8c77c50df57db154b70298a5999e12ba01758a27bc75b69b8fe38e2137bc70744c882347fdffad25d72140aad181192d152452f72c10'),
  ('demo-passenger-02', '+261340000002', 'passenger', 'Hery Randria', 'scrypt$32768$8$1$64726976656e696768742d64656d6f2d32303236$0c1ffbaf8e41318e00af8c77c50df57db154b70298a5999e12ba01758a27bc75b69b8fe38e2137bc70744c882347fdffad25d72140aad181192d152452f72c10'),
  ('demo-driver-01', '+261340000011', 'driver', 'Tiana Rasoanaivo', 'scrypt$32768$8$1$64726976656e696768742d64656d6f2d32303236$0c1ffbaf8e41318e00af8c77c50df57db154b70298a5999e12ba01758a27bc75b69b8fe38e2137bc70744c882347fdffad25d72140aad181192d152452f72c10'),
  ('demo-driver-02', '+261340000012', 'driver', 'Fanja Andriam', 'scrypt$32768$8$1$64726976656e696768742d64656d6f2d32303236$0c1ffbaf8e41318e00af8c77c50df57db154b70298a5999e12ba01758a27bc75b69b8fe38e2137bc70744c882347fdffad25d72140aad181192d152452f72c10'),
  ('demo-driver-03', '+261340000013', 'driver', 'Toky Rakoto', 'scrypt$32768$8$1$64726976656e696768742d64656d6f2d32303236$0c1ffbaf8e41318e00af8c77c50df57db154b70298a5999e12ba01758a27bc75b69b8fe38e2137bc70744c882347fdffad25d72140aad181192d152452f72c10'),
  ('demo-admin-01', '+261340000099', 'admin', 'Admin DriveNight', 'scrypt$32768$8$1$64726976656e696768742d64656d6f2d32303236$0c1ffbaf8e41318e00af8c77c50df57db154b70298a5999e12ba01758a27bc75b69b8fe38e2137bc70744c882347fdffad25d72140aad181192d152452f72c10')
ON CONFLICT (id) DO NOTHING;

INSERT INTO driver_profiles (
  user_id, validation_status, vehicle_category, vehicle_make, vehicle_model,
  vehicle_color, vehicle_registration, is_online
) VALUES
  ('demo-driver-01', 'approved', 'taxi', 'Renault', 'Kwid', 'Blanc', 'DEMO-001', 1),
  ('demo-driver-02', 'approved', 'moto', 'Honda', 'Wave', 'Noir', 'DEMO-002', 1),
  ('demo-driver-03', 'approved', 'voiture', 'Toyota', 'Vitz', 'Gris', 'DEMO-003', 0)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO driver_vehicles (
  id, user_id, category, vehicle_make, vehicle_model, vehicle_color,
  vehicle_registration
) VALUES
  ('demo-driver-01-vehicle', 'demo-driver-01', 'voiture', 'Renault', 'Kwid', 'Blanc', 'DEMO-001'),
  ('demo-driver-02-vehicle', 'demo-driver-02', 'moto', 'Honda', 'Wave', 'Noir', 'DEMO-002'),
  ('demo-driver-03-vehicle', 'demo-driver-03', 'voiture', 'Toyota', 'Vitz', 'Gris', 'DEMO-003')
ON CONFLICT (user_id) DO NOTHING;

UPDATE driver_profiles
SET vehicle_category = CASE vehicle_category WHEN 'taxi' THEN 'voiture' ELSE vehicle_category END,
  active_vehicle_id = (
    SELECT driver_vehicles.id
    FROM driver_vehicles
    WHERE driver_vehicles.user_id = driver_profiles.user_id
  )
WHERE active_vehicle_id IS NULL;

INSERT INTO rides (
  id, passenger_id, driver_id, origin_label, origin_latitude, origin_longitude,
  destination_label, destination_latitude, destination_longitude, category,
  proposed_price_mga, agreed_price_mga, status, requested_at, accepted_at,
  completed_at
) VALUES
  (
    'demo-ride-01', 'demo-passenger-01', 'demo-driver-01',
    'Analakely, Antananarivo', -18.9087, 47.5260,
    'Ivandry, Antananarivo', -18.8765, 47.5355, 'taxi',
    12000, 14000, 'completed', '2026-10-12 08:15:00',
    '2026-10-12 08:18:00', '2026-10-12 08:42:00'
  ),
  (
    'demo-ride-02', 'demo-passenger-02', NULL,
    'Anosy, Antananarivo', -18.9146, 47.5213,
    'Ambohitrarahaba, Antananarivo', -18.8429, 47.5332, 'moto',
    8000, NULL, 'searching', '2026-11-05 08:30:00',
    NULL, NULL
  ),
  (
    'demo-ride-03', 'demo-passenger-01', 'demo-driver-02',
    'Soarano, Antananarivo', -18.9050, 47.5235,
    'Ankadifotsy, Antananarivo', -18.8875, 47.5265, 'moto',
    5000, 5000, 'completed', '2026-10-18 17:05:00',
    '2026-10-18 17:07:00', '2026-10-18 17:24:00'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO ride_offers (id, ride_id, proposer_id, amount_mga, status, created_at)
VALUES (
  'demo-offer-02', 'demo-ride-02', 'demo-passenger-02',
  8000, 'pending', '2026-11-05 08:30:00'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO ratings (id, ride_id, rater_id, ratee_id, stars, comment, created_at)
VALUES (
  'demo-rating-01', 'demo-ride-01', 'demo-passenger-01', 'demo-driver-01',
  5, 'Trajet agréable.', '2026-10-12 08:45:00'
)
ON CONFLICT (id) DO NOTHING;

UPDATE users
SET average_rating = 5, rating_count = 1
WHERE id = 'demo-driver-01' AND rating_count = 0;

UPDATE users
SET average_rating = 5, rating_count = 1
WHERE id = 'demo-passenger-01' AND rating_count = 0;
