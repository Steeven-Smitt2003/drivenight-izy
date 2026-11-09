BEGIN;

REVOKE ALL PRIVILEGES ON TABLE
  public.public_profiles,
  public.public_driver_profiles
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE
  public.public_profiles,
  public.public_driver_profiles
TO authenticated;

COMMIT;
