UPDATE driver_profiles
SET active_vehicle_id = (
  SELECT driver_vehicles.id
  FROM driver_vehicles
  WHERE driver_vehicles.user_id = driver_profiles.user_id
  ORDER BY
    CASE WHEN driver_vehicles.id = driver_profiles.active_vehicle_id THEN 0 ELSE 1 END,
    driver_vehicles.created_at,
    driver_vehicles.id
  LIMIT 1
)
WHERE active_vehicle_id IS NULL
  AND EXISTS (
    SELECT 1 FROM driver_vehicles
    WHERE driver_vehicles.user_id = driver_profiles.user_id
  );

UPDATE driver_profiles
SET vehicle_category = (
      SELECT category FROM driver_vehicles
      WHERE driver_vehicles.id = driver_profiles.active_vehicle_id
    ),
    vehicle_make = (
      SELECT vehicle_make FROM driver_vehicles
      WHERE driver_vehicles.id = driver_profiles.active_vehicle_id
    ),
    vehicle_model = (
      SELECT vehicle_model FROM driver_vehicles
      WHERE driver_vehicles.id = driver_profiles.active_vehicle_id
    ),
    vehicle_color = (
      SELECT vehicle_color FROM driver_vehicles
      WHERE driver_vehicles.id = driver_profiles.active_vehicle_id
    ),
    vehicle_registration = (
      SELECT vehicle_registration FROM driver_vehicles
      WHERE driver_vehicles.id = driver_profiles.active_vehicle_id
    )
WHERE active_vehicle_id IS NOT NULL;

DELETE FROM driver_vehicles
WHERE id NOT IN (
  SELECT active_vehicle_id FROM driver_profiles
  WHERE active_vehicle_id IS NOT NULL
);

CREATE UNIQUE INDEX driver_vehicles_one_per_driver
ON driver_vehicles (user_id);
